
import dgram from 'dgram';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { OrchestratorEvent, InputDefinition, UdpInputConfig, TailInputConfig, TimerInputConfig, WebhookInputConfig } from './types';

export interface WebhookRoute {
  key: string;
  path: string;
  method: string;
  inputId: string;
  authToken?: string;
}

interface InputRuntime {
  stop: () => void;
  status: 'running' | 'stopped';
}

export class InputManager {
  private runtimes = new Map<string, InputRuntime>();
  private webhookRoutes = new Map<string, WebhookRoute>();
  private webhookPathsByInput = new Map<string, string[]>();

  constructor(private emit: (ev: OrchestratorEvent) => void) {}

  listWebhookRoutes() {
    return Array.from(this.webhookRoutes.values());
  }

  matchWebhook(path: string, method: string): WebhookRoute | undefined {
    const key = this.webhookKey(path, method);
    return this.webhookRoutes.get(key);
  }

  upsert(def: InputDefinition) {
    this.stop(def.id);
    this.registerWebhook(def);
    if (!def.enabled) return;
    const runtime = this.start(def);
    if (runtime) this.runtimes.set(def.id, runtime);
  }

  remove(id: string) {
    this.stop(id);
    this.clearWebhook(id);
  }

  emitFromInput(def: InputDefinition, payload: any, meta: Record<string, any> = {}) {
    const ev: OrchestratorEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      source: def.source || `input:${def.id}`,
      topic: def.topic || `inputs/${def.id}`,
      type: def.eventType || 'input',
      payload,
      meta: {
        ...(def.workflowId ? { workflowId: def.workflowId } : {}),
        inputId: def.id,
        inputType: def.type,
        ...meta
      }
    };
    this.emit(ev);
    return ev;
  }

  private start(def: InputDefinition): InputRuntime | undefined {
    if (def.type === 'udp') {
      return this.startUdp(def);
    }
    if (def.type === 'tail') {
      return this.startTail(def);
    }
    if (def.type === 'timer') {
      return this.startTimer(def);
    }
    return undefined; // webhook is handled in API
  }

  private startUdp(def: InputDefinition): InputRuntime {
    const cfg = def.config as UdpInputConfig;
    const socket = dgram.createSocket('udp4');

    const onMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      const codec = cfg.codec || 'utf8';
      let payload: any;
      if (codec === 'json') {
        const text = msg.toString('utf8');
        try {
          payload = JSON.parse(text);
        } catch (err: any) {
          payload = { raw: text, error: 'invalid_json' };
        }
      } else if (codec === 'raw') {
        payload = msg.toString('base64');
      } else {
        payload = msg.toString('utf8');
      }
      this.emitFromInput(def, payload, { remote: rinfo });
    };

    socket.on('message', onMessage);
    socket.bind(cfg.port, cfg.host);

    return {
      status: 'running',
      stop: () => {
        socket.removeListener('message', onMessage);
        socket.close();
      }
    };
  }

  private startTail(def: InputDefinition): InputRuntime {
    const cfg = def.config as TailInputConfig;
    const follower = new TailFollower(cfg, (payload, meta) => this.emitFromInput(def, payload, meta));
    follower.start();
    return {
      status: 'running',
      stop: () => follower.stop()
    };
  }

  private startTimer(def: InputDefinition): InputRuntime {
    const cfg = def.config as TimerInputConfig;
    const intervalMs = typeof cfg.intervalMs === 'number' && cfg.intervalMs > 0 ? cfg.intervalMs : 1000;
    let seq = 0;

    const emitTick = () => {
      const now = new Date();
      const payload = {
        ...(cfg.payload || {}),
        now: now.toISOString(),
        epochMs: now.getTime(),
        seq
      };
      seq += 1;
      this.emitFromInput(def, payload, { timer: true });
    };

    if (cfg.emitOnStart) emitTick();
    const timer = setInterval(emitTick, intervalMs);

    return {
      status: 'running',
      stop: () => {
        clearInterval(timer);
      }
    };
  }

  private registerWebhook(def: InputDefinition) {
    if (def.type !== 'webhook') return;
    const cfg = def.config as WebhookInputConfig;
    const method = (cfg.method || 'POST').toUpperCase();
    const path = normalizeWebhookPath(cfg.path || `/inputs/${def.id}/ingest`);
    const key = this.webhookKey(path, method);

    const current = this.webhookRoutes.get(key);
    if (current && current.inputId !== def.id) {
      throw new Error('webhook_path_conflict');
    }

    this.webhookRoutes.set(key, { key, path, method, inputId: def.id, authToken: cfg.authToken });
    const list = this.webhookPathsByInput.get(def.id) || [];
    if (!list.includes(key)) list.push(key);
    this.webhookPathsByInput.set(def.id, list);
  }

  private clearWebhook(inputId: string) {
    const list = this.webhookPathsByInput.get(inputId);
    if (!list) return;
    for (const key of list) this.webhookRoutes.delete(key);
    this.webhookPathsByInput.delete(inputId);
  }

  private stop(id: string) {
    const runtime = this.runtimes.get(id);
    if (runtime) runtime.stop();
    this.runtimes.delete(id);
  }

  private webhookKey(path: string, method: string) {
    return `${method.toUpperCase()} ${path}`;
  }
}

export function normalizeWebhookPath(path: string) {
  if (!path.startsWith('/')) return `/${path}`;
  return path;
}

class TailFollower {
  private timer?: NodeJS.Timeout;
  private position = 0;
  private remainder = '';
  private reading = false;
  private started = false;

  constructor(private cfg: TailInputConfig, private onLine: (payload: any, meta: Record<string, any>) => void) {}

  start() {
    if (this.started) return;
    this.started = true;
    this.initPosition().finally(() => {
      const interval = this.cfg.pollIntervalMs ?? 1000;
      this.timer = setInterval(() => this.tick(), interval);
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  private async initPosition() {
    try {
      const stat = await fs.promises.stat(this.cfg.path);
      if (this.cfg.from === 'end' || this.cfg.from === undefined) {
        this.position = stat.size;
      } else {
        this.position = 0;
      }
    } catch (_) {
      this.position = 0;
    }
  }

  private async tick() {
    if (this.reading) return;
    this.reading = true;
    try {
      const stat = await fs.promises.stat(this.cfg.path);
      if (stat.size < this.position) {
        this.position = stat.size;
      }
      if (stat.size === this.position) return;

      const length = stat.size - this.position;
      const fh = await fs.promises.open(this.cfg.path, 'r');
      try {
        const buffer = Buffer.alloc(length);
        await fh.read(buffer, 0, length, this.position);
        this.position = stat.size;
        this.processChunk(buffer.toString('utf8'));
      } finally {
        await fh.close();
      }
    } catch (_) {
      // ignore missing file
    } finally {
      this.reading = false;
    }
  }

  private processChunk(text: string) {
    const full = this.remainder + text;
    const lines = full.split(/\r?\n/);
    this.remainder = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      const payload = this.parseLine(line);
      this.onLine(payload, { path: this.cfg.path });
    }
  }

  private parseLine(line: string) {
    if (this.cfg.codec === 'json') {
      try {
        return JSON.parse(line);
      } catch (_) {
        return { raw: line, error: 'invalid_json' };
      }
    }
    return line;
  }
}

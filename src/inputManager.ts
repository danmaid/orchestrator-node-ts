
import dgram from 'dgram';
import fs from 'fs';
import path from 'path';
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
    if (cfg.dir) {
      const follower = new MultiTailFollower(cfg, (payload, meta) => this.emitFromInput(def, payload, meta));
      follower.start();
      return {
        status: 'running',
        stop: () => follower.stop()
      };
    }
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
  private timer: NodeJS.Timeout | null = null;
  private offset = 0;
  private inode: number | null = null;
  private buffer = '';
  private stopped = false;
  private looping = false;
  private idleBackoffMs: number;
  private watcher: fs.FSWatcher | null = null;
  private fd: fs.promises.FileHandle | null = null;

  private readonly intervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly startAtEnd: boolean;
  private readonly dir: string;
  private readonly base: string;

  constructor(private cfg: TailInputConfig, private onLine: (payload: any, meta: Record<string, any>) => void) {
    this.intervalMs = this.cfg.pollIntervalMs ?? 1000;
    this.maxBackoffMs = this.cfg.maxBackoffMs ?? Math.max(this.intervalMs * 4, 2000);
    this.startAtEnd = this.cfg.from === 'end' || this.cfg.from === undefined;
    this.idleBackoffMs = this.intervalMs;
    this.dir = path.dirname(this.cfg.path || '');
    this.base = path.basename(this.cfg.path || '');
  }

  start() {
    if (!this.stopped && this.timer) return;
    this.stopped = false;
    console.log(`[tail] start path=${this.cfg.path ?? '-'}`);
    this.openFile().finally(() => {
      if (this.cfg.watch !== false) this.startWatcher();
      this.loop();
    });
  }

  stop() {
    this.stopped = true;
    console.log(`[tail] stop path=${this.cfg.path ?? '-'}`);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopWatcher();
    this.closeFile();
  }

  private startWatcher() {
    try {
      this.watcher = fs.watch(this.dir, (_eventType, filename) => {
        if (filename && filename !== this.base) return;
        this.poke();
      });
      this.watcher.on('error', () => this.poke(true));
    } catch (_) {
      // ignore watcher failures
    }
  }

  private stopWatcher() {
    try {
      this.watcher?.close();
    } catch (_) {
      // ignore
    }
    this.watcher = null;
  }

  private poke(forceResync = false) {
    if (forceResync) {
      this.closeFile();
      this.openFile();
    }
    this.idleBackoffMs = this.intervalMs;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.loop();
  }

  private async openFile() {
    try {
      if (this.fd) await this.closeFile();
      if (!this.cfg.path) return;
      const stat = await fs.promises.stat(this.cfg.path);
      this.inode = stat.ino;
      this.fd = await fs.promises.open(this.cfg.path, 'r');
      this.offset = this.startAtEnd ? stat.size : 0;
      console.log(`[tail] opened file=${this.cfg.path} size=${stat.size} inode=${stat.ino}`);
    } catch (_) {
      // ignore missing file
    }
  }

  private async closeFile() {
    if (this.fd) {
      try {
        await this.fd.close();
      } catch (_) {
        // ignore
      }
      this.fd = null;
    }
  }

  private async loop() {
    if (this.stopped || this.looping) return;
    this.looping = true;
    let progressed = false;

    try {
      if (!this.cfg.path) return;
      const stat = await fs.promises.stat(this.cfg.path);

      if (this.inode != null && stat.ino !== this.inode) {
        await this.closeFile();
        this.inode = stat.ino;
        await this.openFile();
      }

      if (!this.fd) {
        // file not open yet
      } else if (stat.size < this.offset) {
        this.offset = 0;
        this.buffer = '';
      } else if (stat.size > this.offset) {
        const toRead = stat.size - this.offset;
        const chunk = Buffer.allocUnsafe(Math.min(toRead, 64 * 1024));
        let readTotal = 0;

        while (readTotal < toRead) {
          const len = Math.min(chunk.length, toRead - readTotal);
          const { bytesRead } = await this.fd.read(chunk, 0, len, this.offset + readTotal);
          if (bytesRead === 0) break;
          readTotal += bytesRead;
          this.onBytes(chunk.subarray(0, bytesRead));
        }

        this.offset += readTotal;
        progressed = readTotal > 0;
      }
    } catch (_) {
      console.warn(`[tail] poll error path=${this.cfg.path ?? '-'}`);
      await this.closeFile();
      await this.openFile();
    } finally {
      this.looping = false;
      if (!this.stopped) {
        this.idleBackoffMs = progressed ? this.intervalMs : Math.min(this.idleBackoffMs * 2, this.maxBackoffMs);
        this.timer = setTimeout(() => this.loop(), this.idleBackoffMs);
      }
    }
  }

  private onBytes(bytes: Buffer) {
    this.buffer += bytes.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
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

class MultiTailFollower {
  private readonly dir: string;
  private readonly patterns: RegExp[];
  private readonly ignore: RegExp[];
  private readonly scanIntervalMs: number;
  private readonly scanDebounceMs: number;
  private tailers = new Map<string, TailFollower>();
  private watcher: fs.FSWatcher | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private scanLoopTimer: NodeJS.Timeout | null = null;
  private scanning = false;
  private stopped = false;

  constructor(private cfg: TailInputConfig, private onLine: (payload: any, meta: Record<string, any>) => void) {
    this.dir = cfg.dir || '';
    this.patterns = buildRegexList(cfg.patterns, [
      '^(problems|history)-.*\\.ndjson$',
      '^problems-.*-(main-process|task-manager)-\\d+\\.ndjson$',
      '^history-.*-(main-process|task-manager)-\\d+\\.ndjson$'
    ]);
    this.ignore = buildRegexList(cfg.ignorePatterns, [/\.old$/]);
    this.scanIntervalMs = cfg.scanIntervalMs ?? Math.max(cfg.pollIntervalMs ?? 1000, 500);
    this.scanDebounceMs = cfg.scanDebounceMs ?? 150;
  }

  start() {
    if (this.stopped === false && (this.watcher || this.scanLoopTimer)) return;
    this.stopped = false;
    console.log(`[tail] multi start dir=${this.dir}`);
    this.scanNow();
    if (this.cfg.watch !== false) {
      this.startWatcher();
    } else {
      this.startScanLoop();
    }
  }

  stop() {
    this.stopped = true;
    console.log(`[tail] multi stop dir=${this.dir}`);
    this.stopWatcher();
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.scanLoopTimer) {
      clearInterval(this.scanLoopTimer);
      this.scanLoopTimer = null;
    }
    for (const [, t] of this.tailers) {
      try {
        t.stop();
      } catch (_) {
        // ignore
      }
    }
    this.tailers.clear();
  }

  private startWatcher() {
    try {
      this.watcher = fs.watch(this.dir, () => this.debouncedScan());
      this.watcher.on('error', () => this.debouncedScan());
    } catch (_) {
      // ignore watcher failures
      this.startScanLoop();
    }
  }

  private stopWatcher() {
    try {
      this.watcher?.close();
    } catch (_) {
      // ignore
    }
    this.watcher = null;
  }

  private startScanLoop() {
    if (this.scanLoopTimer) return;
    this.scanLoopTimer = setInterval(() => this.scanNow(), this.scanIntervalMs);
  }

  private debouncedScan() {
    if (this.stopped) return;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      if (!this.stopped) this.scanNow();
    }, this.scanDebounceMs);
  }

  private async scanNow() {
    if (this.stopped || this.scanning) return;
    this.scanning = true;
    try {
      const entries = await fs.promises.readdir(this.dir);
      const want = new Set(
        entries
          .filter((n) => this.patterns.length === 0 || this.patterns.some((p) => p.test(n)))
          .filter((n) => !this.ignore.some((p) => p.test(n)))
          .map((n) => path.join(this.dir, n))
      );

      if (want.size === 0) {
        console.log(`[tail] scan dir=${this.dir} matched=0`);
      }

      for (const abs of want) {
        if (this.stopped) break;
        if (this.tailers.has(abs)) continue;
        const fileCfg: TailInputConfig = { ...this.cfg, path: abs, dir: undefined };
        console.log(`[tail] attach file=${abs}`);
        const t = new TailFollower(fileCfg, (payload, meta) =>
          this.onLine(payload, { ...meta, dir: this.dir, file: path.basename(abs) })
        );
        this.tailers.set(abs, t);
        t.start();
      }

      for (const [abs, t] of this.tailers) {
        if (!want.has(abs)) {
          t.stop();
          this.tailers.delete(abs);
        }
      }
    } catch (_) {
      console.warn(`[tail] scan error dir=${this.dir}`);
      // ignore scan errors
    } finally {
      this.scanning = false;
    }
  }
}

function buildRegexList(values: string[] | undefined, fallback: Array<string | RegExp>): RegExp[] {
  const source = values && values.length > 0 ? values : fallback;
  const list: RegExp[] = [];
  for (const v of source) {
    try {
      list.push(v instanceof RegExp ? v : new RegExp(v));
    } catch (_) {
      // ignore invalid regex
    }
  }
  return list;
}

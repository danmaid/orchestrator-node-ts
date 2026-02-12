
import { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { RingBuffer } from './ringbuffer';
import { SSEHub } from './sse';
import { EventBus } from './eventBus';
import { InputDefinition, InputType, LogicDefinition, LogicType, OrchestratorEvent, WebhookLogicConfig, WorkflowDefinition } from './types';
import { WorkflowEngine } from './workflowEngine';
import { WebhookProvider } from './enrichment';
import { createDefaultEnrichmentService, getBuiltinLogicDefinitions, getRxjsLogicDefinitions } from './logics';
import { InputManager, normalizeWebhookPath } from './inputManager';

export function createApi(staticDir: string) {
  const sse = new SSEHub();

  const inputBuffer = new RingBuffer<OrchestratorEvent>(1000);
  const outputBuffer = new RingBuffer<OrchestratorEvent>(1000);

  const bus = new EventBus();
  const inputStore = new Map<string, InputDefinition>();
  const LOOPBACK_INPUT_ID = 'loopback';

  const loopbackInput: InputDefinition = {
    id: LOOPBACK_INPUT_ID,
    name: 'loopback',
    type: 'loopback',
    enabled: true,
    description: 'built-in loopback input',
    topic: 'input/loopback',
    source: 'input:loopback',
    config: {}
  };
  inputStore.set(LOOPBACK_INPUT_ID, loopbackInput);
  const inputManager = new InputManager((ev) => {
    inputBuffer.push(ev);
    bus.publishInput(ev);
    sse.publish('inputs', { kind: 'input', data: ev });
    sse.publish('events', { kind: 'input', data: ev });
  });

  const enrichment = createDefaultEnrichmentService();

  const logicStore = new Map<string, LogicDefinition>();

  function syncBuiltinLogics() {
    const providers = enrichment.listProviders();
    const builtinDefs = getBuiltinLogicDefinitions(providers);
    const rxjsDefs = getRxjsLogicDefinitions();
    const allDefs = [...builtinDefs, ...rxjsDefs];
    const builtinIds = new Set<string>(allDefs.map((d) => d.id));

    for (const def of allDefs) {
      logicStore.set(def.id, def);
    }

    for (const [id, def] of logicStore.entries()) {
      if (def.type === 'webhook') continue;
      if (!builtinIds.has(id)) logicStore.delete(id);
    }
  }

  syncBuiltinLogics();

  const engine = new WorkflowEngine(
    bus,
    (ev) => { // onOutput
      outputBuffer.push(ev);
      bus.publishOutput(ev);
      sse.publish('outputs', { kind: 'output', data: ev });
      sse.publish('events', { kind: 'output', data: ev });
    },
    (ev) => { // onLoopback (input only)
      inputBuffer.push(ev);
      bus.publishInput(ev);
      sse.publish('inputs', { kind: 'input', data: ev });
      sse.publish('events', { kind: 'input', data: ev });
    },
    (lc) => { sse.publish('workflows', lc); sse.publish('events', { kind: 'workflow', data: lc }); },
    enrichment
  );

  // Workflows CRUD
  const wfStore = new Map<string, WorkflowDefinition>();

  const BASE_PATH = '/v1/orchestrator';
  const MAX_BODY_BYTES = 2 * 1024 * 1024;

  function setCors(res: ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }

  function sendJson(res: ServerResponse, status: number, body: any) {
    const text = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(text);
  }

  function isSseRequest(req: IncomingMessage) {
    const accept = (req.headers['accept'] || '').toString();
    return accept.includes('text/event-stream') || req.headers['accept'] === undefined;
  }

  function sendStreamHelp(res: ServerResponse, path: string) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>SSE Stream</title></head>
<body style="font-family: system-ui; padding: 20px;">
  <h2>SSE Stream</h2>
  <p>${path} はイベントストリームです。ブラウザで直接開くと読み込みが終了しません。</p>
  <ul>
    <li><a href="/v1/orchestrator/">Main Demo</a></li>
    <li><a href="/v1/orchestrator/graph.html">Graph Demo</a></li>
  </ul>
  <p>ストリームを確認したい場合は、開発者ツールの Network タブで確認してください。</p>
</body></html>`);
  }

  function checkWebhookAuth(req: IncomingMessage, token?: string): boolean {
    if (!token) return true;
    const auth = (req.headers['authorization'] || '').toString();
    const headerToken = (req.headers['x-auth-token'] || '').toString();
    if (auth === token || auth === `Bearer ${token}`) return true;
    if (headerToken === token) return true;
    return false;
  }

  async function readJsonBody(req: IncomingMessage): Promise<any> {
    return await new Promise((resolve, reject) => {
      let data = '';
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('payload_too_large'));
          req.destroy();
          return;
        }
        data += chunk.toString('utf8');
      });
      req.on('end', () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          reject(new Error('invalid_json'));
        }
      });
      req.on('error', reject);
    });
  }

  async function readRawBody(req: IncomingMessage): Promise<{ raw: string; json?: any }> {
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('payload_too_large'));
          req.destroy();
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const ct = (req.headers['content-type'] || '').toString();
        if (ct.includes('application/json')) {
          try {
            return resolve({ raw, json: raw ? JSON.parse(raw) : {} });
          } catch (_) {
            return reject(new Error('invalid_json'));
          }
        }
        return resolve({ raw });
      });
      req.on('error', reject);
    });
  }

  const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.yaml': 'application/yaml; charset=utf-8',
    '.yml': 'application/yaml; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };

  function buildInputDefinition(body: any, idOverride?: string): InputDefinition {
    const type = body?.type as InputType | undefined;
    if (!type || !['webhook', 'udp', 'tail'].includes(type)) {
      throw new Error('invalid_input_type');
    }

    const id = idOverride || body?.id || randomUUID();
    const def: InputDefinition = {
      id,
      name: body?.name || `input-${id.slice(0, 8)}`,
      type,
      enabled: body?.enabled ?? true,
      description: body?.description,
      workflowId: body?.workflowId,
      topic: body?.topic,
      source: body?.source,
      eventType: body?.eventType,
      mode: body?.mode,
      config: body?.config || {}
    };

    if (def.type === 'udp') {
      if (!def.config || typeof (def.config as any).port !== 'number') throw new Error('udp_port_required');
    }
    if (def.type === 'tail') {
      if (!def.config || !(def.config as any).path) throw new Error('tail_path_required');
    }
    if (def.type === 'webhook') {
      const cfg = def.config as any;
      if (cfg?.path) cfg.path = normalizeWebhookPath(cfg.path);
      if (cfg?.method) cfg.method = String(cfg.method).toUpperCase();
    }
    return def;
  }

  function buildLogicDefinition(body: any, idOverride?: string): LogicDefinition {
    const type = (body?.type as LogicType | undefined) ?? 'webhook';
    if (!['builtin', 'embedded', 'webhook'].includes(type)) {
      throw new Error('invalid_logic_type');
    }
    const id = idOverride || body?.id || randomUUID();
    const def: LogicDefinition = {
      id,
      name: body?.name || `logic-${id.slice(0, 8)}`,
      type,
      enabled: body?.enabled ?? true,
      description: body?.description,
      config: body?.config || {}
    };
    if (def.type === 'webhook') {
      const cfg = def.config as WebhookLogicConfig;
      if (!cfg?.url) throw new Error('webhook_url_required');
      if (cfg.method) cfg.method = String(cfg.method).toUpperCase() as WebhookLogicConfig['method'];
    }
    return def;
  }

  function applyLogicDefinition(def: LogicDefinition) {
    if (def.type !== 'webhook') return;
    enrichment.unregister(def.id);
    if (!def.enabled) return;
    const cfg = def.config as WebhookLogicConfig;
    const provider = new WebhookProvider({
      id: def.id,
      url: cfg.url,
      method: cfg.method,
      headers: cfg.headers,
      timeoutMs: cfg.timeoutMs,
      ttlMs: cfg.ttlMs
    });
    enrichment.register(provider);
  }

  async function serveStatic(res: ServerResponse, relPath: string, method: string | undefined): Promise<boolean> {
    if (method !== 'GET' && method !== 'HEAD') return false;
    const reqPath = relPath === '/' || relPath === '' ? '/index.html' : relPath;
    const safePath = path.resolve(staticDir, `.${reqPath}`);
    if (!safePath.startsWith(path.resolve(staticDir))) return false;
    try {
      let stat = await fs.promises.stat(safePath);
      let filePath = safePath;
      if (stat.isDirectory()) {
        filePath = path.join(safePath, 'index.html');
        stat = await fs.promises.stat(filePath);
      }
      if (!stat.isFile()) return false;
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stat.size);
      if (method === 'HEAD') {
        res.end();
        return true;
      }
      fs.createReadStream(filePath).pipe(res);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    const host = req.headers.host || 'localhost';
    const url = new URL(req.url || '/', `http://${host}`);
    if (!url.pathname.startsWith(BASE_PATH)) {
      res.statusCode = 404;
      return res.end('Not Found');
    }

    const subPath = url.pathname.slice(BASE_PATH.length) || '/';
    const segments = subPath.split('/').filter(Boolean);
    const method = req.method || 'GET';

    const accept = (req.headers['accept'] || '').toString();
    const wantsHtml = (method === 'GET' || method === 'HEAD') && accept.includes('text/html');
    const isAsset = path.extname(subPath) !== '';
    if (wantsHtml && !isAsset) {
      const served = await serveStatic(res, '/', method);
      if (served) return;
    }

    const webhook = inputManager.matchWebhook(subPath, method);
    if (webhook) {
      const def = inputStore.get(webhook.inputId);
      if (!def || !def.enabled) {
        return sendJson(res, 404, { error: 'input_not_found' });
      }
      if (!checkWebhookAuth(req, webhook.authToken)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      try {
        const { raw, json } = await readRawBody(req);
        const payload = json !== undefined ? json : raw;
        const ev = inputManager.emitFromInput(def, payload, { webhookPath: webhook.path, method });
        return sendJson(res, 202, { accepted: true, id: ev.id });
      } catch (err: any) {
        if (err?.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload too large' });
        if (err?.message === 'invalid_json') return sendJson(res, 400, { error: 'invalid json' });
        return sendJson(res, 400, { error: 'invalid request' });
      }
    }

    // Health
    if (segments.length === 1 && segments[0] === 'health' && method === 'GET') {
      return sendJson(res, 200, { status: 'ok', now: new Date().toISOString() });
    }

    // Inputs (definitions)
    if (segments[0] === 'inputs') {
      if (segments.length === 2 && segments[1] === 'stream' && method === 'GET') {
        if (!isSseRequest(req)) return sendStreamHelp(res, '/v1/orchestrator/inputs/stream');
        sse.addClient('inputs', req, res);
        return;
      }
      if (segments.length === 1 && method === 'GET') {
        return sendJson(res, 200, { data: Array.from(inputStore.values()) });
      }
      if (segments.length === 1 && method === 'POST') {
        try {
          const body = await readJsonBody(req);
          if (body?.id === LOOPBACK_INPUT_ID || body?.type === 'loopback') {
            return sendJson(res, 400, { error: 'builtin_input_is_readonly' });
          }
          const def = buildInputDefinition(body);
          if (inputStore.has(def.id)) return sendJson(res, 409, { error: 'id_already_exists' });
          inputStore.set(def.id, def);
          inputManager.upsert(def);
          return sendJson(res, 201, def);
        } catch (err: any) {
          if (err?.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload too large' });
          if (err?.message === 'invalid_input_type') return sendJson(res, 400, { error: 'invalid_input_type' });
          if (err?.message === 'udp_port_required') return sendJson(res, 400, { error: 'udp_port_required' });
          if (err?.message === 'tail_path_required') return sendJson(res, 400, { error: 'tail_path_required' });
          if (err?.message === 'webhook_path_conflict') return sendJson(res, 409, { error: 'webhook_path_conflict' });
          return sendJson(res, 400, { error: 'invalid json' });
        }
      }
      if (segments.length === 2 && method === 'GET') {
        const def = inputStore.get(segments[1]);
        if (!def) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, def);
      }
      if (segments.length === 2 && method === 'PUT') {
        const id = segments[1];
        if (id === LOOPBACK_INPUT_ID) return sendJson(res, 400, { error: 'builtin_input_is_readonly' });
        if (!inputStore.has(id)) return sendJson(res, 404, { error: 'not found' });
        try {
          const body = await readJsonBody(req);
          if (body?.type === 'loopback') return sendJson(res, 400, { error: 'builtin_input_is_readonly' });
          const def = buildInputDefinition(body, id);
          inputStore.set(id, def);
          inputManager.upsert(def);
          return sendJson(res, 200, def);
        } catch (err: any) {
          if (err?.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload too large' });
          if (err?.message === 'invalid_input_type') return sendJson(res, 400, { error: 'invalid_input_type' });
          if (err?.message === 'udp_port_required') return sendJson(res, 400, { error: 'udp_port_required' });
          if (err?.message === 'tail_path_required') return sendJson(res, 400, { error: 'tail_path_required' });
          if (err?.message === 'webhook_path_conflict') return sendJson(res, 409, { error: 'webhook_path_conflict' });
          return sendJson(res, 400, { error: 'invalid json' });
        }
      }
      if (segments.length === 2 && method === 'PATCH') {
        const id = segments[1];
        if (id === LOOPBACK_INPUT_ID) return sendJson(res, 400, { error: 'builtin_input_is_readonly' });
        const old = inputStore.get(id);
        if (!old) return sendJson(res, 404, { error: 'not found' });
        try {
          const body = await readJsonBody(req);
          if (body?.type === 'loopback') return sendJson(res, 400, { error: 'builtin_input_is_readonly' });
          const merged = { ...old, ...body };
          const def = buildInputDefinition(merged, id);
          inputStore.set(id, def);
          inputManager.upsert(def);
          return sendJson(res, 200, def);
        } catch (err: any) {
          if (err?.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload too large' });
          if (err?.message === 'invalid_input_type') return sendJson(res, 400, { error: 'invalid_input_type' });
          if (err?.message === 'udp_port_required') return sendJson(res, 400, { error: 'udp_port_required' });
          if (err?.message === 'tail_path_required') return sendJson(res, 400, { error: 'tail_path_required' });
          if (err?.message === 'webhook_path_conflict') return sendJson(res, 409, { error: 'webhook_path_conflict' });
          return sendJson(res, 400, { error: 'invalid json' });
        }
      }
      if (segments.length === 2 && method === 'DELETE') {
        const id = segments[1];
        if (id === LOOPBACK_INPUT_ID) return sendJson(res, 400, { error: 'builtin_input_is_readonly' });
        if (!inputStore.has(id)) return sendJson(res, 404, { error: 'not found' });
        inputStore.delete(id);
        inputManager.remove(id);
        res.statusCode = 204;
        return res.end();
      }
      if (segments.length === 3 && method === 'POST' && segments[2] === 'enable') {
        const id = segments[1];
        if (id === LOOPBACK_INPUT_ID) return sendJson(res, 400, { error: 'builtin_input_is_readonly' });
        const def = inputStore.get(id);
        if (!def) return sendJson(res, 404, { error: 'not found' });
        def.enabled = true;
        inputStore.set(id, def);
        inputManager.upsert(def);
        return sendJson(res, 200, { id, enabled: true });
      }
      if (segments.length === 3 && method === 'POST' && segments[2] === 'disable') {
        const id = segments[1];
        if (id === LOOPBACK_INPUT_ID) return sendJson(res, 400, { error: 'builtin_input_is_readonly' });
        const def = inputStore.get(id);
        if (!def) return sendJson(res, 404, { error: 'not found' });
        def.enabled = false;
        inputStore.set(id, def);
        inputManager.upsert(def);
        return sendJson(res, 200, { id, enabled: false });
      }
    }

    // Input events (manual + buffer)
    if (segments[0] === 'input-events') {
      if (segments.length === 1 && method === 'GET') {
        const data = inputBuffer.toArray();
        return sendJson(res, 200, { size: data.length, maxSize: inputBuffer.maxSize(), data });
      }
      if (segments.length === 2 && segments[1] === 'stream' && method === 'GET') {
        if (!isSseRequest(req)) return sendStreamHelp(res, '/v1/orchestrator/input-events/stream');
        sse.addClient('inputs', req, res);
        return;
      }
      if (segments.length === 1 && method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const { source, topic, type, payload, meta } = body || {};
          if (!source || !topic) return sendJson(res, 400, { error: 'source and topic are required' });
          const ev: OrchestratorEvent = {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            source, topic, type, payload: payload ?? {}, meta: meta ?? {}
          };
          inputBuffer.push(ev);
          bus.publishInput(ev);
          sse.publish('inputs', { kind: 'input', data: ev });
          return sendJson(res, 202, { accepted: true, id: ev.id });
        } catch (err: any) {
          if (err?.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload too large' });
          return sendJson(res, 400, { error: 'invalid json' });
        }
      }
    }

    // Outputs
    if (segments[0] === 'outputs') {
      if (segments.length === 1 && method === 'GET') {
        const data = outputBuffer.toArray();
        return sendJson(res, 200, { size: data.length, maxSize: outputBuffer.maxSize(), data });
      }
      if (segments.length === 2 && segments[1] === 'stream' && method === 'GET') {
        if (!isSseRequest(req)) return sendStreamHelp(res, '/v1/orchestrator/outputs/stream');
        sse.addClient('outputs', req, res);
        return;
      }
    }

    // Events (consolidated stream)
    if (segments[0] === 'events') {
      if (segments.length === 2 && segments[1] === 'stream' && method === 'GET') {
        if (!isSseRequest(req)) return sendStreamHelp(res, '/v1/orchestrator/events/stream');
        sse.addClient('events', req, res);
        return;
      }
    }

    // Workflows
    if (segments[0] === 'workflows') {
      if (segments.length === 1 && method === 'GET') {
        return sendJson(res, 200, { data: Array.from(wfStore.values()) });
      }
      if (segments.length === 2 && segments[1] === 'stream' && method === 'GET') {
        if (!isSseRequest(req)) return sendStreamHelp(res, '/v1/orchestrator/workflows/stream');
        sse.addClient('workflows', req, res);
        return;
      }
      if (segments.length === 1 && method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const id = body.id || randomUUID();
          const wf: WorkflowDefinition = {
            id,
            name: body.name || `wf-${id.slice(0, 8)}`,
            enabled: body.enabled ?? true,
            description: body.description,
            sourceTopics: body.sourceTopics || [],
            steps: body.steps || [],
            outputTopic: body.outputTopic,
            loopbackToInput: body.loopbackToInput ?? false,
            outputs: Array.isArray(body.outputs) ? body.outputs : undefined,
          };
          wfStore.set(id, wf);
          engine.upsert(wf);
          return sendJson(res, 201, wf);
        } catch (err: any) {
          if (err?.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload too large' });
          return sendJson(res, 400, { error: 'invalid json' });
        }
      }
      if (segments.length === 2 && method === 'GET') {
        const wf = wfStore.get(segments[1]);
        if (!wf) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, wf);
      }
      if (segments.length === 2 && method === 'PUT') {
        const id = segments[1];
        if (!wfStore.has(id)) return sendJson(res, 404, { error: 'not found' });
        try {
          const body = await readJsonBody(req);
          const wf: WorkflowDefinition = {
            id,
            name: body.name,
            enabled: body.enabled,
            description: body.description,
            sourceTopics: body.sourceTopics || [],
            steps: body.steps || [],
            outputTopic: body.outputTopic,
            loopbackToInput: body.loopbackToInput ?? false,
            outputs: Array.isArray(body.outputs) ? body.outputs : undefined,
          };
          wfStore.set(id, wf);
          engine.upsert(wf);
          return sendJson(res, 200, wf);
        } catch (err: any) {
          if (err?.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload too large' });
          return sendJson(res, 400, { error: 'invalid json' });
        }
      }
      if (segments.length === 2 && method === 'PATCH') {
        const id = segments[1];
        const old = wfStore.get(id);
        if (!old) return sendJson(res, 404, { error: 'not found' });
        try {
          const body = await readJsonBody(req);
          const wf = { ...old, ...body } as WorkflowDefinition;
          wfStore.set(id, wf);
          engine.upsert(wf);
          return sendJson(res, 200, wf);
        } catch (err: any) {
          if (err?.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload too large' });
          return sendJson(res, 400, { error: 'invalid json' });
        }
      }
      if (segments.length === 2 && method === 'DELETE') {
        const id = segments[1];
        if (!wfStore.has(id)) return sendJson(res, 404, { error: 'not found' });
        wfStore.delete(id);
        engine.remove(id);
        res.statusCode = 204;
        return res.end();
      }
      if (segments.length === 3 && method === 'POST' && segments[2] === 'enable') {
        const id = segments[1];
        const wf = wfStore.get(id);
        if (!wf) return sendJson(res, 404, { error: 'not found' });
        wf.enabled = true;
        wfStore.set(id, wf);
        engine.enable(id, true);
        return sendJson(res, 200, { id, enabled: true });
      }
      if (segments.length === 3 && method === 'POST' && segments[2] === 'disable') {
        const id = segments[1];
        const wf = wfStore.get(id);
        if (!wf) return sendJson(res, 404, { error: 'not found' });
        wf.enabled = false;
        wfStore.set(id, wf);
        engine.enable(id, false);
        return sendJson(res, 200, { id, enabled: false });
      }
    }

    // Logics (unified enrichment + built-in)
    if (segments[0] === 'logics') {
      if (segments.length === 1 && method === 'GET') {
        syncBuiltinLogics();
        return sendJson(res, 200, { data: Array.from(logicStore.values()) });
      }
      if (segments.length === 1 && method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const def = buildLogicDefinition(body);
          if (def.type !== 'webhook') return sendJson(res, 400, { error: 'only_webhook_type_is_creatable' });
          if (def.id === 'loopback') return sendJson(res, 409, { error: 'builtin_logic_id_conflict' });
          if (enrichment.getProvider(def.id)) return sendJson(res, 409, { error: 'builtin_logic_id_conflict' });
          if (logicStore.has(def.id)) return sendJson(res, 409, { error: 'id_already_exists' });
          logicStore.set(def.id, def);
          applyLogicDefinition(def);
          return sendJson(res, 201, def);
        } catch (err: any) {
          if (err?.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload too large' });
          if (err?.message === 'invalid_logic_type') return sendJson(res, 400, { error: 'invalid_logic_type' });
          if (err?.message === 'webhook_url_required') return sendJson(res, 400, { error: 'webhook_url_required' });
          return sendJson(res, 400, { error: 'invalid json' });
        }
      }
      if (segments.length === 2 && method === 'GET') {
        syncBuiltinLogics();
        const def = logicStore.get(segments[1]);
        if (!def) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, def);
      }
      if (segments.length === 2 && method === 'PUT') {
        const id = segments[1];
        const old = logicStore.get(id);
        if (!old) return sendJson(res, 404, { error: 'not found' });
        if (old.type !== 'webhook') return sendJson(res, 400, { error: 'builtin_logic_is_readonly' });
        try {
          const body = await readJsonBody(req);
          const def = buildLogicDefinition(body, id);
          if (def.type !== 'webhook') return sendJson(res, 400, { error: 'only_webhook_type_is_updatable' });
          logicStore.set(id, def);
          applyLogicDefinition(def);
          return sendJson(res, 200, def);
        } catch (err: any) {
          if (err?.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload too large' });
          if (err?.message === 'invalid_logic_type') return sendJson(res, 400, { error: 'invalid_logic_type' });
          if (err?.message === 'webhook_url_required') return sendJson(res, 400, { error: 'webhook_url_required' });
          return sendJson(res, 400, { error: 'invalid json' });
        }
      }
      if (segments.length === 2 && method === 'PATCH') {
        const id = segments[1];
        const old = logicStore.get(id);
        if (!old) return sendJson(res, 404, { error: 'not found' });
        if (old.type !== 'webhook') return sendJson(res, 400, { error: 'builtin_logic_is_readonly' });
        try {
          const body = await readJsonBody(req);
          const merged = { ...old, ...body, config: { ...(old.config || {}), ...(body?.config || {}) } };
          const def = buildLogicDefinition(merged, id);
          if (def.type !== 'webhook') return sendJson(res, 400, { error: 'only_webhook_type_is_updatable' });
          logicStore.set(id, def);
          applyLogicDefinition(def);
          return sendJson(res, 200, def);
        } catch (err: any) {
          if (err?.message === 'payload_too_large') return sendJson(res, 413, { error: 'payload too large' });
          if (err?.message === 'invalid_logic_type') return sendJson(res, 400, { error: 'invalid_logic_type' });
          if (err?.message === 'webhook_url_required') return sendJson(res, 400, { error: 'webhook_url_required' });
          return sendJson(res, 400, { error: 'invalid json' });
        }
      }
      if (segments.length === 2 && method === 'DELETE') {
        const id = segments[1];
        const old = logicStore.get(id);
        if (!old) return sendJson(res, 404, { error: 'not found' });
        if (old.type !== 'webhook') return sendJson(res, 400, { error: 'builtin_logic_is_readonly' });
        logicStore.delete(id);
        enrichment.unregister(id);
        res.statusCode = 204;
        return res.end();
      }
    }

    // Enrichments
    if (segments[0] === 'enrichments') {
      if (segments.length === 1 && method === 'GET') {
        const data = enrichment.listProviders();
        return sendJson(res, 200, { data, cache: { size: enrichment.cacheSize() } });
      }
      if (segments.length === 2 && method === 'POST' && segments[1] === 'cache') {
        enrichment.clearCache();
        return sendJson(res, 200, { cleared: true });
      }
      if (segments.length === 3 && method === 'POST' && segments[2] === 'refresh') {
        const id = segments[1];
        const provider = enrichment.getProvider(id);
        if (!provider) return sendJson(res, 404, { error: 'not found' });
        if (!provider.refresh) return sendJson(res, 400, { error: 'refresh_not_supported' });
        await provider.refresh();
        return sendJson(res, 200, { id, refreshed: true });
      }
      if (segments.length === 4 && method === 'POST' && segments[2] === 'cache' && segments[3] === 'clear') {
        const id = segments[1];
        if (!enrichment.getProvider(id)) return sendJson(res, 404, { error: 'not found' });
        enrichment.clearCache(id);
        return sendJson(res, 200, { id, cleared: true });
      }
    }

    // Static files
    const served = await serveStatic(res, subPath, method);
    if (served) return;

    res.statusCode = 404;
    return res.end('Not Found');
  }

  return { handle, sse, bus, inputBuffer, outputBuffer, engine };
}

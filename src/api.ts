
import { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { RingBuffer } from './ringbuffer';
import { SSEHub } from './sse';
import { EventBus } from './eventBus';
import { OrchestratorEvent, WorkflowDefinition } from './types';
import { WorkflowEngine } from './workflowEngine';
import { createDefaultEnrichmentService } from './enrichment';

export function createApi(staticDir: string) {
  const sse = new SSEHub();

  const inputBuffer = new RingBuffer<OrchestratorEvent>(1000);
  const outputBuffer = new RingBuffer<OrchestratorEvent>(1000);

  const bus = new EventBus();

  const enrichment = createDefaultEnrichmentService();

  const engine = new WorkflowEngine(
    bus,
    (ev) => { // onOutput
      outputBuffer.push(ev);
      bus.publishOutput(ev);
      sse.publish('outputs', { kind: 'output', data: ev });
    },
    (ev) => { // onLoopback
      inputBuffer.push(ev);
      bus.publishInput(ev);
      sse.publish('inputs', { kind: 'input', data: ev });
    },
    (lc) => { sse.publish('workflows', lc); },
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

  const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.yaml': 'application/yaml; charset=utf-8',
    '.yml': 'application/yaml; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };

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

    // Health
    if (segments.length === 1 && segments[0] === 'health' && method === 'GET') {
      return sendJson(res, 200, { status: 'ok', now: new Date().toISOString() });
    }

    // Inputs
    if (segments[0] === 'inputs') {
      if (segments.length === 1 && method === 'GET') {
        const data = inputBuffer.toArray();
        return sendJson(res, 200, { size: data.length, maxSize: inputBuffer.maxSize(), data });
      }
      if (segments.length === 2 && segments[1] === 'stream' && method === 'GET') {
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
        sse.addClient('outputs', req, res);
        return;
      }
    }

    // Workflows
    if (segments[0] === 'workflows') {
      if (segments.length === 1 && method === 'GET') {
        return sendJson(res, 200, { data: Array.from(wfStore.values()) });
      }
      if (segments.length === 2 && segments[1] === 'stream' && method === 'GET') {
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

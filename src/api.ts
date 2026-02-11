
import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { RingBuffer } from './ringbuffer';
import { SSEHub } from './sse';
import { EventBus } from './eventBus';
import { OrchestratorEvent, WorkflowDefinition } from './types';
import { WorkflowEngine } from './workflowEngine';

export function createApi(staticDir: string) {
  const router = express.Router();
  const sse = new SSEHub();

  const inputBuffer = new RingBuffer<OrchestratorEvent>(1000);
  const outputBuffer = new RingBuffer<OrchestratorEvent>(1000);

  const bus = new EventBus();

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
    (lc) => { sse.publish('workflows', lc); }
  );

  // Health
  router.get('/health', (req, res) => res.json({ status: 'ok', now: new Date().toISOString() }));

  // Inputs
  router.get('/inputs', (req, res) => {
    const data = inputBuffer.toArray();
    res.json({ size: data.length, maxSize: inputBuffer.maxSize(), data });
  });

  router.get('/inputs/stream', (req, res) => {
    sse.addClient('inputs', req, res);
  });

  router.post('/inputs', (req: Request, res: Response) => {
    const { source, topic, type, payload, meta } = req.body || {};
    if (!source || !topic) return res.status(400).json({ error: 'source and topic are required' });
    const ev: OrchestratorEvent = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      source, topic, type, payload: payload ?? {}, meta: meta ?? {}
    };
    inputBuffer.push(ev);
    bus.publishInput(ev);
    sse.publish('inputs', { kind: 'input', data: ev });
    res.status(202).json({ accepted: true, id: ev.id });
  });

  // Outputs
  router.get('/outputs', (req, res) => {
    const data = outputBuffer.toArray();
    res.json({ size: data.length, maxSize: outputBuffer.maxSize(), data });
  });

  router.get('/outputs/stream', (req, res) => {
    sse.addClient('outputs', req, res);
  });

  // Workflows CRUD
  const wfStore = new Map<string, WorkflowDefinition>();

  router.get('/workflows', (req, res) => {
    res.json({ data: Array.from(wfStore.values()) });
  });

  router.get('/workflows/stream', (req, res) => {
    sse.addClient('workflows', req, res);
  });

  router.post('/workflows', (req, res) => {
    const body = req.body || {};
    const id = body.id || uuidv4();
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
    res.status(201).json(wf);
  });

  router.get('/workflows/:id', (req, res) => {
    const wf = wfStore.get(req.params.id);
    if (!wf) return res.status(404).json({ error: 'not found' });
    res.json(wf);
  });

  router.put('/workflows/:id', (req, res) => {
    const id = req.params.id;
    if (!wfStore.has(id)) return res.status(404).json({ error: 'not found' });
    const body = req.body || {};
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
    res.json(wf);
  });

  router.patch('/workflows/:id', (req, res) => {
    const id = req.params.id;
    const old = wfStore.get(id);
    if (!old) return res.status(404).json({ error: 'not found' });
    const wf = { ...old, ...req.body } as WorkflowDefinition;
    wfStore.set(id, wf);
    engine.upsert(wf);
    res.json(wf);
  });

  router.delete('/workflows/:id', (req, res) => {
    const id = req.params.id;
    if (!wfStore.has(id)) return res.status(404).json({ error: 'not found' });
    wfStore.delete(id);
    engine.remove(id);
    res.status(204).end();
  });

  router.post('/workflows/:id/enable', (req, res) => {
    const id = req.params.id;
    const wf = wfStore.get(id);
    if (!wf) return res.status(404).json({ error: 'not found' });
    wf.enabled = true;
    wfStore.set(id, wf);
    engine.enable(id, true);
    res.json({ id, enabled: true });
  });

  router.post('/workflows/:id/disable', (req, res) => {
    const id = req.params.id;
    const wf = wfStore.get(id);
    if (!wf) return res.status(404).json({ error: 'not found' });
    wf.enabled = false;
    wfStore.set(id, wf);
    engine.enable(id, false);
    res.json({ id, enabled: false });
  });

  // Mount static demo UI and OpenAPI under / (router root) so it sits at /v1/orchestrator/
  router.use('/', express.static(staticDir, { index: 'index.html' }));

  return { router, sse, bus, inputBuffer, outputBuffer, engine };
}

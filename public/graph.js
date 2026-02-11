
(() => {
  const origin = (location.origin && location.origin !== 'null') ? location.origin : 'http://localhost:3000';
  const apiBase = `${origin}/v1/orchestrator`;
  const svg = document.getElementById('graphSvg');

  const statInputs = document.getElementById('statInputs');
  const statOutputs = document.getElementById('statOutputs');
  const statWorkflows = document.getElementById('statWorkflows');
  const statLinks = document.getElementById('statLinks');
  const recentEvents = document.getElementById('recentEvents');
  const demoStatus = document.getElementById('demoStatus');
  const workflowDetail = document.getElementById('workflowDetail');

  const state = {
    nodes: new Map(),
    edges: new Map(),
    events: [],
    running: true,
    streamTimer: null,
    workflows: new Map()
  };

  const palette = {
    input: '#22c55e',
    workflow: '#38bdf8',
    step: '#facc15',
    output: '#f97316',
    edge: 'rgba(148,163,184,0.5)',
    text: '#e2e8f0',
    event: '#a855f7'
  };

  const layout = {
    width: 1200,
    height: 600,
    node: { w: 170, h: 54, r: 10 }
  };

  const sampleIds = {
    inputOrders: 'input-orders',
    inputSensors: 'input-sensors',
    inputLogs: 'input-logs',
    wfOrders: 'wf-orders',
    wfAggregate: 'wf-aggregate',
    wfLogs: 'wf-logs',
    outOrders: 'out-orders',
    outMetrics: 'out-metrics',
    outLogsArchive: 'out-logs-archive',
    outLogsAlerts: 'out-logs-alerts'
  };

  function recordEvent(ev, kind) {
    state.events.unshift({ ev, kind, at: new Date().toLocaleTimeString() });
    state.events = state.events.slice(0, 12);
    recentEvents.innerHTML = state.events
      .map(e => `<div class="event"><b>${e.kind}</b> ${e.at}<br>${escapeHtml(JSON.stringify(e.ev.payload || {}))}</div>`)
      .join('');
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  }

  function renderGraph() {
    if (!svg) return;
    svg.innerHTML = '';

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'arrow');
    marker.setAttribute('markerWidth', '10');
    marker.setAttribute('markerHeight', '10');
    marker.setAttribute('refX', '10');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');
    const markerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    markerPath.setAttribute('d', 'M0,0 L10,3 L0,6 Z');
    markerPath.setAttribute('fill', palette.edge);
    marker.appendChild(markerPath);
    defs.appendChild(marker);
    svg.appendChild(defs);

    const edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    edgeGroup.setAttribute('id', 'edges');
    svg.appendChild(edgeGroup);

    const nodeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    nodeGroup.setAttribute('id', 'nodes');
    svg.appendChild(nodeGroup);

    for (const edge of state.edges.values()) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('id', edge.id);
      path.setAttribute('d', edge.path);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', palette.edge);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('marker-end', 'url(#arrow)');
      edgeGroup.appendChild(path);
    }

    for (const node of state.nodes.values()) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('data-id', node.id);
      g.setAttribute('data-type', node.type);
      g.setAttribute('class', 'graph-node');

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', node.x);
      rect.setAttribute('y', node.y);
      rect.setAttribute('rx', layout.node.r);
      rect.setAttribute('ry', layout.node.r);
      rect.setAttribute('width', layout.node.w);
      rect.setAttribute('height', layout.node.h);
      rect.setAttribute('fill', node.type === 'input'
        ? palette.input
        : node.type === 'workflow'
        ? palette.workflow
        : node.type === 'step'
        ? palette.step
        : palette.output
      );
      rect.setAttribute('opacity', '0.95');
      g.appendChild(rect);

      const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      title.setAttribute('x', node.x + layout.node.w / 2);
      title.setAttribute('y', node.y + 22);
      title.setAttribute('fill', palette.text);
      title.setAttribute('font-size', '12');
      title.setAttribute('text-anchor', 'middle');
      title.textContent = node.label;
      g.appendChild(title);

      const count = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      count.setAttribute('x', node.x + layout.node.w / 2);
      count.setAttribute('y', node.y + 42);
      count.setAttribute('fill', palette.text);
      count.setAttribute('font-size', '11');
      count.setAttribute('text-anchor', 'middle');
      count.setAttribute('data-count', node.id);
      count.textContent = `count: ${node.count || 0}`;
      g.appendChild(count);

      nodeGroup.appendChild(g);
    }

    bindNodeClicks();
  }

  function updateStats() {
    const inputs = Array.from(state.nodes.values()).filter(n => n.type === 'input').length;
    const outputs = Array.from(state.nodes.values()).filter(n => n.type === 'output').length;
    const workflows = Array.from(state.nodes.values()).filter(n => n.type === 'workflow').length;
    statInputs.textContent = String(inputs);
    statOutputs.textContent = String(outputs);
    statWorkflows.textContent = String(workflows);
    statLinks.textContent = String(state.edges.size);
  }

  function connectSSE(path, handler){
    const es = new EventSource(apiBase + path);
    es.onmessage = (ev)=>{ try{ handler(JSON.parse(ev.data)); } catch {} };
    es.addEventListener('output', (ev)=>{ try{ handler(JSON.parse(ev.data)); } catch {} });
    es.addEventListener('input', (ev)=>{ try{ handler(JSON.parse(ev.data)); } catch {} });
    es.onerror = ()=>{/* keep open */};
    return es;
  }

  function bumpCount(nodeId) {
    const node = state.nodes.get(nodeId);
    if (!node) return;
    node.count = (node.count || 0) + 1;
    const countEl = svg.querySelector(`[data-count="${nodeId}"]`);
    if (countEl) countEl.textContent = `count: ${node.count}`;
  }

  function animateEdge(edgeId) {
    if (!state.running) return;
    const path = svg.querySelector(`#${edgeId}`);
    if (!path) return;

    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', '6');
    dot.setAttribute('fill', palette.event);
    svg.appendChild(dot);

    const length = path.getTotalLength();
    const start = performance.now();
    const duration = 1200;

    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const point = path.getPointAtLength(length * t);
      dot.setAttribute('cx', point.x);
      dot.setAttribute('cy', point.y);
      if (t < 1) return requestAnimationFrame(step);
      dot.remove();
    }
    requestAnimationFrame(step);
  }

  function handleInput(ev) {
    const inputId = ev.meta?.inputId || inferInputIdByTopic(ev.topic) || sampleIds.inputOrders;
    const wfId = ev.meta?.workflowId || inferWorkflowIdByTopic(ev.topic);
    if (inputId && wfId) {
      bumpCount(inputId);
      bumpCount(wfId);
      const edgeId = edgeKey(inputId, wfId);
      if (state.edges.has(edgeId)) animateEdge(edgeId);
      animateWorkflowPath(wfId, ev, 200);
    }
    recordEvent(ev, 'input');
  }

  function handleOutput(ev) {
    const wfId = ev.meta?.workflowId || inferWorkflowIdByTopic(ev.topic);
    const outId = inferOutputIdByTopic(ev.topic);
    if (wfId && outId) {
      bumpCount(wfId);
      bumpCount(outId);
      const edgeId = edgeKey(wfId, outId);
      if (state.edges.has(edgeId)) animateEdge(edgeId);
    }
    recordEvent(ev, 'output');
  }

  function handleWorkflowLifecycle(msg) {
    if (!msg) return;
    if (msg.kind === 'workflow-upserted' && msg.workflow) {
      state.workflows.set(msg.workflow.id, msg.workflow);
      recordEvent({ payload: { workflow: msg.workflow.id } }, 'workflow');
      buildFixedGraph();
      renderGraph();
      updateStats();
    }
  }

  function wireControls() {
    const toggle = document.getElementById('toggleAnim');
    const reset = document.getElementById('resetGraph');
    const fit = document.getElementById('fitGraph');
    const seedDemo = document.getElementById('seedDemo');
    const sendDummy = document.getElementById('sendDummy');
    const startStream = document.getElementById('startStream');
    const stopStream = document.getElementById('stopStream');

    toggle.onclick = () => {
      state.running = !state.running;
      toggle.textContent = state.running ? 'Pause' : 'Resume';
      if (state.running) requestAnimationFrame(draw);
    };

    reset.onclick = () => {
      state.nodes.forEach(n => n.count = 0);
      renderGraph();
      state.events = [];
      recentEvents.innerHTML = '';
      updateStats();
    };

    fit.onclick = () => renderGraph();

    if (seedDemo) {
      seedDemo.onclick = async () => {
        await seedDemoData();
      };
    }

    if (sendDummy) {
      sendDummy.onclick = async () => {
        await sendDummyEvents();
      };
    }

    if (startStream) {
      startStream.onclick = () => startEventStream();
    }

    if (stopStream) {
      stopStream.onclick = () => stopEventStream();
    }
  }

  async function seedDemoData() {
    setStatus('Seeding demo...');
    const workflow = {
      id: 'wf-graph-demo',
      name: 'wf-graph-demo',
      enabled: true,
      sourceTopics: ['graph/demo'],
      outputTopic: 'graph/out',
      steps: [
        { type: 'aggregateCount', windowMs: 1000, keyField: 'payload.deviceId', outputTopic: 'graph/out', eventType: 'count' }
      ]
    };

    const input = {
      id: 'input-graph-demo',
      name: 'input-graph-demo',
      type: 'webhook',
      enabled: true,
      workflowId: 'wf-graph-demo',
      topic: 'graph/demo',
      source: 'input:graph-demo',
      eventType: 'demo',
      config: { path: '/hooks/graph-demo', method: 'POST' }
    };

    try {
      const health = await fetchWithTimeout(apiBase + '/health', { method: 'GET' }, 3000);
      if (!health.ok) {
        setStatus(`Health check failed: ${health.status}`);
        return;
      }

      await upsertWorkflow({
        id: sampleIds.wfOrders,
        name: 'wf-orders',
        enabled: true,
        sourceTopics: ['orders/new'],
        outputTopic: 'orders/processed',
        steps: [
          { type: 'enrich', sourceId: 'prefectures', params: { code: 'payload.prefCode' }, targetField: 'payload.enriched.pref' },
          { type: 'tapLog', label: 'orders' }
        ]
      });

      await upsertWorkflow({
        id: sampleIds.wfAggregate,
        name: 'wf-aggregate',
        enabled: true,
        sourceTopics: ['sensors/udp'],
        outputTopic: 'metrics/udp',
        steps: [
          { type: 'aggregateCount', windowMs: 1000, keyField: 'payload.deviceId', outputTopic: 'metrics/udp', eventType: 'count' }
        ]
      });

      await upsertWorkflow({
        id: sampleIds.wfLogs,
        name: 'wf-logs',
        enabled: true,
        sourceTopics: ['logs/app'],
        outputTopic: 'logs/archive',
        steps: [
          { type: 'branch', branches: [
            { when: { field: 'payload.level', equals: 'error' }, set: { alert: true }, outputTopic: 'logs/alerts' }
          ] }
        ]
      });

      await upsertInput({
        id: sampleIds.inputOrders,
        name: 'input-orders',
        type: 'webhook',
        enabled: true,
        workflowId: sampleIds.wfOrders,
        topic: 'orders/new',
        source: 'input:orders',
        eventType: 'order',
        config: { path: '/hooks/orders', method: 'POST' }
      });

      await upsertInput({
        id: sampleIds.inputSensors,
        name: 'input-sensors',
        type: 'udp',
        enabled: true,
        workflowId: sampleIds.wfAggregate,
        topic: 'sensors/udp',
        source: 'input:sensors',
        eventType: 'sensor',
        config: { port: 40123, codec: 'json' }
      });

      await upsertInput({
        id: sampleIds.inputLogs,
        name: 'input-logs',
        type: 'tail',
        enabled: true,
        workflowId: sampleIds.wfLogs,
        topic: 'logs/app',
        source: 'input:logs',
        eventType: 'log',
        config: { path: '/tmp/app.log', from: 'end', codec: 'utf8', pollIntervalMs: 500 }
      });

      await initGraph();
      setStatus('Seeded successfully.');
    } catch (err) {
      console.error(err);
      const msg = err && err.name ? `${err.name}` : 'unknown_error';
      setStatus(`Seed failed: ${msg}`);
    }
  }

  async function sendDummyEvents() {
    setStatus('Sending dummy events...');
    const count = 20;
    try {
      for (let i = 0; i < count; i++) {
        const ev = {
          source: 'graph-demo',
          topic: i % 2 === 0 ? 'orders/new' : 'sensors/udp',
          type: i % 2 === 0 ? 'order' : 'sensor',
          payload: i % 2 === 0
            ? { orderId: `O-${1000 + i}`, prefCode: 13, userId: 1, amount: 3000 + i }
            : { deviceId: `dev-${(i % 3) + 1}`, value: Math.random() * 100 }
        };
        await fetchWithTimeout(apiBase + '/input-events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ev)
        }, 8000);
      }
      setStatus('Dummy events sent.');
    } catch (err) {
      console.error(err);
      const msg = err && err.name ? `${err.name}` : 'unknown_error';
      setStatus(`Send failed: ${msg}`);
    }
  }

  function startEventStream() {
    if (state.streamTimer) return;
    setStatus('Streaming events...');
    state.streamTimer = setInterval(async () => {
      const pick = Math.random();
      if (pick < 0.4) {
        await sendEvent({
          source: 'graph-demo',
          topic: 'orders/new',
          type: 'order',
          payload: { orderId: `O-${Math.floor(Math.random()*9000)}`, prefCode: 13, userId: 1, amount: Math.floor(Math.random()*9000) }
        });
      } else if (pick < 0.8) {
        await sendEvent({
          source: 'graph-demo',
          topic: 'sensors/udp',
          type: 'sensor',
          payload: { deviceId: `dev-${(Math.floor(Math.random()*3)+1)}`, value: Math.random()*100 }
        });
      } else {
        await sendEvent({
          source: 'graph-demo',
          topic: 'logs/app',
          type: 'log',
          payload: { level: Math.random() < 0.2 ? 'error' : 'info', message: 'demo log line' }
        });
      }
    }, 700);
  }

  function stopEventStream() {
    if (state.streamTimer) clearInterval(state.streamTimer);
    state.streamTimer = null;
    setStatus('Stream stopped.');
  }

  async function sendEvent(ev) {
    await fetchWithTimeout(apiBase + '/input-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev)
    }, 8000);
  }

  async function loadWorkflows() {
    try {
      const res = await fetchWithTimeout(apiBase + '/workflows', { method: 'GET' }, 8000);
      if (!res.ok) return;
      const data = await res.json();
      const list = data.data || [];
      for (const wf of list) {
        state.workflows.set(wf.id, wf);
      }
    } catch (_) {
      // ignore
    }
  }

  async function upsertWorkflow(def) {
    const res = await fetchWithTimeout(apiBase + `/workflows/${def.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(def)
    }, 15000);
    if (res.ok) return;
    if (res.status === 404) {
      const created = await fetchWithTimeout(apiBase + '/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(def)
      }, 15000);
      if (!created.ok) throw new Error(`workflow_${created.status}`);
      return;
    }
    throw new Error(`workflow_${res.status}`);
  }

  async function upsertInput(def) {
    const res = await fetchWithTimeout(apiBase + `/inputs/${def.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(def)
    }, 15000);
    if (res.ok) return;
    if (res.status === 404) {
      const created = await fetchWithTimeout(apiBase + '/inputs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(def)
      }, 15000);
      if (!created.ok) throw new Error(`input_${created.status}`);
      return;
    }
    throw new Error(`input_${res.status}`);
  }

  function buildFixedGraph() {
    state.nodes.clear();
    state.edges.clear();

    addNode(sampleIds.inputOrders, 'input', 'input: orders', 60, 90);
    addNode(sampleIds.inputSensors, 'input', 'input: sensors', 60, 250);
    addNode(sampleIds.inputLogs, 'input', 'input: logs', 60, 410);

    addNode(sampleIds.wfOrders, 'workflow', 'wf: orders', 420, 90);
    addNode(sampleIds.wfAggregate, 'workflow', 'wf: aggregate', 420, 250);
    addNode(sampleIds.wfLogs, 'workflow', 'wf: logs', 420, 410);

    addNode(sampleIds.outOrders, 'output', 'out: orders', 980, 60);
    addNode(sampleIds.outMetrics, 'output', 'out: metrics', 980, 210);
    addNode(sampleIds.outLogsAlerts, 'output', 'out: alerts', 980, 360);
    addNode(sampleIds.outLogsArchive, 'output', 'out: archive', 980, 510);

    addEdge(sampleIds.inputOrders, sampleIds.wfOrders);
    addEdge(sampleIds.inputSensors, sampleIds.wfAggregate);
    addEdge(sampleIds.inputLogs, sampleIds.wfLogs);

    buildWorkflowSteps(sampleIds.wfOrders, 90, sampleIds.outOrders);
    buildWorkflowSteps(sampleIds.wfAggregate, 250, sampleIds.outMetrics);
    buildWorkflowSteps(sampleIds.wfLogs, 410, sampleIds.outLogsArchive, sampleIds.outLogsAlerts);

    addEdge(sampleIds.wfOrders, firstStepId(sampleIds.wfOrders) || sampleIds.outOrders);
    addEdge(sampleIds.wfAggregate, firstStepId(sampleIds.wfAggregate) || sampleIds.outMetrics);
    addEdge(sampleIds.wfLogs, firstStepId(sampleIds.wfLogs) || sampleIds.outLogsArchive);
  }

  function addNode(id, type, label, x, y) {
    state.nodes.set(id, { id, type, label, x, y, count: 0 });
  }

  function addEdge(from, to) {
    const id = edgeKey(from, to);
    const fromNode = state.nodes.get(from);
    const toNode = state.nodes.get(to);
    if (!fromNode || !toNode) return;
    const startX = fromNode.x + layout.node.w;
    const startY = fromNode.y + layout.node.h / 2;
    const endX = toNode.x;
    const endY = toNode.y + layout.node.h / 2;
    const midX = (startX + endX) / 2;
    const path = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;
    state.edges.set(id, { id, from, to, path });
  }

  function buildWorkflowSteps(wfId, y, defaultOutId, branchOutId) {
    const wf = state.workflows.get(wfId);
    if (!wf || !Array.isArray(wf.steps) || wf.steps.length === 0) {
      addEdge(wfId, defaultOutId);
      if (branchOutId) addEdge(wfId, branchOutId);
      return;
    }
    const steps = wf.steps;
    const startX = 640;
    const gap = 170;
    let prevId = wfId;
    steps.forEach((step, index) => {
      const stepId = `${wfId}-step-${index}`;
      const label = step.type || `step-${index + 1}`;
      addNode(stepId, 'step', label, startX + gap * index, y);
      addEdge(prevId, stepId);
      prevId = stepId;

      if (step.type === 'branch') {
        if (step.branches) {
          for (const b of step.branches) {
            if (b.outputTopic) {
              const outId = inferOutputIdByTopic(b.outputTopic) || `${wfId}-out-${b.outputTopic}`;
              if (!state.nodes.has(outId)) {
                addNode(outId, 'output', `out: ${b.outputTopic}`, 980, y + 100);
              }
              addEdge(stepId, outId);
            }
          }
        }
        if (step.else && step.else.outputTopic) {
          const outId = inferOutputIdByTopic(step.else.outputTopic) || `${wfId}-out-${step.else.outputTopic}`;
          if (!state.nodes.has(outId)) {
            addNode(outId, 'output', `out: ${step.else.outputTopic}`, 980, y - 100);
          }
          addEdge(stepId, outId);
        }
      }
    });

    addEdge(prevId, defaultOutId);
    if (branchOutId) addEdge(prevId, branchOutId);
  }

  function firstStepId(wfId) {
    const wf = state.workflows.get(wfId);
    if (!wf || !Array.isArray(wf.steps) || wf.steps.length === 0) return null;
    return `${wfId}-step-0`;
  }

  function animateWorkflowPath(wfId, ev, delay) {
    const wf = state.workflows.get(wfId);
    const edges = [];
    const first = firstStepId(wfId);
    if (first) edges.push(edgeKey(wfId, first));

    if (wf && Array.isArray(wf.steps)) {
      for (let i = 0; i < wf.steps.length - 1; i++) {
        edges.push(edgeKey(`${wfId}-step-${i}`, `${wfId}-step-${i + 1}`));
      }
    }

    const targetOut = resolveOutputForEvent(wf, ev);
    if (targetOut) {
      const last = wf && wf.steps && wf.steps.length ? `${wfId}-step-${wf.steps.length - 1}` : wfId;
      edges.push(edgeKey(last, targetOut));
    }

    let t = 0;
    edges.forEach((edgeId) => {
      if (!state.edges.has(edgeId)) return;
      setTimeout(() => animateEdge(edgeId), t);
      t += delay;
    });
  }

  function resolveOutputForEvent(wf, ev) {
    if (!wf) return null;
    if (wf.id === sampleIds.wfOrders) return sampleIds.outOrders;
    if (wf.id === sampleIds.wfAggregate) return sampleIds.outMetrics;
    if (wf.id === sampleIds.wfLogs) {
      if (ev?.payload?.level === 'error') return sampleIds.outLogsAlerts;
      return sampleIds.outLogsArchive;
    }
    return inferOutputIdByTopic(wf.outputTopic);
  }

  function edgeKey(from, to) {
    return `edge-${from}-${to}`;
  }

  function inferWorkflowIdByTopic(topic) {
    if (topic === 'orders/new') return sampleIds.wfOrders;
    if (topic === 'sensors/udp') return sampleIds.wfAggregate;
    if (topic === 'logs/app') return sampleIds.wfLogs;
    return null;
  }

  function inferOutputIdByTopic(topic) {
    if (topic === 'orders/processed') return sampleIds.outOrders;
    if (topic === 'metrics/udp') return sampleIds.outMetrics;
    if (topic === 'logs/alerts') return sampleIds.outLogsAlerts;
    if (topic === 'logs/archive') return sampleIds.outLogsArchive;
    return null;
  }

  function inferInputIdByTopic(topic) {
    if (topic === 'orders/new') return sampleIds.inputOrders;
    if (topic === 'sensors/udp') return sampleIds.inputSensors;
    if (topic === 'logs/app') return sampleIds.inputLogs;
    return null;
  }

  function bindNodeClicks() {
    const nodes = svg.querySelectorAll('.graph-node');
    nodes.forEach((node) => {
      node.addEventListener('click', () => {
        const id = node.getAttribute('data-id');
        const type = node.getAttribute('data-type');
        if (type === 'workflow') {
          const wfId = id;
          const wf = state.workflows.get(wfId);
          renderWorkflowDetail(wf);
        } else {
          renderWorkflowDetail(null);
        }
      });
    });
  }

  function renderWorkflowDetail(wf) {
    if (!workflowDetail) return;
    if (!wf) {
      workflowDetail.innerHTML = '<div class="muted">ワークフローをクリックすると詳細が表示されます。</div>';
      return;
    }
    const steps = Array.isArray(wf.steps) ? wf.steps : [];
    workflowDetail.innerHTML = `
      <h4>${escapeHtml(wf.name || wf.id)}</h4>
      <div class="muted">id: ${escapeHtml(wf.id)}</div>
      <div class="muted">sourceTopics: ${(wf.sourceTopics || []).join(', ') || '-'}</div>
      <div class="muted">outputTopic: ${wf.outputTopic || '-'}</div>
      <div class="muted">steps: ${steps.length}</div>
      ${steps.map((s, i) => `
        <div class="step">
          <div><b>#${i + 1}</b> ${escapeHtml(s.type || 'step')}</div>
          <div><code>${escapeHtml(JSON.stringify(s))}</code></div>
        </div>
      `).join('')}
    `;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      setStatus('Request timeout or network error.');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function setStatus(text) {
    if (!demoStatus) return;
    demoStatus.textContent = text || '';
  }

  async function initGraph() {
    await loadWorkflows();
    buildFixedGraph();
    renderGraph();
    updateStats();
  }

  initGraph();
  wireControls();

  connectSSE('/events/stream', (msg)=>{
    if (!msg) return;
    if (msg.kind === 'input' && msg.data) return handleInput(msg.data);
    if (msg.kind === 'output' && msg.data) return handleOutput(msg.data);
    if (msg.kind === 'workflow' && msg.data) return handleWorkflowLifecycle(msg.data);
  });

  updateStats();
})();

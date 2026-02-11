
(function(){
  const apiBase = '/v1/orchestrator';

  // Helpers
  const qs = (sel, el=document) => el.querySelector(sel);
  const qsa = (sel, el=document) => Array.from(el.querySelectorAll(sel));
  const fmt = (o) => typeof o === 'string' ? o : JSON.stringify(o);
  const td = (text) => { const d = document.createElement('td'); d.textContent = text; return d; };

  // Inputs table & form
  const inputsTbody = qs('#inputsTable tbody');
  const inputDefsTbody = qs('#inputDefsTable tbody');
  const outputsTbody = qs('#outputsTable tbody');
  const wfTbody = qs('#wfTable tbody');
  const enrichTbody = qs('#enrichTable tbody');
  const enrichCacheSize = qs('#enrichCacheSize');

  async function refreshTables(){
    const [inputDefs, ins, outs, wfs] = await Promise.all([
      fetch(apiBase + '/inputs').then(r=>r.json()),
      fetch(apiBase + '/input-events').then(r=>r.json()),
      fetch(apiBase + '/outputs').then(r=>r.json()),
      fetch(apiBase + '/workflows').then(r=>r.json())
    ]);
    renderInputDefs(inputDefs.data);
    renderEvents(inputsTbody, ins.data);
    renderEvents(outputsTbody, outs.data);
    renderWfs(wfs.data);
  }

  async function refreshEnrichments(){
    try {
      const res = await fetch(apiBase + '/enrichments');
      const data = await res.json();
      renderEnrichments(data.data || []);
      if (enrichCacheSize) enrichCacheSize.textContent = String(data.cache?.size ?? '-');
    } catch (err) {
      // ignore
    }
  }

  function renderEvents(tbody, rows){
    tbody.innerHTML='';
    rows.forEach(ev => {
      const tr = document.createElement('tr');
      tr.append(td(ev.timestamp));
      tr.append(td(ev.source||''));
      tr.append(td(ev.topic||''));
      tr.append(td(ev.type||''));
      tr.append(td(JSON.stringify(ev.payload)));
      tbody.prepend(tr);
    });
  }

  function renderInputDefs(rows){
    if (!inputDefsTbody) return;
    inputDefsTbody.innerHTML='';
    rows.forEach(def => {
      const tr = document.createElement('tr');
      tr.append(td(def.id));
      tr.append(td(def.name));
      tr.append(td(def.type));
      tr.append(td(String(def.enabled)));
      tr.append(td(def.workflowId || ''));
      tr.append(td(def.topic || ''));
      tr.append(td(def.source || ''));
      const actions = document.createElement('td');
      const btnE = document.createElement('button');
      btnE.textContent = def.enabled ? 'Disable' : 'Enable';
      btnE.onclick = async ()=>{
        await fetch(apiBase + `/inputs/${def.id}/${def.enabled ? 'disable':'enable'}`, {method:'POST'});
        refreshTables();
      };
      const btnD = document.createElement('button');
      btnD.textContent = 'Delete';
      btnD.style.marginLeft = '6px';
      btnD.onclick = async ()=>{
        await fetch(apiBase + `/inputs/${def.id}`, {method:'DELETE'});
        refreshTables();
      };
      actions.append(btnE, btnD);
      tr.append(actions);
      inputDefsTbody.prepend(tr);
    });
  }

  function renderWfs(rows){
    wfTbody.innerHTML='';
    rows.forEach(wf => {
      const tr = document.createElement('tr');
      tr.append(td(wf.id));
      tr.append(td(wf.name));
      tr.append(td(String(wf.enabled)));
      tr.append(td((wf.sourceTopics||[]).join(',')));
      tr.append(td(wf.outputTopic||''));
      const actions = document.createElement('td');
      const btnE = document.createElement('button');
      btnE.textContent = wf.enabled ? 'Disable' : 'Enable';
      btnE.onclick = async ()=>{
        await fetch(apiBase + `/workflows/${wf.id}/${wf.enabled ? 'disable':'enable'}`, {method:'POST'});
        refreshTables();
      };
      const btnD = document.createElement('button');
      btnD.textContent = 'Delete';
      btnD.style.marginLeft = '6px';
      btnD.onclick = async ()=>{
        await fetch(apiBase + `/workflows/${wf.id}`, {method:'DELETE'});
        refreshTables();
      };
      actions.append(btnE, btnD);
      tr.append(actions);
      wfTbody.prepend(tr);
    });
  }

  function renderEnrichments(rows){
    if (!enrichTbody) return;
    enrichTbody.innerHTML='';
    rows.forEach(p => {
      const tr = document.createElement('tr');
      tr.append(td(p.id));
      tr.append(td(String(p.ttlMs ?? '-')));
      tr.append(td(String(p.refreshIntervalMs ?? '-')));
      tr.append(td(String(!!p.hasRefresh)));
      const actions = document.createElement('td');
      const btnR = document.createElement('button');
      btnR.textContent = 'Refresh';
      btnR.disabled = !p.hasRefresh;
      btnR.onclick = async ()=>{
        if (!p.hasRefresh) return;
        await fetch(apiBase + `/enrichments/${p.id}/refresh`, {method:'POST'});
        refreshEnrichments();
      };
      const btnC = document.createElement('button');
      btnC.textContent = 'Clear Cache';
      btnC.style.marginLeft = '6px';
      btnC.onclick = async ()=>{
        await fetch(apiBase + `/enrichments/${p.id}/cache/clear`, {method:'POST'});
        refreshEnrichments();
      };
      actions.append(btnR, btnC);
      tr.append(actions);
      enrichTbody.prepend(tr);
    });
  }

  qs('#inputForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const body = {
        source: fd.get('source'),
        topic: fd.get('topic'),
        type: fd.get('type'),
        payload: JSON.parse(fd.get('payload'))
      };
      await fetch(apiBase + '/input-events', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    } catch (err){ alert('payload は JSON として解釈できません'); }
  });

  qs('#inputDefForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const body = {
        name: fd.get('name'),
        type: fd.get('type'),
        enabled: !!fd.get('enabled'),
        workflowId: fd.get('workflowId') || undefined,
        topic: fd.get('topic') || undefined,
        source: fd.get('source') || undefined,
        eventType: fd.get('eventType') || undefined,
        config: JSON.parse(fd.get('config'))
      };
      await fetch(apiBase + '/inputs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      refreshTables();
    } catch (err){ alert('config は JSON として解釈できません'); }
  });

  qs('#wfForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const steps = JSON.parse(fd.get('steps'));
      const body = {
        name: fd.get('name'),
        enabled: !!fd.get('enabled'),
        sourceTopics: String(fd.get('sourceTopics')||'').split(',').filter(Boolean),
        outputTopic: fd.get('outputTopic')||undefined,
        loopbackToInput: !!fd.get('loopbackToInput'),
        steps
      };
      await fetch(apiBase + '/workflows', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      e.target.reset();
      refreshTables();
    } catch (err){ alert('steps は JSON 配列で入力してください'); }
  });

  const samples = {
    webhookInput: {
      name: 'webhook-orders',
      type: 'webhook',
      enabled: true,
      workflowId: 'wf-orders',
      topic: 'orders/new',
      source: 'input:webhook-orders',
      eventType: 'order',
      config: { path: '/hooks/orders', method: 'POST' }
    },
    udpInput: {
      name: 'udp-sensors',
      type: 'udp',
      enabled: true,
      workflowId: 'wf-aggregate',
      topic: 'sensors/udp',
      source: 'input:udp-sensors',
      eventType: 'sensor',
      config: { port: 40123, codec: 'json' }
    },
    tailInput: {
      name: 'tail-log',
      type: 'tail',
      enabled: true,
      topic: 'logs/app',
      source: 'input:tail-log',
      eventType: 'log',
      config: { path: '/tmp/app.log', from: 'end', codec: 'utf8', pollIntervalMs: 500 }
    },
    workflowAggregate: {
      name: 'wf-aggregate',
      enabled: true,
      sourceTopics: ['sensors/udp'],
      outputTopic: 'metrics/udp',
      steps: [
        { type: 'aggregateCount', windowMs: 1000, keyField: 'payload.deviceId', outputTopic: 'metrics/udp', eventType: 'count' }
      ]
    },
    workflowOrders: {
      name: 'wf-orders',
      enabled: true,
      sourceTopics: ['orders/new'],
      outputTopic: 'orders/processed',
      steps: [
        { type: 'enrich', sourceId: 'prefectures', params: { code: 'payload.prefCode' }, targetField: 'payload.enriched.pref' },
        { type: 'tapLog', label: 'orders' }
      ]
    },
    orderEvent: {
      source: 'demo-ui',
      topic: 'orders/new',
      type: 'order',
      payload: { orderId: 'O-1001', prefCode: 13, userId: 1, amount: 4200 }
    }
  };

  function fillInputDef(sample) {
    const form = qs('#inputDefForm');
    form.querySelector('[name="name"]').value = sample.name || '';
    form.querySelector('[name="type"]').value = sample.type || 'webhook';
    form.querySelector('[name="enabled"]').checked = !!sample.enabled;
    form.querySelector('[name="workflowId"]').value = sample.workflowId || '';
    form.querySelector('[name="topic"]').value = sample.topic || '';
    form.querySelector('[name="source"]').value = sample.source || '';
    form.querySelector('[name="eventType"]').value = sample.eventType || '';
    form.querySelector('[name="config"]').value = JSON.stringify(sample.config || {}, null, 2);
  }

  async function createSampleInput(sample){
    await fetch(apiBase + '/inputs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(sample) });
    refreshTables();
  }

  async function createSampleWorkflow(sample){
    await fetch(apiBase + '/workflows', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(sample) });
    refreshTables();
  }

  async function sendEvent(sample){
    await fetch(apiBase + '/input-events', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(sample) });
  }

  async function sendBurstEvents(){
    const count = 30;
    for (let i = 0; i < count; i++) {
      const ev = {
        source: 'demo-ui',
        topic: 'sensors/udp',
        type: 'sensor',
        payload: { deviceId: `dev-${(i % 3) + 1}`, value: Math.random() * 100 }
      };
      await fetch(apiBase + '/input-events', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(ev) });
    }
  }

  const sampleWebhookBtn = qs('#sampleWebhookBtn');
  if (sampleWebhookBtn) sampleWebhookBtn.onclick = ()=>fillInputDef(samples.webhookInput);
  const sampleUdpBtn = qs('#sampleUdpBtn');
  if (sampleUdpBtn) sampleUdpBtn.onclick = ()=>fillInputDef(samples.udpInput);
  const sampleTailBtn = qs('#sampleTailBtn');
  if (sampleTailBtn) sampleTailBtn.onclick = ()=>fillInputDef(samples.tailInput);

  const createWebhookSample = qs('#createWebhookSample');
  if (createWebhookSample) createWebhookSample.onclick = ()=>createSampleInput(samples.webhookInput);
  const createUdpSample = qs('#createUdpSample');
  if (createUdpSample) createUdpSample.onclick = ()=>createSampleInput(samples.udpInput);
  const createAggregateWf = qs('#createAggregateWf');
  if (createAggregateWf) createAggregateWf.onclick = ()=>createSampleWorkflow(samples.workflowAggregate);
  const createEnrichWf = qs('#createEnrichWf');
  if (createEnrichWf) createEnrichWf.onclick = ()=>createSampleWorkflow(samples.workflowOrders);
  const sendOrderEvent = qs('#sendOrderEvent');
  if (sendOrderEvent) sendOrderEvent.onclick = ()=>sendEvent(samples.orderEvent);
  const sendBurst = qs('#sendBurst');
  if (sendBurst) sendBurst.onclick = ()=>sendBurstEvents();

  const sampleInputWebhookEl = qs('#sampleInputWebhook');
  if (sampleInputWebhookEl) sampleInputWebhookEl.textContent = JSON.stringify(samples.webhookInput, null, 2);
  const sampleWfAggregateEl = qs('#sampleWfAggregate');
  if (sampleWfAggregateEl) sampleWfAggregateEl.textContent = JSON.stringify(samples.workflowAggregate, null, 2);

  function connectSSE(path, handler){
    const es = new EventSource(apiBase + path);
    es.onmessage = (ev)=>{ try{ handler(JSON.parse(ev.data)); } catch { /* ignore */ } };
    es.addEventListener('output', (ev)=>{ try{ handler(JSON.parse(ev.data)); } catch {} });
    es.addEventListener('input', (ev)=>{ try{ handler(JSON.parse(ev.data)); } catch {} });
    es.onerror = ()=>{/* keep open */};
    return es;
  }

  connectSSE('/inputs/stream', (msg)=>{
    if (msg && msg.data){ renderEvents(inputsTbody, [msg.data]); }
  });
  connectSSE('/outputs/stream', (msg)=>{
    if (msg && msg.data){ renderEvents(outputsTbody, [msg.data]); }
  });
  connectSSE('/workflows/stream', ()=>{ refreshTables(); });

  const reloadBtn = qs('#enrichReload');
  if (reloadBtn) reloadBtn.onclick = ()=>refreshEnrichments();
  const clearCacheBtn = qs('#enrichClearCache');
  if (clearCacheBtn) clearCacheBtn.onclick = async ()=>{
    await fetch(apiBase + '/enrichments/cache', {method:'POST'});
    refreshEnrichments();
  };

  refreshTables();
  refreshEnrichments();
})();

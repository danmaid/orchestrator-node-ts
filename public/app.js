
(function(){
  const apiBase = '/v1/orchestrator';
  const uiBase = '/v1/orchestrator';

  // Helpers
  const qs = (sel, el=document) => el.querySelector(sel);
  const qsa = (sel, el=document) => Array.from(el.querySelectorAll(sel));
  const fmt = (o) => typeof o === 'string' ? o : JSON.stringify(o);
  const td = (text) => { const d = document.createElement('td'); d.textContent = text; return d; };

  const routePanels = Array.from(document.querySelectorAll('[data-route]'));
  const detailOnlyElems = Array.from(document.querySelectorAll('[data-detail-only]'));
  const panelRowBottom = document.querySelector('.panel-row-bottom');
  const routeLinks = Array.from(document.querySelectorAll('[data-route-link]'));

  function getRouteFromPath(pathname){
    if (!pathname.startsWith(uiBase)) return 'external';
    const rel = pathname.slice(uiBase.length) || '/';
    const seg = rel.split('/').filter(Boolean)[0] || '';
    if (!seg) return 'overview';
    const route = seg.toLowerCase();
    if (route === 'enrichments') return 'logics';
    if (['inputs','outputs','workflows','logics'].includes(route)) return route;
    return 'overview';
  }

  function setActiveLinks(route){
    const hash = location.hash;
    routeLinks.forEach((link)=>{
      const key = link.getAttribute('data-route-link') || '';
      const isSample = key === 'samples' && route === 'workflows' && hash === '#samples';
      const isActive = isSample || (route === 'overview'
        ? key === 'overview'
        : key === route);
      link.classList.toggle('is-active', isActive);
    });
  }

  function applyRoute(route){
    const isOverview = route === 'overview';
    document.body.dataset.view = isOverview ? 'full' : 'single';
    document.body.dataset.route = route;
    routePanels.forEach((panel)=>{
      const panelRoute = panel.getAttribute('data-route');
      const shouldShow = isOverview || panelRoute === route;
      panel.classList.toggle('is-hidden', !shouldShow);
    });
    detailOnlyElems.forEach((el)=>{
      el.classList.toggle('is-hidden', isOverview);
    });
    if (panelRowBottom) {
      const showBottom = isOverview || route === 'logics';
      panelRowBottom.classList.toggle('is-hidden', !showBottom);
    }
    setActiveLinks(route);
    const main = document.querySelector('main');
    if (main && !isOverview) main.scrollTop = 0;
  }

  function navigateTo(url, replace){
    const route = getRouteFromPath(url.pathname);
    if (route === 'external') return false;
    const target = url.pathname + url.search + url.hash;
    if (replace) history.replaceState({}, '', target);
    else history.pushState({}, '', target);
    applyRoute(route);
    if (url.hash) {
      const el = document.querySelector(url.hash);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return true;
  }

  document.addEventListener('click', (ev)=>{
    const link = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!link) return;
    if (link.target && link.target !== '_self') return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin) return;
    const handled = navigateTo(url, false);
    if (handled) ev.preventDefault();
  });

  window.addEventListener('popstate', ()=>{
    applyRoute(getRouteFromPath(location.pathname));
  });

  // Inputs table & form
  const inputsTbody = qs('#inputsTable tbody');
  const inputDefsTbody = qs('#inputDefsTable tbody');
  const outputsTbody = qs('#outputsTable tbody');
  const wfTbody = qs('#wfTable tbody');
  const wfDetail = qs('#wfDetail');
  const enrichTbody = qs('#enrichTable tbody');
  const enrichCacheSize = qs('#enrichCacheSize');
  const logicTbody = qs('#logicTable tbody');
  const logicDetail = qs('#logicDetail');
  let selectedLogicId = null;

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
    refreshLogics();
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

  async function refreshLogics(){
    if (!logicTbody) return;
    try {
      const res = await fetch(apiBase + '/logics');
      const data = await res.json();
      renderLogics(data.data || []);
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
      if (def.type === 'loopback') {
        const span = document.createElement('span');
        span.className = 'muted';
        span.textContent = 'read-only';
        actions.append(span);
      } else {
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
      }
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
      tr.style.cursor = 'pointer';
      tr.onclick = (ev)=>{
        if (ev.target && ev.target.tagName === 'BUTTON') return;
        renderWorkflowDetail(wf);
      };
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

  function renderWorkflowDetail(wf){
    if (!wfDetail) return;
    if (!wf) {
      wfDetail.innerHTML = '<div class="muted">ワークフローをクリックすると詳細が表示されます。</div>';
      return;
    }
    const steps = Array.isArray(wf.steps) ? wf.steps : [];
    const outputs = Array.isArray(wf.outputs) && wf.outputs.length > 0
      ? wf.outputs
      : [{ type: 'topic', topic: wf.outputTopic }];
    wfDetail.innerHTML = `
      <h4>${escapeHtml(wf.name || wf.id)}</h4>
      <div class="muted">id: ${escapeHtml(wf.id)}</div>
      <div class="muted">enabled: ${escapeHtml(String(!!wf.enabled))}</div>
      <div class="muted">sourceTopics: ${escapeHtml((wf.sourceTopics || []).join(', ') || '-')}</div>
      <div class="muted">outputs: ${escapeHtml(outputs.length ? outputs.map(o => `${o.type}${o.topic ? `(${o.topic})` : ''}`).join(', ') : '-')}</div>
      <div class="muted">steps: ${escapeHtml(String(steps.length))}</div>
      ${steps.map((s, i) => `
        <div class="step">
          <div><b>#${i + 1}</b> ${escapeHtml(s.type || 'step')}</div>
          <div><code>${escapeHtml(JSON.stringify(s))}</code></div>
        </div>
      `).join('')}
    `;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
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

  function renderLogics(rows){
    if (!logicTbody) return;
    logicTbody.innerHTML='';
    rows.forEach(def => {
      const tr = document.createElement('tr');
      tr.append(td(def.id));
      tr.append(td(def.name));
      tr.append(td(def.type));
      tr.append(td(String(!!def.enabled)));
      tr.append(td(JSON.stringify(def.config || {})));
      const actions = document.createElement('td');

      if (def.type === 'webhook') {
        const btnE = document.createElement('button');
        btnE.textContent = def.enabled ? 'Disable' : 'Enable';
        btnE.onclick = async ()=>{
          await fetch(apiBase + `/logics/${def.id}`, {
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ enabled: !def.enabled })
          });
          refreshLogics();
        };
        const btnD = document.createElement('button');
        btnD.textContent = 'Delete';
        btnD.style.marginLeft = '6px';
        btnD.onclick = async ()=>{
          await fetch(apiBase + `/logics/${def.id}`, {method:'DELETE'});
          refreshLogics();
        };
        actions.append(btnE, btnD);
      } else {
        const span = document.createElement('span');
        span.className = 'muted';
        span.textContent = 'read-only';
        actions.append(span);
      }

      tr.append(actions);
      tr.style.cursor = 'pointer';
      tr.onclick = (ev)=>{
        if (ev.target && ev.target.tagName === 'BUTTON') return;
        selectedLogicId = def.id;
        renderLogicDetail(def);
      };
      logicTbody.prepend(tr);
    });

    if (selectedLogicId) {
      const selected = rows.find(r => r.id === selectedLogicId);
      if (selected) renderLogicDetail(selected);
    }
  }

  function renderLogicDetail(def){
    if (!logicDetail) return;
    if (!def) {
      logicDetail.innerHTML = '<div class="muted">ロジックの行をクリックすると詳細を表示します。</div>';
      return;
    }
    logicDetail.innerHTML = `
      <h4>${escapeHtml(def.name || def.id)}</h4>
      <div class="muted">id: ${escapeHtml(def.id)}</div>
      <div class="muted">type: ${escapeHtml(def.type || '-')}, enabled: ${escapeHtml(String(!!def.enabled))}</div>
      <div class="muted">description: ${escapeHtml(def.description || '-')}</div>
      <div class="step"><div><b>config</b></div><div><code>${escapeHtml(JSON.stringify(def.config || {}, null, 2))}</code></div></div>
    `;
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
      const outputsRaw = String(fd.get('outputs') || '').trim();
      const outputs = outputsRaw ? JSON.parse(outputsRaw) : undefined;
      const body = {
        name: fd.get('name'),
        enabled: !!fd.get('enabled'),
        sourceTopics: String(fd.get('sourceTopics')||'').split(',').filter(Boolean),
        outputTopic: fd.get('outputTopic')||undefined,
        outputs,
        steps
      };
      await fetch(apiBase + '/workflows', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      e.target.reset();
      refreshTables();
    } catch (err){ alert('steps / outputs は JSON 配列で入力してください'); }
  });

  const logicForm = qs('#logicForm');
  if (logicForm) logicForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const body = {
        name: fd.get('name'),
        type: fd.get('type'),
        enabled: !!fd.get('enabled'),
        config: JSON.parse(fd.get('config'))
      };
      await fetch(apiBase + '/logics', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      refreshLogics();
    } catch (err){ alert('config は JSON として解釈できません'); }
  });

  const samples = {
    logicWebhook: {
      name: 'logic-webhook-demo',
      type: 'webhook',
      enabled: true,
      config: {
        url: 'https://example.com/webhook',
        method: 'POST',
        headers: { Authorization: 'Bearer YOUR_TOKEN' },
        timeoutMs: 4000,
        ttlMs: 60000
      }
    },
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
        { type: 'logic', logicId: 'prefectures', params: { code: 'payload.prefCode' }, targetField: 'payload.enriched.pref' },
        { type: 'logic', logicId: 'loopback', params: {} },
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

  function fillLogicDef(sample) {
    const form = qs('#logicForm');
    if (!form) return;
    form.querySelector('[name="name"]').value = sample.name || '';
    form.querySelector('[name="type"]').value = sample.type || 'webhook';
    form.querySelector('[name="enabled"]').checked = !!sample.enabled;
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
  const sampleLogicBtn = qs('#sampleLogicBtn');
  if (sampleLogicBtn) sampleLogicBtn.onclick = ()=>fillLogicDef(samples.logicWebhook);

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

  function initDashboardResizers(){
    const dashboard = qs('.dashboard');
    if (!dashboard) return;

    const col1Resizer = qs('.resizer-col-1');
    const col2Resizer = qs('.resizer-col-2');
    const rowResizer = qs('.resizer-row');
    const bottomResizer = qs('.resizer-bottom');
    if (!col1Resizer || !col2Resizer || !rowResizer || !bottomResizer) return;

    const minCol = 200;
    const minCenter = 320;
    const minRow = 220;
    const minBottom = 180;

    const toPx = (value, total, fallbackPct) => {
      if (!value) return total * fallbackPct;
      const v = String(value).trim();
      if (v.endsWith('%')) return total * (parseFloat(v) / 100);
      if (v.endsWith('px')) return parseFloat(v);
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : total * fallbackPct;
    };

    const setVar = (name, px) => dashboard.style.setProperty(name, `${px}px`);

    const startDrag = (mode, ev) => {
      ev.preventDefault();
      const rect = dashboard.getBoundingClientRect();
      const sidebarWidth = qs('.sidebar')?.getBoundingClientRect().width || 0;
      const col1 = toPx(getComputedStyle(dashboard).getPropertyValue('--col1'), rect.width, 0.22);
      const col3 = toPx(getComputedStyle(dashboard).getPropertyValue('--col3'), rect.width, 0.25);
      const row1 = toPx(getComputedStyle(dashboard).getPropertyValue('--row1'), rect.height, 0.666667);

      const onMove = (moveEv) => {
        if (mode === 'col1') {
          const next = moveEv.clientX - rect.left - sidebarWidth;
          const max = rect.width - sidebarWidth - minCenter - col3;
          setVar('--col1', Math.max(minCol, Math.min(next, max)));
        } else if (mode === 'col3') {
          const next = rect.right - moveEv.clientX;
          const max = rect.width - sidebarWidth - minCenter - col1;
          setVar('--col3', Math.max(minCol, Math.min(next, max)));
        } else if (mode === 'row1') {
          const next = moveEv.clientY - rect.top;
          const max = rect.height - minBottom;
          setVar('--row1', Math.max(minRow, Math.min(next, max)));
        }
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    if (!dashboard.style.getPropertyValue('--row1')) {
      dashboard.style.setProperty('--row1', '66.6667%');
    }
    if (!dashboard.style.getPropertyValue('--col3')) {
      dashboard.style.setProperty('--col3', '25%');
    }

    col1Resizer.addEventListener('pointerdown', (ev)=>startDrag('col1', ev));
    col2Resizer.addEventListener('pointerdown', (ev)=>startDrag('col3', ev));
    rowResizer.addEventListener('pointerdown', (ev)=>startDrag('row1', ev));

    const startBottomDrag = (ev) => {
      ev.preventDefault();
      const rowRect = bottomResizer.parentElement.getBoundingClientRect();
      const minBottomCol = 240;
      const onMove = (moveEv) => {
        const next = moveEv.clientX - rowRect.left;
        const max = rowRect.width - minBottomCol;
        const clamped = Math.max(minBottomCol, Math.min(next, max));
        bottomResizer.parentElement.style.setProperty('--bottomCol1', `${clamped}px`);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    bottomResizer.addEventListener('pointerdown', startBottomDrag);
  }

  applyRoute(getRouteFromPath(location.pathname));
  if (location.hash) {
    const el = document.querySelector(location.hash);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  refreshTables();
  refreshEnrichments();
  refreshLogics();
  initDashboardResizers();
})();

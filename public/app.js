
(function(){
  const apiBase = '/v1/orchestrator';

  // Helpers
  const qs = (sel, el=document) => el.querySelector(sel);
  const qsa = (sel, el=document) => Array.from(el.querySelectorAll(sel));
  const fmt = (o) => typeof o === 'string' ? o : JSON.stringify(o);
  const td = (text) => { const d = document.createElement('td'); d.textContent = text; return d; };

  // Inputs table & form
  const inputsTbody = qs('#inputsTable tbody');
  const outputsTbody = qs('#outputsTable tbody');
  const wfTbody = qs('#wfTable tbody');
  const enrichTbody = qs('#enrichTable tbody');
  const enrichCacheSize = qs('#enrichCacheSize');

  async function refreshTables(){
    const [ins, outs, wfs] = await Promise.all([
      fetch(apiBase + '/inputs').then(r=>r.json()),
      fetch(apiBase + '/outputs').then(r=>r.json()),
      fetch(apiBase + '/workflows').then(r=>r.json())
    ]);
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
      await fetch(apiBase + '/inputs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    } catch (err){ alert('payload は JSON として解釈できません'); }
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

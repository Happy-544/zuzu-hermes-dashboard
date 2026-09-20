/* JARVIS Live HUD — drives Hermes Agent, streams telemetry.

   The brain is your own `hermes` CLI/profile, so configured Hermes tools,
   browser automation, skills, memory, MCP servers and third-party connectors are live. */
const $ = s => document.querySelector(s);
const RT = {tts:false, stt:false, live:false, liveModel:'', browserStt:false, browserTts:false};
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechSynth = window.speechSynthesis;
const API_TOKEN = document.querySelector('meta[name="jarvis-token"]')?.content || '';
const apiHeaders = extra => ({'x-jarvis-token': API_TOKEN, ...(extra || {})});

// ── reactor ticks ──
(() => {
  const g = $('#ticks480');
  for (let i = 0; i < 128; i++){
    const a = (i/128) * Math.PI*2, maj = i % 8 === 0;
    const r0 = maj ? 246 : 250, r1 = 260;
    const l = document.createElementNS('http://www.w3.org/2000/svg','line');
    l.setAttribute('x1', 260+Math.cos(a)*r0); l.setAttribute('y1', 260+Math.sin(a)*r0);
    l.setAttribute('x2', 260+Math.cos(a)*r1); l.setAttribute('y2', 260+Math.sin(a)*r1);
    if (maj) l.setAttribute('class','maj');
    g.appendChild(l);
  }
})();

const now = () => new Date().toLocaleTimeString('en-GB', {hour12:false});
const rid = () => 'run_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,'').slice(0,24)
                                              : Math.random().toString(16).slice(2,14));
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// ── workspace navigation ──
const VIEW_NAMES = new Set(['chat','projects','models','tools','memory','studio','missions','activity','settings']);
function showView(name, remember = true){
  if (!VIEW_NAMES.has(name)) name = 'chat';
  document.querySelectorAll('[data-view-panel]').forEach(panel => {
    const active = panel.dataset.viewPanel === name;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  document.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  if (remember) localStorage.setItem('jarvis-view', name);
  window.scrollTo({top:0, behavior:'auto'});
}
document.querySelectorAll('[data-view]').forEach(button => {
  button.addEventListener('click', () => showView(button.dataset.view));
});
showView(localStorage.getItem('jarvis-view') || 'chat', false);

// ── projects, settings, skills, memory and files ──
let WS = null;
const workspaceRequest = async payload => {
  const response = await fetch('/api/workspace', {
    method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  WS = data; renderWorkspace(); return data;
};
const editor = $('#editorDialog'), editorFields = $('#dialogFields');
function openEditor(title, fields, onSave){
  $('#dialogTitle').textContent = title;
  editorFields.innerHTML = fields.map(f => `<label>${esc(f.label)}${f.long
    ? `<textarea name="${esc(f.name)}" rows="6" placeholder="${esc(f.placeholder||'')}"></textarea>`
    : `<input name="${esc(f.name)}" placeholder="${esc(f.placeholder||'')}">`}</label>`).join('');
  $('#editorForm').onsubmit = async e => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try { await onSave(values); editor.close(); } catch(err){ log('error','SAVE',String(err.message||err)); }
  };
  editor.showModal();
}
function renderWorkspace(){
  if (!WS) return;
  const projects = WS.projects || [], selected = projects.find(p => p.id===WS.selectedProject) || projects[0];
  const projectHtml = projects.map(p => `<div class="project-row ${p.id===WS.selectedProject?'selected':''}"><button data-project="${esc(p.id)}"><b>${esc(p.name)}</b><small>${esc(p.folder)}</small></button><button class="danger-link" data-delete-project="${esc(p.id)}" aria-label="Delete ${esc(p.name)}">×</button></div>`).join('');
  $('#projectList').innerHTML = projectHtml || '<div class="empty-state">No projects yet.</div>';
  $('#sidebarProjects').innerHTML = projects.slice(0,6).map(p => `<button data-project="${esc(p.id)}">${esc(p.name)}</button>`).join('');
  $('#sessionContext').textContent = selected ? selected.name : 'Choose a project';
  $('#sessionList').innerHTML = (selected?.sessions||[]).map(s => `<div class="session-row ${s.id===WS.selectedSession?'selected':''}"><button data-session="${esc(s.id)}">${esc(s.name)}</button><button class="danger-link" data-delete-session="${esc(s.id)}">×</button></div>`).join('') || '<div class="empty-state">Create the first chat in this project.</div>';
  const settings=WS.settings||{};
  $('#providerSelect').innerHTML = Object.keys(WS.models||{}).map(p=>`<option value="${esc(p)}" ${p===settings.provider?'selected':''}>${esc(p[0].toUpperCase()+p.slice(1))}</option>`).join('');
  renderModelOptions(); $('#apiBase').value=settings.apiBase||'';
  $('#apiState').textContent = settings.apiConfigured ? 'An API key is configured. Leave the field blank to keep it.' : 'No API key is configured for this provider.';
  $('#profileName').value=settings.profile||'default'; $('#workdir').value=settings.workdir||'~';
  $('#personaText').value=settings.persona||''; $('#computerControl').checked=!!settings.computerControl; $('#mobileControl').checked=!!settings.mobileControl;
  $('#shortcutName').value=settings.shortcutName||'JARVIS Control';
  $('#liveModel').value=settings.liveModel||''; $('#voiceSelect').value=settings.voice||'Kore';
  $('#skillList').innerHTML=(WS.skills||[]).map(s=>`<div class="list-card"><div><b>${esc(s.name)}</b><small>${esc(s.instructions.slice(0,120))}</small></div><button class="danger-link" data-delete-skill="${esc(s.id)}">Delete</button></div>`).join('')||'<div class="empty-state">No custom skills yet.</div>';
  $('#memoryList').innerHTML=(WS.memory||[]).map(m=>`<div class="list-card"><div><b>${esc(m.label)}</b><small>${esc(m.value.slice(0,160))}</small></div><button class="danger-link" data-delete-memory="${esc(m.id)}">Delete</button></div>`).join('')||'<div class="empty-state">Add a fact, preference or relationship.</div>';
  $('#uploadList').innerHTML=(WS.uploads||[]).map(f=>`<div class="list-card"><div><b>${esc(f.name)}</b><small>${Math.max(1,Math.round(f.size/1024))} KB</small></div></div>`).join('')||'<div class="empty-state">No files uploaded.</div>';
  drawMemoryBrain();
}
function renderModelOptions(){
  if(!WS) return; const provider=$('#providerSelect').value;
  const current=WS.settings?.provider===provider?WS.settings.model:'';
  $('#modelSelect').innerHTML=(WS.models?.[provider]||[]).map(m=>`<option ${m===current?'selected':''}>${esc(m)}</option>`).join('');
  $('#customModel').value=(WS.models?.[provider]||[]).includes(current)?'':current;
}
$('#providerSelect').onchange=renderModelOptions;
$('#modelForm').onsubmit=async e=>{e.preventDefault(); const s=WS.settings; await workspaceRequest({action:'save_settings',settings:{...s,provider:$('#providerSelect').value,model:$('#customModel').value.trim()||$('#modelSelect').value,apiBase:$('#apiBase').value.trim(),apiKey:$('#apiKey').value.trim()}}); $('#apiKey').value=''; log('complete','SETTINGS','provider updated'); refreshStatus();};
const addProject=()=>openEditor('New project',[{name:'name',label:'Project name'},{name:'folder',label:'Folder on this computer',placeholder:'C:\\Projects\\My project'}],v=>workspaceRequest({action:'add_project',...v}));
$('#addProject').onclick=addProject; $('#quickProject').onclick=()=>{showView('projects');addProject();};
$('#addSession').onclick=()=>openEditor('New chat',[{name:'name',label:'Chat name'}],v=>workspaceRequest({action:'add_session',projectId:WS.selectedProject,...v}));
$('#addSkill').onclick=()=>openEditor('Create skill',[{name:'name',label:'Skill name'},{name:'instructions',label:'Instructions',long:true}],v=>workspaceRequest({action:'add_skill',...v}));
$('#addMemory').onclick=()=>openEditor('Add memory',[{name:'label',label:'Memory label'},{name:'value',label:'What JARVIS should remember',long:true}],v=>workspaceRequest({action:'add_memory',...v}));
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-project],[data-session],[data-delete-project],[data-delete-session],[data-delete-skill],[data-delete-memory]'); if(!b||!WS)return;
  try{
    if(b.dataset.project) await workspaceRequest({action:'select_session',projectId:b.dataset.project,sessionId:''});
    if(b.dataset.session) await workspaceRequest({action:'select_session',projectId:WS.selectedProject,sessionId:b.dataset.session});
    if(b.dataset.deleteProject) await workspaceRequest({action:'delete_project',id:b.dataset.deleteProject});
    if(b.dataset.deleteSession) await workspaceRequest({action:'delete_session',id:b.dataset.deleteSession});
    if(b.dataset.deleteSkill) await workspaceRequest({action:'delete_skill',id:b.dataset.deleteSkill});
    if(b.dataset.deleteMemory) await workspaceRequest({action:'delete_memory',id:b.dataset.deleteMemory});
  }catch(err){log('error','WORKSPACE',String(err.message||err));}
});
$('#saveSettings').onclick=async()=>{const s=WS.settings; await workspaceRequest({action:'save_settings',settings:{...s,profile:$('#profileName').value,workdir:$('#workdir').value,persona:$('#personaText').value,computerControl:$('#computerControl').checked,mobileControl:$('#mobileControl').checked,liveModel:$('#liveModel').value,voice:$('#voiceSelect').value,shortcutName:$('#shortcutName').value}}); log('complete','SETTINGS','agent settings saved'); refreshStatus();};
$('#useFolder').onclick=()=>{$('#workdir').focus(); $('#workdir').select();};
$('#runShortcut').onclick=()=>{
  if (!WS?.settings?.mobileControl){ log('error','MOBILE','enable Mobile control and save settings first'); return; }
  const name=$('#shortcutName').value.trim(), command=$('#shortcutCommand').value.trim();
  if(!name||!command){ log('error','MOBILE','enter a Shortcut name and command'); return; }
  const url=`shortcuts://run-shortcut?name=${encodeURIComponent(name)}&input=text&text=${encodeURIComponent(command)}`;
  log('send','MOBILE',`opening Apple Shortcut: ${name}`);
  window.location.href=url;
};
$('#installApp').onclick=()=>{
  alert('On iPhone: open this dashboard in Safari, tap Share, then Add to Home Screen. Create an Apple Shortcut named “JARVIS Control” with the app actions you approve. JARVIS can pass any command you enter here into that Shortcut.');
};
const isiOS=/iPhone|iPad|iPod/i.test(navigator.userAgent);
const standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
$('#mobileCapability').textContent=isiOS?(standalone?'Installed as an iPhone app · Shortcuts control ready':'Open in Safari and choose Add to Home Screen'):'Apple Shortcuts control is available when this dashboard is opened on iPhone.';
$('#fileUpload').onchange=async e=>{for(const file of e.target.files){const r=await fetch('/api/upload',{method:'POST',headers:apiHeaders({'content-type':file.type||'application/octet-stream','x-filename':file.name}),body:file}); if(!r.ok)log('error','UPLOAD',`Could not upload ${file.name}`);} await loadWorkspace(); e.target.value='';};
document.querySelectorAll('.generate-btn').forEach(b=>b.onclick=()=>{const type=b.dataset.media,prompt=$(`#${type}Prompt`).value.trim();if(!prompt)return;showView('chat');transmit(`Use my Hermes ${type} generation tools to create: ${prompt}`,{speak:false});});
function drawMemoryBrain(){
  const canvas=$('#memoryCanvas'); if(!canvas||!WS)return; const rect=canvas.getBoundingClientRect();
  const dpr=Math.min(2,devicePixelRatio||1); canvas.width=Math.max(320,rect.width*dpr); canvas.height=Math.max(300,rect.height*dpr);
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr); const w=canvas.width/dpr,h=canvas.height/dpr,cx=w/2,cy=h/2;
  const items=[...(WS.projects||[]).map(x=>({label:x.name,color:'#5ee7ff'})),...(WS.memory||[]).map(x=>({label:x.label,color:'#aa7cff'})),...(WS.skills||[]).map(x=>({label:x.name,color:'#55e6a5'}))].slice(0,22);
  ctx.clearRect(0,0,w,h); ctx.strokeStyle='rgba(94,231,255,.2)'; ctx.lineWidth=1;
  items.forEach((item,i)=>{const a=(i/items.length)*Math.PI*2-Math.PI/2,r=70+(i%3)*42,x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(x,y);ctx.stroke();ctx.fillStyle=item.color;ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.fill();ctx.fillStyle='rgba(225,248,255,.78)';ctx.font='11px system-ui';ctx.fillText(item.label.slice(0,18),x+8,y+4);});
  const glow=ctx.createRadialGradient(cx,cy,4,cx,cy,58);glow.addColorStop(0,'#dfffff');glow.addColorStop(.25,'#5ee7ff');glow.addColorStop(1,'rgba(3,38,52,0)');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(cx,cy,58,0,Math.PI*2);ctx.fill();ctx.fillStyle='#021018';ctx.font='700 13px system-ui';ctx.textAlign='center';ctx.fillText('MEMORY',cx,cy+4);ctx.textAlign='start';
}
async function loadWorkspace(){try{const r=await fetch('/api/workspace',{headers:apiHeaders()});WS=await r.json();renderWorkspace();}catch(e){log('error','WORKSPACE','could not load workspace');}}
window.addEventListener('resize',()=>{if(WS)drawMemoryBrain();});

// ── reactor state ──
function setState(cls, word, sub){
  document.body.className = cls;
  if (word) $('#stword').textContent = word;
  if (sub != null) $('#strun').textContent = sub;
}
function setTag(cls, text){ const t=$('#rtag'); t.className='rtag '+cls; t.textContent=text; }

// ── action log ──
function log(kind, label, msg, jsonHtml){
  const e = document.createElement('div');
  e.className = 'entry k-' + kind;
  e.innerHTML = `<div class="top"><span class="ts">${now()}</span>`
    + `<span class="kind">${esc(label)}</span></div>`
    + (msg ? `<div class="msg">${esc(msg)}</div>` : '')
    + (jsonHtml ? `<div class="jsonblk">${jsonHtml}</div>` : '');
  const box = $('#log');
  box.insertBefore(e, box.firstChild);
  while (box.children.length > 40) box.removeChild(box.lastChild);
}
function usageBlock(u){
  const row = (k,v) => `  <span class="k">"${k}"</span>: <span class="v">${v}</span>`;
  return `{\n  <span class="k">"usage"</span>: {\n`
    + [row('input_tokens', u.input_tokens), row('output_tokens', u.output_tokens),
       row('total_tokens', u.total_tokens)].join(',\n')
    + `\n  }\n}`;
}

// ── the run ──
let running = false, answer = '', firstDelta = false, speakThisRun = true;
let speakDone = Promise.resolve(), activeController = null;

async function transmit(message, options = {}){
  if (!message.trim()) return;
  // With Live connected, typed and spoken turns share the same voice session.
  // Tool requests return through hermes_action; no second TTS voice overlaps it.
  if (liveReady && liveWs?.readyState === WebSocket.OPEN && !message.trim().startsWith('/')) {
    liveWs.send(JSON.stringify({clientContent:{turns:[{role:'user',parts:[{text:message}]}],turnComplete:true}}));
    return;
  }
  if (running){
    // don't silently swallow it — say so, so it never looks like nothing happened
    log('note','BUSY',`still working — "${message.slice(0,40)}" not sent. Wait, or press Esc to cancel.`);
    return;
  }
  showView('chat');
  running = true; answer = ''; firstDelta = false; speakThisRun = options.speak !== false;

  const fresh = /^\/new\b/.test(message.trim());
  const id = rid();
  setState('running', 'RUNNING', id.slice(0,20) + '…');
  setTag('run', 'RUNNING');
  $('#response').innerHTML = '<span class="cur"></span>';
  log('run', 'RUN', `started ${id}; uplink cleared`);

  // visible elapsed counter — a slow answer should never look like a dead screen
  const t0 = performance.now();
  const tick = setInterval(() => {
    if (!running) return;
    const s = ((performance.now()-t0)/1000).toFixed(1);
    if (!answer) $('#strun').textContent = `thinking… ${s}s`;
  }, 200);

  try {
    activeController = new AbortController();
    const res = await fetch('/api/run', {
      method:'POST', headers:apiHeaders({'content-type':'application/json'}),
      body: JSON.stringify({message, fresh}), signal:activeController.signal
    });
    if (!res.ok) throw new Error(`backend returned HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true){
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream:true});
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0){
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handle(JSON.parse(line));
      }
    }
  } catch (e){
    if (e?.name === 'AbortError'){
      log('note', 'CANCEL', 'run cancelled');
      setState('', 'STANDBY', 'cancelled');
      setTag('', 'IDLE');
    } else {
      log('error', 'ERROR', String(e).slice(0,200));
      setState('error', 'FAULT', 'stream dropped');
      setTag('err', 'ERROR');
    }
  }
  activeController = null;
  running = false;
  clearInterval(tick);
  scheduleJobPoll(1500);
  await speakDone;                 // don't return until Jarvis has finished talking
}

function handle(ev){
  switch (ev.t){
    case 'status':
      if (ev.session_id) sys('session', ev.session_id.slice(0,8));
      if (ev.model){ const model=document.querySelector('#core-model'); if(model) model.textContent=ev.model; }
        const msg = `core online · Hermes tools=${ev.tools ?? 0} profile=${ev.profile||'default'} permission=${ev.permission||'normal'}`;
      log('status', 'STATUS', msg);
      break;
    case 'latency':
      log('latency', 'LATENCY', `first token after ${ev.ms}ms`);
      break;
    case 'tool':
      if (ev.phase === 'use')
        log('tool', 'TOOL', `→ ${ev.name}(${ev.input || ''})`);
      else
        log('tool', 'TOOL', `✓ ${ev.ok===false?'error':'ok'}`);
      break;
    case 'delta':
      answer += ev.text;
      renderAnswer();
      if (!firstDelta){
        firstDelta = true;
        log('reason', 'REASONING', answer.slice(0, 220));
      }
      break;
    case 'usage':
      log('status', 'COMPLETE', 'run completed', usageBlock(ev));
      break;
    case 'complete':
      setState('done', 'COMPLETE', (ev.ms!=null?`${ev.ms}ms`:'') );
      setTag('done', 'COMPLETE');
      log('complete', 'COMPLETE', ev.ms!=null?`run completed in ${ev.ms}ms`:'run completed');
      renderAnswer(true);
      speakDone = speakThisRun ? speak(answer) : Promise.resolve();
      break;
    case 'error':
      setState('error', 'FAULT', ev.message?.slice(0,40) || 'error');
      setTag('err', 'ERROR');
      log('error', 'ERROR', ev.message || 'unknown');
      // show it in the panel too, so a failure isn't a silent empty box
      if (!answer) $('#response').innerHTML =
        `<span style="color:var(--red)">⚠ ${esc(ev.message || 'Run failed.')}</span>`;
      else renderAnswer(true);
      break;
    case 'note':
      log('note', 'NOTE', ev.message || '');
      break;
  }
}

function renderAnswer(finaldone){
  const el = $('#response');
  el.innerHTML = esc(answer) + (finaldone ? '' : '<span class="cur"></span>');
  el.scrollTop = el.scrollHeight;
}

function cleanForSpeech(text){
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^(session_id:|session:|duration:|messages:|query:|initializing agent|resume this session|hermes --resume|[-─=]{3,})/i.test(line))
    .join(' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ══════════ continuous voice conversation ══════════
   Click VOICE once. From then on: listen → you stop → transcribe → Jarvis
   answers and speaks → it listens again, automatically. No re-clicking between
   turns. Click VOICE again (or press Esc) to end the conversation.

   Gemini Live stays full duplex while JARVIS speaks, so the user can interrupt.
   Echo cancellation plus local voice activity stops queued playback immediately.
   The non-Live fallbacks still use `suppress` to avoid hearing their own TTS. */
let convo = false, suppress = false;
let recognition = null;
let micStream=null, recorder=null, chunks=[], actx=null, analyser=null, vdata=null;
let vad=null, spoke=false, loudAt=0, turnStart=0;
let floorSum=0, floorN=0, threshold=0.02, peak=0, calibrating=true;
const SILENCE=900, MIN_TURN_MS=350, MAX_TURN_MS=18000, NO_SPEECH_MS=10000;
let liveWs=null, liveInputCtx=null, liveOutputCtx=null, liveProcessor=null;
let liveSource=null, liveReady=false, liveSpeaking=false, livePlayAt=0;
let liveSources=new Set(), bargeFrames=0, wakeLock=null, voiceWanted=false, liveLastMessageAt=0;
let liveBridge=null, liveAnswerStarted=false;

function floatToPcm16Base64(float32, inputRate){
  const ratio = inputRate / 16000;
  const length = Math.max(1, Math.floor(float32.length / ratio));
  const pcm = new Int16Array(length);
  for (let i=0; i<length; i++){
    const start = Math.floor(i * ratio), end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j=start; j<end && j<float32.length; j++) sum += float32[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end-start)));
    pcm[i] = sample < 0 ? sample * 32768 : sample * 32767;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  for (let i=0; i<bytes.length; i+=0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i+0x8000));
  return btoa(binary);
}

function playLivePcm(encoded, rate=24000){
  if (muted || !encoded || !liveOutputCtx) return;
  const raw = atob(encoded), bytes = new Uint8Array(raw.length);
  for (let i=0; i<raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  const audio = liveOutputCtx.createBuffer(1, pcm.length, rate);
  const channel = audio.getChannelData(0);
  for (let i=0; i<pcm.length; i++) channel[i] = pcm[i] / 32768;
  const src = liveOutputCtx.createBufferSource();
  src.buffer = audio; src.connect(liveOutputCtx.destination);
  liveSources.add(src);
  src.onended = () => liveSources.delete(src);
  const when = Math.max(liveOutputCtx.currentTime + 0.015, livePlayAt);
  src.start(when); livePlayAt = when + audio.duration;
  liveSpeaking = true; document.body.classList.add('speaking');
}

function stopLivePlayback(){
  for (const src of liveSources){ try{src.stop();}catch(_){} }
  liveSources.clear();
  if (liveOutputCtx) livePlayAt = liveOutputCtx.currentTime;
  liveSpeaking = false; bargeFrames = 0;
  document.body.classList.remove('speaking');
}

async function holdScreenAwake(){
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try{ wakeLock = await navigator.wakeLock.request('screen'); }
  catch(_){ wakeLock = null; }
}

async function executeLiveAction(request, signal){
  log('tool', 'HERMES', 'Executing voice action');
  const response = await fetch('/api/run', {
    method:'POST', headers:apiHeaders({'content-type':'application/json'}),
    body:JSON.stringify({message:request}), signal
  });
  if (!response.ok) throw new Error(response.status === 409 ? 'An action is already running. Wait for its result.' : `Action failed: HTTP ${response.status}`);
  const reader=response.body.getReader(), decoder=new TextDecoder();
  let buffer='', result='', failure='', completed=false;
  const consume=line=>{
    if (!line.trim()) return;
    const ev=JSON.parse(line);
    if(ev.t==='delta') result+=ev.text || '';
    if(ev.t==='error') failure=ev.message || 'Hermes action failed';
    if(ev.t==='complete') completed=true;
    if(ev.t==='tool') log('tool','HERMES',ev.name || 'Tool activity');
  };
  while(true){
    const {value,done}=await reader.read();
    buffer+=decoder.decode(value || new Uint8Array(),{stream:!done});
    let at;
    while((at=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,at));buffer=buffer.slice(at+1);}
    if(done){consume(buffer);break;}
  }
  if(failure || !completed) throw new Error(failure || 'Connection ended before the action completed. Do not report success.');
  log('tool','HERMES','Action response received');
  return {result:result.slice(0,12000),instruction:'Report this outcome faithfully; do not infer success if it reports refusal, missing tools or failure.'};
}

async function startGeminiLive(){
  try{
    if (player) player.pause();
    speechSynth?.cancel();
    voiceWanted = true;
    setState('running','CONNECTING','Gemini native audio…');
    const auth = await fetch('/api/live-token', {
      method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:'{}'
    }).then(async r => { const data=await r.json(); if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`); return data; });
    micStream = await navigator.mediaDevices.getUserMedia(
      {audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1}});
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    liveInputCtx = new AudioCtx(); liveOutputCtx = new AudioCtx();
    await Promise.all([liveInputCtx.resume(), liveOutputCtx.resume()]);
    livePlayAt = liveOutputCtx.currentTime;
    const endpoint = 'wss://generativelanguage.googleapis.com/ws/'
      + 'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained'
      + `?access_token=${encodeURIComponent(auth.token)}`;
    liveWs = new WebSocket(endpoint);
    liveWs.onopen = () => liveWs.send(JSON.stringify({setup:{
      model:`models/${auth.model}`,
      generationConfig:{responseModalities:['AUDIO'],thinkingConfig:{thinkingBudget:0},speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:auth.voice||'Kore'}}}},
      inputAudioTranscription:{}, outputAudioTranscription:{}, tools:auth.tools || [],
      systemInstruction:{parts:[{text:auth.system || 'You are JARVIS. Speak warmly, naturally, briefly, and helpfully.'}]}
    }}));
    const connectedSocket = liveWs;
    liveBridge = new HermesVoiceBridge(executeLiveAction, message => {
      if (connectedSocket === liveWs && connectedSocket.readyState === WebSocket.OPEN) connectedSocket.send(JSON.stringify(message));
    });
    liveWs.onmessage = async event => {
      liveLastMessageAt = Date.now();
      let payload = event.data;
      if (payload instanceof Blob) payload = await payload.text();
      else if (payload instanceof ArrayBuffer) payload = new TextDecoder().decode(payload);
      const msg = JSON.parse(payload);
      if (msg.setupComplete && !liveReady){
        liveReady = true; convo = true; suppress = false;
        sessionStorage.setItem('jarvis-voice-resume','1');
        $('#mic').classList.add('on'); $('#mic').textContent = '● JARVIS Voice';
        setState('listening','LISTENING','تفضّل، أنا سامعاك');
        log('voice','VOICE',`${auth.model} · ${auth.voice} · Hermes actions connected`);
        liveSource = liveInputCtx.createMediaStreamSource(micStream);
        liveProcessor = liveInputCtx.createScriptProcessor(4096, 1, 1);
        const silent = liveInputCtx.createGain(); silent.gain.value = 0;
        liveProcessor.onaudioprocess = e => {
          if (!liveReady || liveWs?.readyState !== WebSocket.OPEN) return;
          const samples = e.inputBuffer.getChannelData(0);
          if (liveSpeaking){
            let energy = 0;
            for (let i=0; i<samples.length; i++) energy += samples[i] * samples[i];
            const rms = Math.sqrt(energy / samples.length);
            bargeFrames = rms > 0.055 ? bargeFrames + 1 : 0;
            if (bargeFrames >= 2){
              stopLivePlayback();
              setState('listening','LISTENING','interrupted · listening');
              log('voice','VOICE','barge-in detected · response stopped');
            }
          }
          const data = floatToPcm16Base64(samples, liveInputCtx.sampleRate);
          liveWs.send(JSON.stringify({realtimeInput:{audio:{data,mimeType:'audio/pcm;rate=16000'}}}));
        };
        liveSource.connect(liveProcessor); liveProcessor.connect(silent); silent.connect(liveInputCtx.destination);
        holdScreenAwake();
      }
      if (msg.toolCallCancellation) liveBridge?.cancel(msg.toolCallCancellation.ids || []);
      for (const call of (msg.toolCall?.functionCalls || [])) liveBridge?.handle(call);
      const content = msg.serverContent;
      if (!content) return;
      if (content.inputTranscription?.text){
        $('#strun').textContent = 'HEARD: ' + content.inputTranscription.text.slice(0,42);
      }
      if (content.outputTranscription?.text){
        if (!liveAnswerStarted) { answer=''; liveAnswerStarted=true; }
        answer += content.outputTranscription.text;
        renderAnswer();
      }
      for (const part of (content.modelTurn?.parts || [])) {
        if (part.inlineData?.data) playLivePcm(part.inlineData.data, 24000);
      }
      if (content.turnComplete){
        liveAnswerStarted=false;
        const delay = Math.max(0, (livePlayAt - liveOutputCtx.currentTime) * 1000);
        setTimeout(() => {
          if (connectedSocket !== liveWs || liveSources.size) return;
          liveSpeaking=false; document.body.classList.remove('speaking');
          if(convo) setState('listening','LISTENING','تفضّل، أنا سامعاك');
        }, delay + 30);
      }
      if (content.interrupted){
        stopLivePlayback();
        if(convo) setState('listening','LISTENING','interrupted · speak now');
      }
    };
    liveWs.onerror = () => log('error','VOICE','Gemini Live connection error');
    liveWs.onclose = () => { if(convo) { log('error','VOICE','Gemini Live paused'); stopConvo(false); } };
  }catch(e){
    log('error','VOICE',`Gemini Live unavailable: ${String(e.message||e).slice(0,120)}`);
    stopConvo();
  }
}

// ── voice out ──
let muted = false, player = null;
function speak(text){
  return new Promise(resolve => {
    text = cleanForSpeech(text);
    if (muted || !text) return resolve();
    suppress = true;
    const spoken = text.length > 700 ? text.slice(0, 680).replace(/\s+\S*$/,'') + '…' : text;
    if (!RT.tts && RT.browserTts && speechSynth){
      try{
        speechSynth.cancel();
        const u = new SpeechSynthesisUtterance(spoken);
        u.rate = 0.95; u.pitch = 0.82; u.volume = 1;
        document.body.classList.add('speaking');
        u.onend = u.onerror = () => { document.body.classList.remove('speaking'); resolve(); };
        speechSynth.speak(u);
        return;
      }catch(_){ return resolve(); }
    }
    if (!RT.tts) return resolve();
    fetch('/api/speak', {method:'POST', headers:apiHeaders({'content-type':'application/json'}),
                         body: JSON.stringify({text:spoken})})
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        if (player) player.pause();
        player = new Audio(url);
        document.body.classList.add('speaking');
        const done = () => { document.body.classList.remove('speaking');
          URL.revokeObjectURL(url); resolve(); };
        player.onended = done; player.onerror = done;
        return player.play();
      })
      .catch(() => resolve());
  });
}

// ── start / stop the whole conversation ──
async function micToggle(){
  if (convo){ stopConvo(); return; }
  if (RT.live){ await startGeminiLive(); return; }
  // Prefer ElevenLabs server-side STT when configured. Browser STT is unreliable
  // across Chrome profiles and often fails silently; ElevenLabs receives the
  // actual microphone recording from MediaRecorder and is much more consistent.
  if (RT.stt){
    try {
      micStream = await navigator.mediaDevices.getUserMedia(
        {audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}});
    } catch(e){ log('error','VOICE','mic blocked — allow it in the address bar'); return; }
    actx = new (window.AudioContext||window.webkitAudioContext)();
    await actx.resume();
    analyser = actx.createAnalyser(); analyser.fftSize = 1024;
    actx.createMediaStreamSource(micStream).connect(analyser);
    vdata = new Uint8Array(analyser.fftSize);
    convo = true; suppress = false;
    $('#mic').classList.add('on'); $('#mic').textContent = '● ElevenLabs Live';
    log('voice','VOICE','ElevenLabs voice conversation open · listening');
    beginTurn();
    return;
  }
  if (SpeechRecognition){
    convo = true; suppress = false;
    $('#mic').classList.add('on'); $('#mic').textContent = '● Browser Live';
    log('voice','VOICE','browser speech recognition open · listening');
    setState('listening','LISTENING','browser speech online');
    startBrowserRecognition();
    return;
  }
  log('error','VOICE','no speech recognition available — add ElevenLabs key or use Chrome browser STT');
}

function stopConvo(manual=true){
  if (manual){ voiceWanted = false; sessionStorage.removeItem('jarvis-voice-resume'); }
  convo = false; suppress = false;
  liveReady = false; liveSpeaking = false;
  liveBridge?.close(); liveBridge=null; liveAnswerStarted=false;
  stopLivePlayback();
  if (liveProcessor){ try{liveProcessor.disconnect();}catch(_){} liveProcessor=null; }
  if (liveSource){ try{liveSource.disconnect();}catch(_){} liveSource=null; }
  if (liveWs){ const ws=liveWs; liveWs=null; try{ws.close();}catch(_){} }
  if (liveInputCtx){ liveInputCtx.close().catch(()=>{}); liveInputCtx=null; }
  if (liveOutputCtx){ liveOutputCtx.close().catch(()=>{}); liveOutputCtx=null; }
  if (recognition){ try{ recognition.onend = null; recognition.stop(); }catch(_){} recognition=null; }
  if (vad){ clearInterval(vad); vad=null; }
  if (recorder && recorder.state==='recording'){ recorder._cancel=true; try{recorder.stop();}catch(_){} }
  recorder = null;
  if (player){ try{player.pause();}catch(_){} }
  if (micStream){ micStream.getTracks().forEach(t=>t.stop()); micStream=null; }
  if (actx){ actx.close().catch(()=>{}); actx=null; analyser=null; }
  if (wakeLock){ try{wakeLock.release();}catch(_){} wakeLock=null; }
  document.body.classList.remove('speaking');
  $('#mic').classList.remove('on'); $('#mic').textContent = '◉ VOICE';
  log('voice','VOICE','conversation closed');
  setState('', 'STANDBY', 'awaiting uplink');
}

// ── browser speech turn ──
function startBrowserRecognition(){
  if (!convo || suppress || !SpeechRecognition) return;
  recognition = new SpeechRecognition();
  recognition.lang = 'ar-EG';
  recognition.interimResults = true;
  recognition.continuous = false;
  let finalText = '';
  recognition.onresult = e => {
    let interim = '';
    for (let i=e.resultIndex; i<e.results.length; i++){
      const txt = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += txt;
      else interim += txt;
    }
    const shown = (finalText || interim || '').trim();
    if (shown) $('#strun').textContent = 'HEARD: ' + shown.slice(0,42);
  };
  recognition.onerror = e => log('error','VOICE',`browser speech: ${e.error || 'error'}`);
  recognition.onend = async () => {
    const text = finalText.trim();
    if (!convo) return;
    if (!text){ if (!suppress) setTimeout(startBrowserRecognition, 250); return; }
    log('voice','VOICE',`browser transcribed: "${text}"`);
    const armed = $('#input').dataset.cmd || '';
    const full = (armed ? armed + ' ' : '') + text;
    $('#input').value = ''; disarm();
    log('send','SEND',`auto-sent voice: ${full}`);
    await transmit(full);
    suppress = false;
    if (convo) setTimeout(startBrowserRecognition, 350);
  };
  setState('listening','LISTENING','browser speech online');
  try{ recognition.start(); }catch(e){ log('error','VOICE','speech recognition failed to start'); }
}

// ── one server-side ElevenLabs listening turn ──
function beginTurn(){
  if (!convo || suppress || !micStream) return;
  chunks = []; spoke = false; peak = 0;
  floorSum = 0; floorN = 0; calibrating = true; threshold = 0.02;
  recorder = new MediaRecorder(micStream, pickMime());
  recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
  recorder.onstop = ship;
  recorder.start(250);                          // timeslice → data flows reliably
  turnStart = loudAt = performance.now();
  setState('listening','LISTENING','listening…');
  if (!vad) vad = setInterval(vtick, 40);
}

function meter(rms){
  // live input bar in the reactor subtitle, so you can SEE it hearing you
  const n = Math.max(0, Math.min(14, Math.round(rms * 90)));
  $('#strun').textContent = 'IN ' + '▮'.repeat(n) + '▯'.repeat(14 - n);
}

function endTurn(reason){
  log('voice','VOICE',`${reason} · peak ${peak.toFixed(3)} · thr ${threshold.toFixed(3)}`);
  try { recorder.stop(); } catch(_){}           // → ship()
}

function pickMime(){
  for (const m of ['audio/webm;codecs=opus','audio/webm','audio/mp4'])
    if (window.MediaRecorder?.isTypeSupported?.(m)) return {mimeType:m};
  return undefined;
}

function vtick(){
  if (!analyser || suppress || !recorder || recorder.state!=='recording') return;
  analyser.getByteTimeDomainData(vdata);
  let s=0; for (let i=0;i<vdata.length;i++){ const v=(vdata[i]-128)/128; s+=v*v; }
  const rms = Math.sqrt(s/vdata.length);
  const t = performance.now();
  peak = Math.max(peak, rms);
  meter(rms);

  // first 300ms: measure the room's noise floor, set a threshold just above it
  if (calibrating){
    floorSum += rms; floorN++;
    if (t - turnStart > 300){
      const floor = floorSum / Math.max(1, floorN);
      threshold = Math.max(0.006, floor * 1.6 + 0.003);
      calibrating = false;
    }
    return;
  }

  if (rms > threshold){
    loudAt = t;
    if (!spoke){ spoke = true; log('voice','VOICE','speech detected'); }
  } else if (spoke && t - loudAt > SILENCE){
    return endTurn('silence');
  }

  // failsafes so it can never hang: cap the length, re-listen if no speech at all
  if (t - turnStart > MAX_TURN_MS) return endTurn('max-length');
  if (!spoke && t - turnStart > NO_SPEECH_MS) return endTurn('no-speech');
}

async function ship(){
  const cancel = recorder?._cancel;
  const blob = new Blob(chunks, {type: recorder?.mimeType || 'audio/webm'}); chunks=[];
  if (cancel){ return; }
  // no speech heard, too short, or too small — just listen again, don't ship ambient noise
  if (!spoke || blob.size < 1400 || performance.now()-turnStart < MIN_TURN_MS){
    if (convo && !suppress) beginTurn();
    return;
  }
  setState('running','TRANSCRIBING','…');
  log('voice','VOICE',`uploading ${Math.round(blob.size/1024)}KB to server STT`);
  const t0 = performance.now();
  try {
    const r = await fetch('/api/listen', {method:'POST',
      headers:apiHeaders({'content-type':blob.type||'audio/webm'}), body:blob}).then(r=>r.json());
    const text = (r.text||'').trim();
    const ms = Math.round(performance.now() - t0);
    if (!text){
      log('voice','VOICE','nothing transcribed');
      if (convo) beginTurn(); else setState('','STANDBY','nothing heard');
      return;
    }
    log('voice','VOICE',`transcribed by ElevenLabs in ${ms}ms: "${text}"`);
    const armed = $('#input').dataset.cmd || '';
    const full = (armed ? armed + ' ' : '') + text;
    $('#input').value = ''; disarm();
    log('send','SEND',`auto-sent voice: ${full}`);
    await transmit(full);                       // runs, then speaks; both with mic deaf
    // turn's done — hand the floor back and listen again
    suppress = false;
    if (convo) beginTurn();
  } catch(e){
    log('error','VOICE','transcription failed');
    suppress = false;
    if (convo) beginTurn(); else setState('error','FAULT','transcription failed');
  }
}

// ══════════ command matrix ══════════
function disarm(){
  document.querySelectorAll('.cmd').forEach(c=>c.classList.remove('armed'));
  $('#input').dataset.cmd = '';
}
const PAYLOAD_COMMANDS = new Set(['/goal','/pc','/browser','/background','/mission','/personality']);
$('#cmds').addEventListener('click', e => {
  const b = e.target.closest('.cmd'); if (!b) return;
  const cmd = b.dataset.cmd;
  if (running){
    log('note','BUSY',`${cmd} not sent — JARVIS is still working.`);
    return;
  }

  // Commands that need details open Chat and wait for one typed or spoken
  // payload. Sending the empty base command used to launch a vague task and
  // made the cards look broken while Hermes worked without useful output.
  disarm();
  if (PAYLOAD_COMMANDS.has(cmd)){
    showView('chat');
    b.classList.add('armed');
    $('#input').dataset.cmd = cmd;
    $('#input').placeholder = TIPS[cmd] || 'Describe the task';
    $('#input').focus();
    $('#tip').textContent = `${TIPS[cmd] || cmd} Type or say the task, then press Send.`;
    log('command', 'READY', `${cmd} is waiting for task details`);
    return;
  }
  $('#tip').textContent = defaultTip;
  log('command', 'COMMAND', `executing ${cmd} on Hermes backend`);
  transmit(cmd, {speak: !['/tools','/commands'].includes(cmd)});
});
const TIPS = {
  '/new':'Fresh thread — clears the Hermes conversation and starts clean.',
  '/goal':'Say your standing objective, e.g. “ship the dashboard and verify tool access”.',
  '/tools':'Shows Hermes tool status from the active profile.',
  '/toolsets':'Asks Hermes to list enabled toolsets and connected tools.',
  '/browser':'Say a Chrome/browser mission, e.g. “inspect the current tab”.',
  '/pc':'Run a computer-control task through Hermes tools.',
  '/background':'Say a mission, e.g. “research competitors and save a report”.',
  '/mission':'Add or read mission queue items.',
  '/personality':'Set the persona, e.g. “calm, laconic, Stark tower operator”.',
  '/kanban':'Ask about the work queue, e.g. “what’s on my board today?”.',
  '/commands':'Show all dashboard slash commands.'
};
let defaultTip = '';

// ══════════ controls ══════════
function sendFromInput(){
  const armed = $('#input').dataset.cmd || '';
  const raw = $('#input').value.trim();
  if (!raw && !armed) return;
  const full = (armed && !raw.startsWith('/')) ? `${armed} ${raw}` : (raw || armed);
  $('#input').value = ''; $('#input').placeholder = 'Message JARVIS'; disarm(); $('#tip').textContent = defaultTip;
  log('send','SEND',`transmit: ${full}`);
  transmit(full);
}
$('#run').onclick = sendFromInput;
$('#mic').onclick = micToggle;
$('#showCommands').onclick = () => transmit('/commands', {speak:false});
$('#missionBtn').onclick = () => transmit('/mission', {speak:false});
$('#clearBtn').onclick = () => { answer=''; $('#response').innerHTML='<span class="rplaceholder">Display cleared. Standing by.</span>'; log('note','CLEAR','response panel cleared'); };
document.querySelectorAll('[data-quick]').forEach(b => b.onclick = () =>
  transmit(b.dataset.quick, {speak:false}));
document.querySelectorAll('[data-compose]').forEach(b => b.onclick = () => {
  showView('chat');
  $('#input').value = b.dataset.compose || '';
  $('#input').focus();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (running && activeController){
    fetch('/api/cancel', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:'{}'}).catch(()=>{});
    activeController.abort();
    return;
  }
  if (convo) stopConvo();
});
$('#mute').onclick = () => {
  muted = !muted; const b=$('#mute');
  b.textContent = muted?'🔇':'🔊'; b.classList.toggle('on',!muted); b.classList.toggle('off',muted);
  if (muted && player) player.pause();
};
$('#input').addEventListener('keydown', e => {
  if (e.key==='Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); sendFromInput(); }
});

// ══════════ system panel ══════════
function sys(id, val, cls){
  const el = $('#sy-' + id); if (!el) return;
  el.textContent = val; if (cls != null) el.className = cls;
}
// live clock in the system panel
setInterval(() => sys('clock', now()), 1000);

// Background missions run on the server. The page reports them immediately when
// visible again, even if iOS suspended the installed web app in the meantime.
const JOB_POLL_ACTIVE_MS = 8000;
const JOB_POLL_IDLE_MS = 300000;
let jobPollTimer = null;
let jobPollInFlight = false;

function nextJobPollDelay(){
  if (document.visibilityState === 'hidden') return JOB_POLL_IDLE_MS;
  return running ? JOB_POLL_ACTIVE_MS : JOB_POLL_IDLE_MS;
}

function scheduleJobPoll(delay = nextJobPollDelay()){
  clearTimeout(jobPollTimer);
  jobPollTimer = setTimeout(pollJobs, delay);
}

async function pollJobs(){
  if (jobPollInFlight){
    scheduleJobPoll();
    return;
  }
  jobPollInFlight = true;
  try {
    const j = await fetch('/api/jobs', {headers:apiHeaders()}).then(r => r.json());
    for (const d of (j.done || [])){
      log('complete','MISSION', `${d.mission} → ${(d.result||'').slice(0,200)}`);
      if (!running) speak(`Mission complete. ${(d.result||'').slice(0,300)}`);
    }
  } catch(_){}
  finally {
    jobPollInFlight = false;
    scheduleJobPoll();
  }
}
scheduleJobPoll(12000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden'){
    if (convo || voiceWanted) sessionStorage.setItem('jarvis-voice-resume','1');
    scheduleJobPoll();
    return;
  }
  refreshStatus(); loadWorkspace(); pollJobs();
  if (convo) holdScreenAwake();
  const shouldResume=sessionStorage.getItem('jarvis-voice-resume')==='1';
  const staleLive=liveWs && Date.now()-liveLastMessageAt>20000;
  if (shouldResume && RT.live && (!liveWs || liveWs.readyState > WebSocket.OPEN || staleLive)){
    if (staleLive) stopConvo(false);
    setTimeout(() => startGeminiLive(), 350);
  }
});

if ('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('/service-worker.js').catch(()=>{}));
}

// ══════════ boot and non-blocking status refresh ══════════
let bootLogged = false;
function renderStatus(s){
  RT.tts = s.tts !== 'browser'; RT.stt = s.stt === 'elevenlabs';
  RT.live = !!s.live_voice; RT.liveModel = s.live_model || '';
  RT.browserStt = !!SpeechRecognition; RT.browserTts = !!speechSynth;
  const hermesReady = !!s.hermes_connected;
  const hermesChecking = !!s.hermes_pending;
  const hermesLabel = hermesReady ? 'Connected' : (hermesChecking ? 'Checking' : 'Offline');
  const providerName = s.provider === 'gemini' ? 'Gemini' : (s.provider || 'profile model');
  const brain = s.runtime === 'hermes' ? `Hermes · ${providerName}` : 'Core offline';
  const ttsLabel = s.tts === 'gemini' ? 'Gemini TTS' : (RT.tts ? 'ElevenLabs TTS' : 'Browser TTS');
  const sttLabel = RT.live ? 'Gemini Live' : (RT.stt ? 'ElevenLabs STT' : (RT.browserStt ? 'Browser STT' : 'Text only'));
  sys('gw', 'Online', 'ok');
  sys('hermes', hermesLabel, hermesReady ? 'ok' : (hermesChecking ? '' : 'warn'));
  sys('brain', brain, s.runtime === 'mock' ? 'warn' : 'ok');
  sys('voice', `${sttLabel} / ${ttsLabel}`, (RT.browserStt||RT.stt) ? 'ok' : 'warn');
  sys('profile', s.profile || 'default');
  sys('runtime', brain, (s.runtime === 'mock' || (!hermesReady && !hermesChecking)) ? 'warn' : 'ok');
  sys('clock', now());
  $('#top-gw').textContent = 'JARVIS online';
  $('#top-hermes').textContent = `Hermes ${hermesLabel.toLowerCase()}`;
  $('#top-profile').textContent = 'Profile: ' + (s.profile || 'default');
  $('#top-voice').textContent = `${sttLabel} · ${ttsLabel}`;
  const model = document.querySelector('#core-model'); if (model) model.textContent = s.model || brain;
  const tools = (s.tools || []).slice(0, 18);
  $('#toolsList').innerHTML = tools.length
    ? tools.map(t => `<span class="chip">${esc(t)}</span>`).join('')
    : `<div class="empty-state">${s.tools_pending ? 'Loading Hermes tools…' : 'No Hermes tools were reported.'}</div>`;
  if (!bootLogged){
    bootLogged = true;
    log('status','BOOT',`dashboard online · Hermes ${hermesLabel.toLowerCase()} · ${s.runtime} conversation · profile=${s.profile || 'default'}`);
    log('voice','VOICE',`channel ready — ${sttLabel} / ${ttsLabel}`);
  }
  $('#mic').textContent = RT.live ? 'JARVIS Voice' : (RT.stt ? 'Voice live' : 'Voice');
  setState('', 'STANDBY', 'awaiting uplink');
}
async function refreshStatus(attempt = 0){
  try{
    const response = await fetch('/api/status', {cache:'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    renderStatus(status);
    if (status.tools_pending && !(status.tools || []).length && attempt < 20){
      setTimeout(() => refreshStatus(attempt + 1), 900);
    }
  }catch(_){
    sys('gw','Offline','warn');
    $('#top-gw').textContent = 'JARVIS offline';
    $('#top-hermes').textContent = 'Hermes unknown';
    if (!bootLogged) log('error','STATUS','server unreachable');
  }
}
defaultTip = $('#tip').textContent;
loadWorkspace();
refreshStatus();

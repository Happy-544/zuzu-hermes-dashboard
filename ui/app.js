/* Zuzu Live HUD — drives Hermes Agent, streams telemetry.

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
  if (!g) return;
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
let brainNodes = [], brainSelectedIndex = -1, brainMotion = 0, brainAnimation = null;
const CAPABILITY_CATALOG = [
  {type:'hermes', source:'Hermes catalogue', name:'Hermes browser automation', desc:'Open sites, inspect pages, gather evidence and report results through the active Hermes profile.', prompt:'Find and enable the best Hermes browser automation workflow for Zuzu, then explain the exact commands and safety limits.'},
  {type:'hermes', source:'Hermes catalogue', name:'Hermes computer use', desc:'Control Windows apps and show the laptop state back to the mobile dashboard.', prompt:'Inspect the active Hermes computer_use capability and show how Zuzu should use it for Windows app control and screenshots.'},
  {type:'tool', source:'Hermes tools', name:'Vision and image analysis', desc:'Let Zuzu inspect screenshots, camera frames and uploaded images.', prompt:'Check Hermes vision/image-analysis tools and return the best way to use them from Zuzu.'},
  {type:'tool', source:'Hermes tools', name:'Image generation', desc:'Create images and return direct files or links that Zuzu can show in the core.', prompt:'Check available Hermes image generation tools and return usage examples that save/show the result in Zuzu.'},
  {type:'skill', source:'Zuzu skill', name:'PC presentation mode', desc:'Reusable behavior for taking screenshots, showing previews, and asking the user for approval.', instructions:'When showing work from the laptop, take or request a screenshot, display it in Zuzu core when possible, describe what changed, and ask the user to approve before destructive actions.'},
  {type:'skill', source:'Zuzu skill', name:'Arabic voice persona', desc:'Keep Zuzu natural in Egyptian Arabic while preserving technical accuracy.', instructions:'Speak mainly in Egyptian Arabic when the user does. Keep answers warm, short, and direct. Do not claim a tool is unavailable until Hermes has been asked when the request is actionable.'},
  {type:'plugin', source:'GitHub', name:'GitHub MCP/tools search', desc:'Search GitHub for installable MCP servers, skills, plugins, and automation helpers.', prompt:'Search GitHub for Zuzu/Hermes compatible MCP servers, plugins, tools, and skills for this topic. Return source links, install risk, and exact setup steps. Do not install.'},
  {type:'model', source:'Hugging Face', name:'Hugging Face models and Spaces', desc:'Find vision, speech, video, and local model helpers from Hugging Face.', prompt:'Search Hugging Face for models, Spaces, or tools matching this topic. Return options with links, hardware/API requirements, and how Zuzu could use them. Do not install.'},
  {type:'plugin', source:'Plugin catalogue', name:'Codex/OpenAI plugins', desc:'Discover connected plugins or recommended plugins that can expand Zuzu.', prompt:'List relevant Codex/OpenAI plugins or connectors for this topic, including what each plugin adds and whether it needs installation or account connection.'},
  {type:'plugin', source:'Account connectors', name:'Email and Drive accounts', desc:'Connect Gmail, Google Drive, Docs, Sheets, Dropbox, Box, or similar accounts through safe OAuth/connectors.', prompt:'Explain the safest way to connect email and drive accounts to Hermes/Zuzu. Include Gmail, Google Drive, Dropbox and Box options if available, and do not request or expose passwords.'},
  {type:'plugin', source:'Commerce connectors', name:'Shopping and Shopify accounts', desc:'Connect Shopify or shopping/admin accounts through approved connectors and browser workflows.', prompt:'Explain how to connect Shopify and shopping/admin accounts to Hermes/Zuzu using connectors or browser tools. Mention permissions, safety boundaries, and confirmation steps.'},
  {type:'plugin', source:'Music connectors', name:'Spotify / Apple Music', desc:'Play music and build playlists from the user’s preferences when a music connector or browser session is available.', prompt:'Find the best way to connect Spotify, Apple Music, or YouTube Music to Zuzu. Include playlist creation, playback limits on mobile/browser, and required account connection steps.'},
  {type:'tool', source:'Hermes cronjob', name:'Follow-up reminders', desc:'Create reminders, scheduled checks, and update notifications through Hermes cronjob/background tools.', prompt:'Set up or explain a Hermes-native reminder/follow-up flow for the user request. Use cronjob, background mission, calendar or todo tools when available; ask for missing time/frequency only if required.'},
  {type:'skill', source:'Zuzu skill', name:'Self modification protocol', desc:'Teach Zuzu to route requests about changing her UI, voice, memory, tools or behaviour to Hermes instead of refusing.', instructions:'When the user asks to modify Zuzu, her interface, voice, memory, tools, skills, providers, or dashboard behavior, treat it as a valid request to inspect and modify the local dashboard project. Route actionable work to Hermes/computer/file tools, report exact files changed, tests run, and limits. Do not say you cannot modify yourself before checking the local project path and available tools.'}
];
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
  $('#shortcutName').value=settings.shortcutName||'Zuzu Control';
  $('#liveModel').value=settings.liveModel||''; $('#voiceSelect').value=settings.voice||'Kore';
  $('#skillList').innerHTML=(WS.skills||[]).map(s=>`<div class="list-card"><div><b>${esc(s.name)}</b><small>${esc(s.instructions.slice(0,120))}</small></div><button class="danger-link" data-delete-skill="${esc(s.id)}">Delete</button></div>`).join('')||'<div class="empty-state">No custom skills yet.</div>';
  $('#memoryList').innerHTML=(WS.memory||[]).map(m=>`<div class="list-card"><div><b>${esc(m.label)}</b><small>${esc(m.value.slice(0,160))}</small></div><button class="danger-link" data-delete-memory="${esc(m.id)}">Delete</button></div>`).join('')||'<div class="empty-state">Add a fact, preference or relationship.</div>';
  $('#uploadList').innerHTML=(WS.uploads||[]).map(f=>`<div class="list-card"><div><b>${esc(f.name)}</b><small>${Math.max(1,Math.round(f.size/1024))} KB</small></div></div>`).join('')||'<div class="empty-state">No files uploaded.</div>';
  renderCapabilityCatalogue();
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
$('#searchAllCapabilities')?.addEventListener('click',()=>askSkillSearch('all catalogues'));
$('#searchGithubSkills')?.addEventListener('click',()=>askSkillSearch('GitHub'));
$('#searchHuggingFaceSkills')?.addEventListener('click',()=>askSkillSearch('Hugging Face'));
$('#skillSearch')?.addEventListener('input',()=>renderCapabilityCatalogue());
$('#catalogueTabs')?.addEventListener('click',e=>{
  const b=e.target.closest('[data-catalogue-filter]'); if(!b) return;
  document.querySelectorAll('[data-catalogue-filter]').forEach(x=>x.classList.toggle('active',x===b));
  renderCapabilityCatalogue(b.dataset.catalogueFilter||'all');
});
$('#addMemory').onclick=()=>openEditor('Add memory',[{name:'label',label:'Memory label'},{name:'value',label:'What Zuzu should remember',long:true}],v=>workspaceRequest({action:'add_memory',...v}));
async function saveMemory(label,value){
  const clean = String(value||'').trim(); if(!clean) return false;
  await workspaceRequest({action:'add_memory',label:String(label||'Memory').slice(0,100),value:clean.slice(0,4000)});
  log('complete','MEMORY',`saved: ${String(label||'Memory').slice(0,40)}`);
  return true;
}
async function autoRemember(message){
  const text=String(message||'').trim();
  const m=text.match(/(?:^|\b)(?:remember|save this|note this|افتكري|احفظي|احفظ|خلي بالك|متنسيش)\s*[:،-]?\s*(.{4,})/i);
  if(!m) return false;
  const value=m[1].replace(/^that\s+/i,'').trim();
  if(!value || value.length<4) return false;
  try{ await saveMemory('Auto memory', value); return true; }
  catch(err){ log('error','MEMORY',String(err.message||err)); return false; }
}
function askSkillSearch(source){
  const q=($('#skillSearch')?.value||'').trim();
  if(!q){ log('error','SKILLS','enter a skill search query first'); $('#skillSearch')?.focus(); return; }
  showView('chat');
  transmit(`Search ${source} for Hermes/Zuzu compatible capabilities about: ${q}. Include skills, plugins, MCP servers, tools, models, Hugging Face Spaces/models, GitHub projects, and Hermes catalogue options. Return a catalogue with source links, install requirements, risks, and how to add the chosen one to Zuzu. Do not install anything yet.`,{speak:false});
}
function currentCatalogueFilter(){
  return document.querySelector('[data-catalogue-filter].active')?.dataset.catalogueFilter || 'all';
}
function renderCapabilityCatalogue(filter=currentCatalogueFilter()){
  const grid=$('#catalogueGrid'); if(!grid) return;
  const q=($('#skillSearch')?.value||'').trim().toLowerCase();
  const cards=CAPABILITY_CATALOG.filter(item=>{
    const matchesFilter=filter==='all'||item.type===filter||item.source.toLowerCase().includes(filter);
    const hay=`${item.name} ${item.desc} ${item.source} ${item.type}`.toLowerCase();
    return matchesFilter && (!q || hay.includes(q));
  });
  grid.innerHTML=cards.map((item,i)=>`<article class="catalogue-card"><div><span>${esc(item.type)}</span><b>${esc(item.name)}</b><small>${esc(item.source)}</small><p>${esc(item.desc)}</p></div><div class="catalogue-actions">${item.instructions?`<button data-catalog-add="${i}" type="button">Add as skill</button>`:''}<button data-catalog-search="${i}" type="button">Ask Hermes</button></div></article>`).join('') || '<div class="empty-state">No catalogue item matches this search. Press Search all to ask Hermes to search externally.</div>';
}
async function addCatalogueSkill(item){
  await workspaceRequest({action:'add_skill',name:item.name,instructions:item.instructions||item.desc});
  log('complete','CATALOGUE',`${item.name} added as a Zuzu skill`);
}

document.addEventListener('click',async e=>{
  const add=e.target.closest('[data-catalog-add]');
  if(add){
    try{ await addCatalogueSkill(CAPABILITY_CATALOG[Number(add.dataset.catalogAdd)]); }
    catch(err){ log('error','CATALOGUE',String(err.message||err)); }
    return;
  }
  const search=e.target.closest('[data-catalog-search]');
  if(search){
    const item=CAPABILITY_CATALOG[Number(search.dataset.catalogSearch)];
    showView('chat');
    transmit(`${item.prompt || `Search ${item.source} for ${item.name}.`} Current catalogue query: ${($('#skillSearch')?.value||'').trim() || item.name}.`,{speak:false});
    return;
  }
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
  alert('On iPhone: open this dashboard in Safari, tap Share, then Add to Home Screen. Create an Apple Shortcut named “Zuzu Control” with the app actions you approve. Zuzu can pass any command you enter here into that Shortcut.');
};
document.querySelectorAll('[data-shortcut-command]').forEach(button=>button.addEventListener('click',()=>{
  $('#shortcutCommand').value = button.dataset.shortcutCommand || '';
  log('status','MOBILE',`shortcut command ready: ${$('#shortcutCommand').value}`);
}));

const isiOS=/iPhone|iPad|iPod/i.test(navigator.userAgent);
const standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
$('#mobileCapability').textContent=isiOS?(standalone?'Installed as an iPhone app · Shortcuts control ready':'Open in Safari and choose Add to Home Screen'):'Apple Shortcuts control is available when this dashboard is opened on iPhone.';
let activeAttachments = [], pendingLiveAttachmentParts = [];
const MAX_INLINE_IMAGE = 8 * 1024 * 1024;
function fileToBase64(file){
  return new Promise(resolve => {
    if(!file.type?.startsWith('image/') || file.size > MAX_INLINE_IMAGE) return resolve('');
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result||'').split(',')[1]||'');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}
async function uploadFiles(files, activate=false){
  const list = Array.from(files||[]); if(!list.length) return [];
  const uploaded = [];
  for(const file of list){
    try{
      const inlineData = await fileToBase64(file);
      const r=await fetch('/api/upload',{method:'POST',headers:apiHeaders({'content-type':file.type||'application/octet-stream','x-filename':file.name}),body:file});
      const data=await r.json();
      if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
      uploaded.push({...data,type:file.type||'application/octet-stream',inlineData});
      log('complete','UPLOAD',`${file.name} attached`);
    }catch(err){ log('error','UPLOAD',`Could not upload ${file.name}: ${String(err.message||err)}`); }
  }
  if(activate && uploaded.length){ activeAttachments.push(...uploaded); renderActiveAttachments(); showView('chat'); }
  await loadWorkspace(); return uploaded;
}
function renderActiveAttachments(){
  const box=$('#chatAttachments'); if(!box) return;
  box.hidden = activeAttachments.length === 0;
  box.innerHTML = activeAttachments.map((f,i)=>`<span class="attachment-chip"><b>${esc(f.type?.startsWith('image/')?'Image':'File')}</b>${esc(f.name)}<button type="button" data-detach="${i}" aria-label="Remove attachment">×</button></span>`).join('');
}
function describeAttachment(f){
  const kind = f.type?.startsWith('image/') ? 'image' : 'file';
  return `- ${kind}: ${f.name} (${Math.max(1,Math.round((f.size||0)/1024))} KB) local path: ${f.path}`;
}
function attachUploadedContext(message){
  if(!activeAttachments.length) return message;
  pendingLiveAttachmentParts = activeAttachments.filter(f=>f.inlineData).map(f=>({inlineData:{mimeType:f.type||'image/jpeg',data:f.inlineData}}));
  const summary = activeAttachments.map(describeAttachment).join('\n');
  log('send','FILES',`attached ${activeAttachments.length} file/image${activeAttachments.length===1?'':'s'}`);
  activeAttachments = []; renderActiveAttachments();
  return `${message}\n\nAttached files/images for this request:\n${summary}\nUse these attachments as direct context. If an attachment is an image, inspect it; if it is a document/file, open or read the local path through Hermes tools when needed.`;
}
$('#fileUpload').onchange=async e=>{await uploadFiles(e.target.files,false); e.target.value='';};
$('#chatFileUpload')?.addEventListener('change',async e=>{await uploadFiles(e.target.files,true); e.target.value='';});
document.addEventListener('click',e=>{const b=e.target.closest('[data-detach]'); if(!b)return; activeAttachments.splice(Number(b.dataset.detach),1); renderActiveAttachments();});


// ── Stage 2: live camera / screen vision inside the Zuzu core ──
let visualStream = null, visualKind = '', visualFacing = 'environment', visualLastUpload = null, visualObjectUrl = '', visualBrowserUrl = '', laptopScreenTimer = null, liveVisualSentAt = 0;
function setVisualStatus(text){ const el=$('#visualMode'); if(el) el.textContent = text; }
function setVisionBox(open){ const box=$('#coreVisionBox'); if(box) box.hidden = !open; }
function stopLaptopScreen(){
  if(laptopScreenTimer){ clearInterval(laptopScreenTimer); laptopScreenTimer=null; }
}
function resetVisualSurfaces(){
  stopLaptopScreen();
  const video=$('#visualPreview'), img=$('#visualImage'), frame=$('#visualFrame'), empty=$('#visualEmpty');
  if(video){ video.srcObject=null; video.removeAttribute('data-active'); video.hidden=false; video.removeAttribute('src'); video.controls=false; video.loop=false; }
  if(img){ img.hidden=true; img.removeAttribute('src'); }
  if(frame){ frame.hidden=true; frame.removeAttribute('src'); }
  if(empty) empty.hidden=false;
  if(visualObjectUrl){ URL.revokeObjectURL(visualObjectUrl); visualObjectUrl=''; }
  visualBrowserUrl='';
}
function stopVisualStream(){
  if (visualStream){ visualStream.getTracks().forEach(t=>t.stop()); visualStream=null; }
  resetVisualSurfaces();
  visualKind=''; setVisualStatus('Vision idle'); setVisionBox(false);
  document.body.classList.remove('vision-on');
}
async function startVisual(kind){
  try{
    stopVisualStream();
    if (!navigator.mediaDevices){ throw new Error('Camera/screen sharing is not available in this browser.'); }
    if (kind === 'camera'){
      visualStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:visualFacing}, audio:false});
      visualKind = 'camera'; setVisualStatus(visualFacing === 'user' ? 'Front camera' : 'Back camera');
      const flip=$('#flipCamera'); if(flip) flip.hidden=false;
    } else {
      if (!navigator.mediaDevices.getDisplayMedia){ throw new Error('Screen sharing is not available on this browser/device.'); }
      visualStream = await navigator.mediaDevices.getDisplayMedia({video:true, audio:false});
      visualKind = 'screen'; setVisualStatus('Screen share');
      const flip=$('#flipCamera'); if(flip) flip.hidden=true;
    }
    resetVisualSurfaces();
    const video=$('#visualPreview'); video.srcObject=visualStream; video.dataset.active='1'; video.hidden=false;
    const empty=$('#visualEmpty'); if(empty) empty.hidden=true;
    setVisionBox(true); document.body.classList.add('vision-on');
    visualStream.getVideoTracks().forEach(track => track.addEventListener('ended', stopVisualStream, {once:true}));
    log('status','VISION',`${visualKind} preview opened in Zuzu core`);
  }catch(err){
    log('error','VISION',String(err.message||err));
    setVisualStatus('Vision unavailable'); setVisionBox(true);
  }
}
async function flipCamera(){
  if (visualKind !== 'camera') return;
  visualFacing = visualFacing === 'environment' ? 'user' : 'environment';
  await startVisual('camera');
}
function youtubeEmbedUrl(url){
  try{
    const u=new URL(url);
    if(u.hostname.includes('youtube.com')){
      const id=u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop();
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : url;
    }
    if(u.hostname === 'youtu.be'){
      const id=u.pathname.split('/').filter(Boolean)[0];
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : url;
    }
  }catch{}
  return url;
}
function showImageBlob(blob, status='Laptop screenshot'){
  stopVisualStream();
  visualKind='laptop-image';
  visualObjectUrl = URL.createObjectURL(blob);
  const video=$('#visualPreview'), img=$('#visualImage'), frame=$('#visualFrame'), empty=$('#visualEmpty'), flip=$('#flipCamera');
  if(flip) flip.hidden=true;
  if(video) video.hidden=true;
  if(frame) frame.hidden=true;
  if(img){ img.src=visualObjectUrl; img.hidden=false; }
  if(empty) empty.hidden=true;
  setVisualStatus(status);
  setVisionBox(true); document.body.classList.add('vision-on');
}
async function fetchLaptopScreen(status='Laptop screenshot'){
  const r=await fetch(`/api/laptop-screen?t=${Date.now()}`,{headers:apiHeaders()});
  if(!r.ok){
    const data=await r.json().catch(()=>({error:`HTTP ${r.status}`}));
    throw new Error(data.error||`HTTP ${r.status}`);
  }
  return r.blob();
}
async function showLaptopSnapshot(){
  try{
    const blob=await fetchLaptopScreen('Laptop screenshot');
    showImageBlob(blob,'Laptop screenshot');
    log('complete','LAPTOP','screenshot shown in Zuzu core');
  }catch(err){
    log('error','LAPTOP',String(err.message||err));
  }
}
async function refreshLaptopLive(){
  try{
    const blob=await fetchLaptopScreen('Laptop live');
    showImageBlob(blob,'Laptop live');
  }catch(err){
    stopLaptopScreen();
    setVisualStatus('Laptop screen unavailable');
    log('error','LAPTOP',String(err.message||err));
  }
}
async function startLaptopLive(){
  stopVisualStream();
  visualKind='laptop-live';
  setVisualStatus('Laptop live');
  setVisionBox(true); document.body.classList.add('vision-on');
  await refreshLaptopLive();
  laptopScreenTimer=setInterval(refreshLaptopLive, 1200);
}
function showVideoUrl(url, status='Video / YouTube'){
  if(!url) return;
  stopVisualStream(); visualKind='remote-video'; visualBrowserUrl=url;
  const video=$('#visualPreview'), img=$('#visualImage'), frame=$('#visualFrame'), empty=$('#visualEmpty'), flip=$('#flipCamera');
  if(img) img.hidden=true; if(flip) flip.hidden=true; if(empty) empty.hidden=true;
  const lower=url.toLowerCase();
  if(/\.(mp4|webm|ogg)(\?|#|$)/i.test(lower)){
    if(frame) frame.hidden=true;
    if(video){ video.src=url; video.srcObject=null; video.dataset.active='1'; video.hidden=false; video.controls=true; video.loop=false; }
  }else{
    if(video) video.hidden=true;
    if(frame){ frame.src=youtubeEmbedUrl(url); frame.hidden=false; }
  }
  setVisualStatus(status); setVisionBox(true); document.body.classList.add('vision-on');
}
function requestLaptopPicture(){
  transmit('/pc Take a screenshot or create/find the picture you want to show me from the laptop, save it if needed, and return a direct file path or URL. Describe what I should judge, then ask me what I think.',{speak:false});
}
function requestLaptopVideo(){
  const raw=prompt('Paste a YouTube/video URL to show in Zuzu core, or leave empty so Zuzu/Hermes can find one:', '');
  if(raw && raw.trim()){
    const url=/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
    showVideoUrl(url);
    log('status','VIDEO',`showing ${url}`);
    return;
  }
  transmit('/pc Find or open the video/YouTube item relevant to my current request and return the direct URL so the dashboard can display it to me. If you cannot open it directly, return the best URL and explain why.',{speak:false});
}
function openBrowserPreview(){
  const raw=prompt('Open browser view inside Zuzu core. Enter URL:', 'https://');
  if(!raw) return;
  let url=raw.trim();
  if(!/^https?:\/\//i.test(url)) url='https://'+url;
  stopVisualStream(); visualKind='browser'; visualBrowserUrl=url;
  const video=$('#visualPreview'), img=$('#visualImage'), frame=$('#visualFrame'), empty=$('#visualEmpty'), flip=$('#flipCamera');
  if(video) video.hidden=true; if(img) img.hidden=true; if(flip) flip.hidden=true;
  if(frame){ frame.src=url; frame.hidden=false; }
  if(empty) empty.hidden=true;
  setVisualStatus('Browser preview'); setVisionBox(true); document.body.classList.add('vision-on');
  log('status','BROWSER',`preview opened: ${url}`);
}
function requestLaptopScreen(){
  startLaptopLive();
}

function captureVisualFrame(){
  const video=$('#visualPreview');
  if(!video || !visualStream || video.readyState < 2) throw new Error('Open livestream or screen share first.');
  const canvas=document.createElement('canvas');
  const w=video.videoWidth || 1280, h=video.videoHeight || 720;
  const max=1280, scale=Math.min(1, max/Math.max(w,h));
  canvas.width=Math.max(1, Math.round(w*scale)); canvas.height=Math.max(1, Math.round(h*scale));
  const ctx=canvas.getContext('2d'); ctx.drawImage(video,0,0,canvas.width,canvas.height);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/jpeg', .82));
}
async function uploadVisualFrame(){
  if(!visualStream) return null;
  const blob=await captureVisualFrame();
  if(!blob) return null;
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const filename=`zuzu-${visualKind||'vision'}-${stamp}.jpg`;
  const r=await fetch('/api/upload',{method:'POST',headers:apiHeaders({'content-type':'image/jpeg','x-filename':filename}),body:blob});
  const data=await r.json();
  if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
  visualLastUpload=data;
  loadWorkspace().catch(()=>{});
  return data;
}
async function attachVisualContext(message){
  if(visualBrowserUrl) return `${message}\n\nCurrent browser preview open in Zuzu core: ${visualBrowserUrl}. Use this URL/context when answering if relevant.`;
  if(!visualStream) return message;
  try{
    const data=await uploadVisualFrame();
    if(!data) return message;
    log('send','VISION',`attached ${visualKind||'visual'} frame`);
    return `${message}\n\nCurrent ${visualKind||'visual'} frame is attached for context. Image file on this computer: ${data.path}`;
  }catch(err){
    log('error','VISION',String(err.message||err));
    return message;
  }
}
async function sendLiveVisualFrame(reason='current voice question'){
  if(!visualStream || !liveReady || liveWs?.readyState !== WebSocket.OPEN) return;
  const nowMs=Date.now();
  if(nowMs-liveVisualSentAt < 3500) return;
  liveVisualSentAt=nowMs;
  try{
    const blob=await captureVisualFrame();
    const reader=new FileReader();
    reader.onload=()=>{
      const base64=String(reader.result||'').split(',')[1]||'';
      if(!base64 || liveWs?.readyState !== WebSocket.OPEN) return;
      liveWs.send(JSON.stringify({clientContent:{turns:[{role:'user',parts:[
        {text:`Visual context from my open ${visualKind||'camera'} for ${reason}. Use it when answering my current voice/chat question.`},
        {inlineData:{mimeType:'image/jpeg',data:base64}}
      ]}],turnComplete:true}}));
      log('send','VISION','sent live visual frame');
    };
    reader.readAsDataURL(blob);
  }catch(err){ log('error','VISION',String(err.message||err)); }
}
$('#dockCamera')?.addEventListener('click',()=>startVisual('camera'));
$('#dockScreen')?.addEventListener('click',()=>startVisual('screen'));
$('#dockLaptop')?.addEventListener('click',requestLaptopScreen);
$('#dockImage')?.addEventListener('click',showLaptopSnapshot);
$('#dockVideo')?.addEventListener('click',requestLaptopVideo);
$('#dockBrowser')?.addEventListener('click',openBrowserPreview);
$('#flipCamera')?.addEventListener('click',flipCamera);
$('#stopVisual')?.addEventListener('click',stopVisualStream);
document.querySelectorAll('.generate-btn').forEach(b=>b.onclick=()=>{const type=b.dataset.media,prompt=$(`#${type}Prompt`).value.trim();if(!prompt)return;showView('chat');transmit(`Use my Hermes ${type} generation tools to create: ${prompt}`,{speak:false});});
function memoryItems(){
  if(!WS) return [];
  const settings=WS.settings||{};
  return [
    {type:'Profile',label:settings.profile||'Profile',value:`Workdir: ${settings.workdir||'default'}\nVoice: ${settings.voice||'default'}`,color:'#ffb02e'},
    ...(WS.projects||[]).map(x=>({type:'Projects',label:x.name,value:x.folder||'Project workspace',color:'#5ee7ff'})),
    ...(WS.memory||[]).map(x=>({type:'Memories',label:x.label,value:x.value,color:'#aa7cff'})),
    ...(WS.skills||[]).map(x=>({type:'Skills',label:x.name,value:x.instructions,color:'#55e6a5'}))
  ].slice(0,28);
}
function updateBrainDetail(item){
  const box=$('#brainDetail'); if(!box) return;
  if(!item){ box.innerHTML='<b>MEMORY</b><span>Click a node to inspect it.</span>'; return; }
  box.innerHTML=`<b>${esc(item.label)}</b><em>${esc(item.type)}</em><span>${esc(String(item.value||'').slice(0,260))}</span>`;
}
function selectBrainNode(index){
  if(!brainNodes.length) return;
  brainSelectedIndex=(index+brainNodes.length)%brainNodes.length;
  updateBrainDetail(brainNodes[brainSelectedIndex]?.item);
}
function drawMemoryBrain(){
  const canvas=$('#memoryCanvas'); if(!canvas||!WS)return;
  const rect=canvas.getBoundingClientRect();
  const dpr=Math.min(2,devicePixelRatio||1), cssW=Math.max(320,rect.width), cssH=Math.max(300,rect.height);
  if(canvas.width!==Math.round(cssW*dpr)||canvas.height!==Math.round(cssH*dpr)){ canvas.width=Math.round(cssW*dpr); canvas.height=Math.round(cssH*dpr); }
  const ctx=canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
  const w=cssW,h=cssH,cx=w/2,cy=h/2-8,items=memoryItems();
  brainMotion+=0.012; brainNodes=[];
  ctx.clearRect(0,0,w,h);
  const bg=ctx.createRadialGradient(cx,cy,4,cx,cy,Math.min(w,h)*.44);
  bg.addColorStop(0,'rgba(115,245,255,.95)'); bg.addColorStop(.16,'rgba(67,217,239,.52)'); bg.addColorStop(.58,'rgba(12,101,129,.10)'); bg.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=bg; ctx.beginPath(); ctx.arc(cx,cy,Math.min(w,h)*.44,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(2,12,18,.95)'; ctx.font='800 20px system-ui'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('MEMORY',cx,cy);
  const count=Math.max(items.length,1);
  items.forEach((item,i)=>{
    const base=(i/count)*Math.PI*2-Math.PI/2, wave=Math.sin(brainMotion+i*.7)*10, r=Math.min(w,h)*(0.23+((i%4)*0.055))+wave;
    const a=base+brainMotion*(i%2?-.18:.14), x=cx+Math.cos(a)*r, y=cy+Math.sin(a)*r;
    const selected=i===brainSelectedIndex;
    brainNodes.push({x,y,r:selected?10:8,item});
    ctx.strokeStyle=selected?'rgba(255,176,46,.72)':'rgba(75,232,255,.18)'; ctx.lineWidth=selected?2:1.2;
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(x,y); ctx.stroke();
    ctx.shadowBlur=selected?18:10; ctx.shadowColor=item.color; ctx.fillStyle=item.color;
    ctx.beginPath(); ctx.arc(x,y,selected?8:6,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
    ctx.fillStyle=selected?'#fff1bd':'rgba(220,246,255,.82)'; ctx.font=`${selected?'700':'600'} 13px system-ui`; ctx.textAlign='left';
    ctx.fillText(item.label.slice(0,24),x+12,y+4);
  });
  if(brainSelectedIndex<0&&items.length) selectBrainNode(0);
  if(!brainAnimation) brainAnimation=requestAnimationFrame(function loop(){ brainAnimation=requestAnimationFrame(loop); if(WS) drawMemoryBrain(); });
}
function brainNodeFromEvent(ev){
  const canvas=$('#memoryCanvas'); if(!canvas) return -1;
  const rect=canvas.getBoundingClientRect(); const x=ev.clientX-rect.left, y=ev.clientY-rect.top;
  return brainNodes.findIndex(n=>Math.hypot(n.x-x,n.y-y)<Math.max(18,n.r+8));
}
$('#memoryCanvas')?.addEventListener('click',ev=>{ const idx=brainNodeFromEvent(ev); if(idx>=0) selectBrainNode(idx); });
$('#brainPrev')?.addEventListener('click',()=>selectBrainNode(brainSelectedIndex-1));
$('#brainNext')?.addEventListener('click',()=>selectBrainNode(brainSelectedIndex+1));
async function loadWorkspace(){try{const r=await fetch('/api/workspace',{headers:apiHeaders()});WS=await r.json();renderWorkspace();}catch(e){log('error','WORKSPACE','could not load workspace');}}
window.addEventListener('resize',()=>{if(WS)drawMemoryBrain();});

// ── reactor state ──
function setState(cls, word, sub){
  document.body.classList.remove('running','speaking','listening','done','error');
  if (cls) document.body.classList.add(cls);
  if (word) $('#stword').textContent = word;
  if (sub != null) $('#strun').textContent = sub;
}
function setTag(cls, text){ const t=$('#rtag'); t.className='rtag '+cls; t.textContent=text; }
function setUserText(text){ const el=$('#userText'); if(el) el.textContent = text || ''; }

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
  await autoRemember(message);
  pendingLiveAttachmentParts = [];
  message = await attachVisualContext(message);
  message = attachUploadedContext(message);
  // With Live connected, typed and spoken turns share the same voice session.
  // Tool requests return through hermes_action; no second TTS voice overlaps it.
  if (liveReady && liveWs?.readyState === WebSocket.OPEN && !message.trim().startsWith('/')) {
    setUserText(message.trim().slice(0,90));
    const parts = [{text:message}, ...pendingLiveAttachmentParts];
    pendingLiveAttachmentParts = [];
    liveWs.send(JSON.stringify({clientContent:{turns:[{role:'user',parts}],turnComplete:true}}));
    return;
  }
  if (running){
    // don't silently swallow it — say so, so it never looks like nothing happened
    log('note','BUSY',`still working — "${message.slice(0,40)}" not sent. Wait, or press Esc to cancel.`);
    return;
  }
  showView('chat');
  running = true; answer = ''; firstDelta = false; speakThisRun = options.speak !== false;
  setUserText(message.trim().slice(0,90));

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
    if (!res.ok){
      const data=await res.json().catch(()=>({}));
      if(res.status===409 && data.message) throw new Error(data.message);
      throw new Error(data.error || `backend returned HTTP ${res.status}`);
    }
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
  await speakDone;                 // don't return until Zuzu has finished talking
}

function firstMediaReference(text){
  const body=String(text||'');
  const urls=[...body.matchAll(/https?:\/\/[^\s)>"']+/gi)].map(m=>m[0].replace(/[.,;]+$/,''));
  const uploadPath=[...body.matchAll(/(?:^|\s)([A-Za-z]:\\[^\n\r]+?\\uploads\\[^\s)>"']+\.(?:png|jpe?g|gif|webp|mp4|webm|ogg))/gi)].map(m=>m[1]);
  for(const path of uploadPath){
    const name=path.split(/\\+/).pop();
    if(name) return {kind:/\.(mp4|webm|ogg)$/i.test(name)?'video':'image', url:`/uploads/${encodeURIComponent(name)}`};
  }
  for(const url of urls){
    if(/\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(url)) return {kind:'image', url};
    if(/\.(mp4|webm|ogg)(\?|#|$)/i.test(url) || /(?:youtube\.com|youtu\.be)/i.test(url)) return {kind:'video', url};
  }
  return null;
}
async function showMediaFromAnswer(text){
  const media=firstMediaReference(text);
  if(!media) return;
  try{
    if(media.kind==='video'){
      showVideoUrl(media.url,'Zuzu video');
      log('complete','DISPLAY',`video shown: ${media.url}`);
      return;
    }
    const r=await fetch(media.url,{headers:apiHeaders()});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    showImageBlob(await r.blob(),'Zuzu picture');
    log('complete','DISPLAY',`picture shown: ${media.url}`);
  }catch(err){
    log('error','DISPLAY',String(err.message||err));
  }
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
      showMediaFromAnswer(answer);
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
   Click VOICE once. From then on: listen -> you stop -> transcribe -> Zuzu
   answers and speaks → it listens again, automatically. No re-clicking between
   turns. Click VOICE again (or press Esc) to end the conversation.

   Gemini Live stays full duplex while Zuzu speaks, so the user can interrupt.
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
  if (!response.ok){
    const data=await response.json().catch(()=>({}));
    throw new Error(response.status === 409 ? (data.message || 'An action is already running. Wait for its result.') : (data.error || `Action failed: HTTP ${response.status}`));
  }
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
      systemInstruction:{parts:[{text:auth.system || 'You are Zuzu. Speak warmly, naturally, briefly, and helpfully.'}]}
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
        $('#mic').classList.add('on'); $('#mic').textContent = 'Listening';
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
        setUserText(content.inputTranscription.text.slice(0,90));
        sendLiveVisualFrame(content.inputTranscription.text.slice(0,80));
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
    $('#mic').classList.add('on'); $('#mic').textContent = 'Listening';
    log('voice','VOICE','ElevenLabs voice conversation open · listening');
    beginTurn();
    return;
  }
  if (SpeechRecognition){
    convo = true; suppress = false;
    $('#mic').classList.add('on'); $('#mic').textContent = 'Listening';
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
  $('#mic').classList.remove('on'); $('#mic').textContent = 'Zuzu Voice';
  log('voice','VOICE','conversation closed');
  setState('', 'READY', '');
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
    if (shown) setUserText(shown.slice(0,90));
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
  setUserText('أنا سامعاك ' + '•'.repeat(Math.min(n,8)));
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
const PAYLOAD_COMMANDS = new Set(['/goal','/pc','/browser','/background','/mission','/personality','/connect','/music','/playlist','/remind']);
$('#cmds').addEventListener('click', e => {
  const b = e.target.closest('.cmd'); if (!b) return;
  const cmd = b.dataset.cmd;
  if (running){
    log('note','BUSY',`${cmd} not sent — Zuzu is still working.`);
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
  '/connect':'Say the account/app to connect, e.g. Gmail, Google Drive, Shopify, Spotify.',
  '/music':'Say what to play or find, e.g. “play chill Arabic music”.',
  '/playlist':'Say the playlist style, source, or mood.',
  '/remind':'Say what to follow up and when.',
  '/busy':'Tell me exactly what Zuzu or Hermes is doing right now.',
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
  $('#input').value = ''; $('#input').placeholder = 'Message Zuzu'; disarm(); $('#tip').textContent = defaultTip;
  log('send','SEND',`transmit: ${full}`);
  transmit(full);
}
$('#run').onclick = sendFromInput;
$('#mic').onclick = micToggle;
$('#showCommands').onclick = () => transmit('/commands', {speak:false});
$('#missionBtn').onclick = () => transmit('/mission', {speak:false});
$('#clearBtn').onclick = () => { answer=''; setUserText(''); $('#response').innerHTML='<span class="rplaceholder"></span>'; setState('', 'READY', ''); log('note','CLEAR','response panel cleared'); };
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

let lastActiveOperationText = '';

function describeActiveOperation(op){
  if (!op) return '';
  const label = op.label || op.kind || 'Zuzu task';
  const detail = op.detail ? ` — ${op.detail}` : '';
  const started = Number(op.started_ms || 0);
  const elapsed = started ? Math.max(1, Math.round((Date.now() - started) / 1000)) : 0;
  const suffix = elapsed ? ` · ${elapsed}s` : '';
  return `${label}${detail}${suffix}`;
}

function renderActiveOperation(op, source='status'){
  const text = describeActiveOperation(op);
  if (text){
    sys('brain', `Working · ${text}`, 'warn');
    setState('listening', 'WORKING', text.slice(0, 120));
    if (text !== lastActiveOperationText){
      lastActiveOperationText = text;
      log('note', 'BUSY', text);
    }
    return true;
  }
  if (lastActiveOperationText && source !== 'status'){
    log('note', 'READY', 'No active Zuzu/Hermes task is running.');
  }
  lastActiveOperationText = '';
  return false;
}

async function pollJobs(){
  if (jobPollInFlight){
    scheduleJobPoll();
    return;
  }
  jobPollInFlight = true;
  try {
    const j = await fetch('/api/jobs', {headers:apiHeaders()}).then(r => r.json());
    renderActiveOperation(j.active_operation, 'jobs');
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
  const hasActiveOperation = renderActiveOperation(s.active_operation, 'status');
  if (!hasActiveOperation) sys('brain', brain, s.runtime === 'mock' ? 'warn' : 'ok');
  sys('voice', `${sttLabel} / ${ttsLabel}`, (RT.browserStt||RT.stt) ? 'ok' : 'warn');
  sys('profile', s.profile || 'default');
  sys('runtime', brain, (s.runtime === 'mock' || (!hermesReady && !hermesChecking)) ? 'warn' : 'ok');
  sys('clock', now());
  $('#top-gw').textContent = 'Zuzu online';
  $('#top-hermes').textContent = `Hermes ${hermesLabel.toLowerCase()}`;
  $('#top-profile').textContent = 'Profile: ' + (s.profile || 'default');
  $('#top-voice').textContent = `${sttLabel} · ${ttsLabel}`;
  const activeText = describeActiveOperation(s.active_operation);
  const model = document.querySelector('#core-model'); if (model) model.textContent = activeText || s.model || brain;
  const tools = (s.tools || []).slice(0, 18);
  $('#toolsList').innerHTML = tools.length
    ? tools.map(t => `<span class="chip">${esc(t)}</span>`).join('')
    : `<div class="empty-state">${s.tools_pending ? 'Loading Hermes tools…' : 'No Hermes tools were reported.'}</div>`;
  if (!bootLogged){
    bootLogged = true;
    log('status','BOOT',`dashboard online · Hermes ${hermesLabel.toLowerCase()} · ${s.runtime} conversation · profile=${s.profile || 'default'}`);
    log('voice','VOICE',`channel ready — ${sttLabel} / ${ttsLabel}`);
  }
  $('#mic').textContent = RT.live ? 'Zuzu Voice' : (RT.stt ? 'Voice live' : 'Zuzu Voice');
  setState('', 'READY', '');
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
    $('#top-gw').textContent = 'Zuzu offline';
    $('#top-hermes').textContent = 'Hermes unknown';
    if (!bootLogged) log('error','STATUS','server unreachable');
  }
}
defaultTip = $('#tip').textContent;
loadWorkspace();
refreshStatus();


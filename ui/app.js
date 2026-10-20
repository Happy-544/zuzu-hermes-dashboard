/* Zuzu Live HUD — drives Hermes Agent, streams telemetry.

   The brain is your own `hermes` CLI/profile, so configured Hermes tools,
   browser automation, skills, memory, MCP servers and third-party connectors are live. */
const $ = s => document.querySelector(s);
const RT = {tts:false, stt:false, live:false, liveModel:'', browserStt:false, browserTts:false};
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechSynth = window.speechSynthesis;
const CSRF_TOKEN = document.querySelector('meta[name="zuzu-csrf"]')?.content || '';
const apiHeaders = extra => ({'x-zuzu-csrf': CSRF_TOKEN, ...(extra || {})});

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
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ── workspace navigation ──
// Five simple sections; each holds one or more pages.
const VIEW_GROUPS = {home:['chat'], day:['reminders','markets','library'], work:['projects','creative','missions','studio'], brain:['memory','skills'],
                     tools:['tools','autocad','calls'], settings:['settings','models','activity']};
const VIEW_NAMES = new Set(Object.values(VIEW_GROUPS).flat());
const groupOf = name => Object.keys(VIEW_GROUPS).find(group => VIEW_GROUPS[group].includes(name)) || 'home';
function showView(name, remember = true){
  if (VIEW_GROUPS[name]){
    let last = ''; try{ last = localStorage.getItem(`zuzu-page-${name}`) || ''; }catch(_){}
    name = VIEW_GROUPS[name].includes(last) ? last : VIEW_GROUPS[name][0];
  }
  if (!VIEW_NAMES.has(name)) name = 'chat';
  const group = groupOf(name);
  document.querySelectorAll('[data-view-panel]').forEach(panel => {
    const active = panel.dataset.viewPanel === name;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  document.querySelectorAll('[data-group]').forEach(button => {
    const active = button.dataset.group === group;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const subnav = $('#subnav');
  if (subnav){
    subnav.hidden = VIEW_GROUPS[group].length < 2;
    subnav.querySelectorAll('[data-sub]').forEach(button => {
      button.hidden = button.dataset.sub !== group;
      const active = button.dataset.view === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
  }
  if (remember){ try{ localStorage.setItem('jarvis-view', name); localStorage.setItem(`zuzu-page-${group}`, name); }catch(_){} }
  window.scrollTo({top:0, behavior:'auto'});
}
function bindNavigation(){
  document.querySelectorAll('[data-group],[data-view]').forEach(button => {
    if (button.dataset.navBound === '1') return;
    button.dataset.navBound = '1';
    button.addEventListener('click', () => showView(button.dataset.view || button.dataset.group));
  });
}
bindNavigation();
let savedView = 'chat'; try{ savedView = localStorage.getItem('jarvis-view') || 'chat'; }catch(_){}
showView(savedView, false);

// ── projects, settings, skills, memory and files ──
let WS = null;
const CAPABILITY_CATALOG = [
  {type:'tool', source:'Installed MCP', name:'AutoCAD MCP verified workflow', desc:'Inspect, edit, save, plot and verify the active AutoCAD drawing through the private File IPC bridge.', instructions:'For every AutoCAD task, use the installed autocad-mcp File IPC bridge. Inspect the active drawing and entity count first; state the planned edits; execute only the requested changes; save; then reopen or reread the output and verify its entity count and visible result. Never claim success from a command response alone and never change AutoCAD security settings automatically.'},
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

async function refreshCad(live=false){
  const badge=$('#cadLive'), summary=$('#cadSummary'), checks=$('#cadChecks'); if(!badge)return;
  badge.textContent=live?'CONNECTING':'CHECKING'; badge.className='live';
  try{const res=await fetch(`/api/autocad/status${live?'?live=1':''}`,{headers:apiHeaders()});const d=await res.json();if(!res.ok)throw new Error(d.error||`HTTP ${res.status}`);
    const rows=[['AutoCAD MCP installed',d.installed],['AutoCAD is open',d.autocad_open],['Private File IPC ready',d.ipc_ready],['Dispatcher connected',d.connected]];
    checks.innerHTML=rows.map(([name,ok])=>`<div class="cad-check ${ok?'ok':'off'}"><i></i><span>${esc(name)}</span><b>${ok?'Ready':'Not ready'}</b></div>`).join('');
    badge.textContent=d.connected?'CONNECTED':(d.autocad_open?'MCP OFFLINE':'AUTOCAD CLOSED');badge.classList.toggle('fault',!d.connected);
    summary.textContent=d.connected?'Zuzu can use the active drawing through Hermes.':d.autocad_open?'AutoCAD is open. Load mcp_dispatch.lsp, then check again.':'Open the drawing in AutoCAD, then press Check connection.';if(d.window)summary.textContent+=` ${d.window}`;
  }catch(err){badge.textContent='FAULT';badge.classList.add('fault');summary.textContent=String(err.message||err);}
}
function cadTaskPrompt(request){return `AUTO CAD TASK — use Zuzu's installed AutoCAD MCP runner through your terminal tool. Its exact command and supported tool groups are in your system context.\nRequest: ${request}\nRequired workflow: (1) call drawing info and entity count before editing; (2) explain the exact change plan; (3) execute only the requested changes through the runner; (4) call drawing save; (5) reread drawing info/entity count and request a screenshot or preview before reporting completion. Do not change AutoCAD or Windows security settings and do not execute arbitrary AutoLISP. If AutoCAD or mcp_dispatch.lsp is unavailable, report the exact failed step and recovery instruction.`;}
const workspaceRequest = async payload => {
  if(payload.action==='select_session'&&payload.sessionId){
    try{localStorage.setItem('zuzu-selected-chat',JSON.stringify({project_id:payload.projectId,chat_id:payload.sessionId}));}catch(_){}
  }
  if (['select_session','add_session','delete_session','delete_project'].includes(payload.action)) {
    persistLiveTurn();
    if (convo || liveConnecting) stopConvo();
  }
  const response = await fetch('/api/workspace', {
    method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  WS = data; renderWorkspace();
  if (['select_session','add_session','delete_session','delete_project'].includes(payload.action)) {
    try { localStorage.setItem('zuzu-selected-chat', JSON.stringify(chatRef())); } catch (_) {}
    answer=''; liveUserTurn=''; setUserText(''); renderAnswer(); await loadHistory();
  }
  return data;
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
  const chats=projects.flatMap(p=>(p.sessions||[]).map(s=>({...s,projectId:p.id,projectName:p.name})))
    .sort((a,b)=>(b.updated||b.created||0)-(a.updated||a.created||0));
  $('#conversationList').innerHTML=chats.map(s=>`<button type="button" data-chat-project="${esc(s.projectId)}" data-session="${esc(s.id)}" class="${s.id===WS.selectedSession&&s.projectId===WS.selectedProject?'selected':''}"><span>${esc(s.name)}</span><small>${esc(s.projectName)}</small></button>`).join('')||'<small>No conversations yet.</small>';
  $('#sessionContext').textContent = selected ? selected.name : 'Choose a project';
  $('#sessionList').innerHTML = (selected?.sessions||[]).map(s => `<div class="session-row ${s.id===WS.selectedSession?'selected':''}"><button data-session="${esc(s.id)}">${esc(s.name)}</button><button class="danger-link" data-delete-session="${esc(s.id)}">×</button></div>`).join('') || '<div class="empty-state">Create the first chat in this project.</div>';
  const settings=WS.settings||{};
  $('#conversationMode').value=settings.conversationMode||'hybrid';
  $('#voiceEngine').value=settings.voiceEngine||'gemini-live';
  $('#fallbackChain').value=(settings.fallbacks||[]).map(x=>`${x.provider}:${x.model}`).join('\n');
  renderModeOptions();
  renderProjectModelOptions();
  renderProviderSettings();
  $('#profileName').value=settings.profile||'default'; $('#workdir').value=settings.workdir||'~';
  $('#personaText').value=settings.persona||''; $('#computerControl').checked=!!settings.computerControl; $('#mobileControl').checked=!!settings.mobileControl;
  $('#shortcutName').value=settings.shortcutName||'Zuzu Control';
  $('#liveModel').value=settings.liveModel||''; $('#voiceSelect').value=settings.voice||'Kore';
  $('#skillList').innerHTML=(WS.skills||[]).map(s=>`<div class="list-card"><div><b>${esc(s.name)}</b><small>${esc(s.instructions.slice(0,120))}</small></div><button class="danger-link" data-delete-skill="${esc(s.id)}">Delete</button></div>`).join('')||'<div class="empty-state">No custom skills yet.</div>';
  $('#uploadList').innerHTML=(WS.uploads||[]).map(f=>`<div class="list-card"><div><b>${esc(f.name)}</b><small>${Math.max(1,Math.round(f.size/1024))} KB</small></div></div>`).join('')||'<div class="empty-state">No files uploaded.</div>';
  renderCapabilityCatalogue();
  drawMemoryBrain();
  renderCommandCenterWorkspace();
}
function providerLabel(provider){
  const direct=$('#conversationMode')?.value==='direct';
  return ({hermes:'Hermes profile default', gemini:direct?'Gemini':'Gemini for Hermes', openai:direct?'OpenAI':'OpenAI for Hermes', anthropic:direct?'Anthropic':'Anthropic for Hermes', openrouter:direct?'OpenRouter':'OpenRouter for Hermes', venice:direct?'Venice (uncensored)':'Venice (uncensored) for Hermes', ollama:direct?'Ollama local':'Ollama local for Hermes'}[provider] || String(provider||'Provider'));
}
function renderModeOptions(){
  if(!WS) return;
  const mode=$('#conversationMode').value||'hybrid';
  const descriptions={hybrid:'Gemini Live speaks naturally and sends actions, tools, private/current data and computer work to Hermes exactly once.',hermes:'Every text or voice turn goes straight to Hermes. Gemini Live does not join the conversation; browser/local voice reads Hermes replies.',direct:'The selected model answers alone. It has no Hermes session, tools, computer control or connected accounts.'};
  $('#modeDescription').textContent=descriptions[mode];
  const providers=Object.keys(WS.models||{}).filter(p=>mode!=='direct'||p!=='hermes');
  let selected=WS.settings?.provider||'gemini'; if(!providers.includes(selected)) selected='gemini';
  $('#providerSelect').innerHTML=providers.map(p=>`<option value="${esc(p)}" ${p===selected?'selected':''}>${esc(providerLabel(p))}</option>`).join('');
  renderModelOptions();
}
function renderModelOptions(){
  if(!WS) return; const provider=$('#providerSelect').value;
  const current=WS.settings?.provider===provider?WS.settings.model:'';
  const models=WS.models?.[provider]||[];
  $('#modelSelect').innerHTML=models.map(m=>`<option ${m===current?'selected':''}>${esc(m)}</option>`).join('');
  $('#customModel').value=models.includes(current)?'':current;
}
function renderProjectModelOptions(){
  if(!WS) return;
  const project=(WS.projects||[]).find(p=>p.id===WS.selectedProject)||{};
  const override=project.modelOverride||{};
  const providers=['inherit',...Object.keys(WS.models||{})];
  $('#projectProvider').innerHTML=providers.map(p=>`<option value="${esc(p)}" ${p===(override.provider||'inherit')?'selected':''}>${p==='inherit'?'Inherit global':esc(providerLabel(p))}</option>`).join('');
  renderProjectModels();
}
function renderProjectModels(){
  const provider=$('#projectProvider').value;
  const project=(WS.projects||[]).find(p=>p.id===WS.selectedProject)||{};
  const current=project.modelOverride?.model||'';
  if(provider==='inherit'){$('#projectModel').innerHTML='<option value="">Inherit global</option>'; $('#projectModel').disabled=true; return;}
  $('#projectModel').disabled=false;
  $('#projectModel').innerHTML=(WS.models?.[provider]||[]).map(m=>`<option value="${esc(m)}" ${m===current?'selected':''}>${esc(m)}</option>`).join('');
}
function renderProviderSettings(){
  const saved=WS.settings?.providerSettings||{};
  $('#providerSettings').innerHTML=Object.keys(WS.models||{}).filter(provider=>provider!=='hermes').map(provider=>{
    const item=saved[provider]||{}; const state=item.keyConfigured?'key set':'no key';
    return `<section class="provider-card" data-provider-card="${esc(provider)}"><header><b>${esc(providerLabel(provider).replace(' for Hermes',''))}</b><span class="${item.keyConfigured?'set':''}">${state}</span></header><div class="provider-fields"><label>Endpoint<input data-provider-endpoint value="${esc(item.endpoint||'')}" placeholder="Provider default"></label><label>Preferred model<input data-provider-model value="${esc(item.model||WS.models[provider]?.[0]||'')}" placeholder="default"></label><label>API key<input data-provider-key type="password" autocomplete="new-password" placeholder="${item.keyConfigured?'leave blank to keep':'add key'}"></label></div></section>`;
  }).join('');
}
function collectProviderSettings(){
  const providerSettings={},providerKeys={};
  document.querySelectorAll('[data-provider-card]').forEach(card=>{const p=card.dataset.providerCard;providerSettings[p]={endpoint:card.querySelector('[data-provider-endpoint]').value.trim(),model:card.querySelector('[data-provider-model]').value.trim()};const key=card.querySelector('[data-provider-key]').value.trim();if(key)providerKeys[p]=key;});
  return {providerSettings,providerKeys};
}
$('#conversationMode').onchange=renderModeOptions;
$('#providerSelect').onchange=renderModelOptions;
$('#projectProvider').onchange=renderProjectModels;
$('#modelForm').onsubmit=async e=>{e.preventDefault(); const s=WS.settings; const conversationMode=$('#conversationMode').value; const provider=$('#providerSelect').value; const model=$('#customModel').value.trim()||$('#modelSelect').value; const voiceEngine=$('#voiceEngine').value; const fallbacks=$('#fallbackChain').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean); const providers=collectProviderSettings(); const projectId=WS.selectedProject,projectProvider=$('#projectProvider').value,projectModel=$('#projectModel').value; await workspaceRequest({action:'save_settings',settings:{...s,conversationMode,voiceEngine,provider,model,fallbacks,...providers}}); await workspaceRequest({action:'set_project_model',projectId,provider:projectProvider,model:projectModel}); log('complete','MODEL ROUTING',`${conversationMode} · ${providerLabel(provider)} · ${model}`); refreshStatus();};
const addProject=()=>openEditor('New project',[{name:'name',label:'Project name'},{name:'folder',label:'Folder on this computer',placeholder:'C:\\Projects\\My project'}],v=>workspaceRequest({action:'add_project',...v}));
$('#addProject').onclick=addProject; $('#quickProject').onclick=()=>{showView('projects');addProject();};
$('#addSession').onclick=()=>openEditor('New chat',[{name:'name',label:'Chat name'}],v=>workspaceRequest({action:'add_session',projectId:WS.selectedProject,...v}));
$('#addSkill').onclick=()=>openEditor('Create skill',[{name:'name',label:'Skill name'},{name:'instructions',label:'Instructions',long:true}],v=>workspaceRequest({action:'add_skill',...v}));
$('#searchAllCapabilities')?.addEventListener('click',()=>searchHermesCatalogue('all'));
$('#searchGithubSkills')?.addEventListener('click',()=>searchHermesCatalogue('github'));
$('#searchHuggingFaceSkills')?.addEventListener('click',()=>searchHermesCatalogue('huggingface'));
$('#skillSearch')?.addEventListener('input',()=>renderCapabilityCatalogue());
$('#catalogueTabs')?.addEventListener('click',e=>{
  const b=e.target.closest('[data-catalogue-filter]'); if(!b) return;
  document.querySelectorAll('[data-catalogue-filter]').forEach(x=>x.classList.toggle('active',x===b));
  renderCapabilityCatalogue(b.dataset.catalogueFilter||'all');
});
$('#addMemory').onclick=()=>mgMemoryEditor('New memory',{},v=>workspaceRequest({action:'add_memory',...v}));
async function saveMemory(label,value){
  const clean = String(value||'').trim(); if(!clean) return false;
  await workspaceRequest({action:'add_memory',label:String(label||'Memory').slice(0,100),value:clean.slice(0,4000)});
  log('complete','MEMORY',`saved: ${String(label||'Memory').slice(0,40)}`);
  return true;
}
// Zuzu learns from every finished turn (typed or spoken): the server extracts lasting facts,
// adds or updates memories and announces what changed. Nothing is sent for /commands.
let lastUserTurn = '', liveUserTurn = '';
let liveAssistantTurn='', liveTurnId='', liveChat=null, voiceSaveQueue=Promise.resolve();
let lastVoiceSave='', liveReconnectAttempts=0;
function persistLiveTurn(finish=false){
  if(!liveChat||(!liveUserTurn.trim()&&!liveAssistantTurn.trim()))return voiceSaveQueue;
  if(!liveTurnId)liveTurnId=rid();
  const payload={...liveChat,turn_id:liveTurnId,user:liveUserTurn,assistant:liveAssistantTurn};
  const encoded=JSON.stringify(payload);
  if(finish){liveUserTurn='';liveAssistantTurn='';liveTurnId='';}
  if(encoded===lastVoiceSave)return voiceSaveQueue;
  lastVoiceSave=encoded;
  voiceSaveQueue=voiceSaveQueue.catch(()=>{}).then(async()=>{
    for(let attempt=0;attempt<3;attempt++){
      try{
        const r=await fetch('/api/conversation/turn',{method:'POST',headers:apiHeaders({'content-type':'application/json'}),body:encoded,keepalive:true});
        if(!r.ok)throw Error(`History save failed (${r.status})`);
        return;
      }catch(e){
        if(attempt===2){if(lastVoiceSave===encoded)lastVoiceSave='';log('error','SAVE','Voice transcript could not be saved. Keep this page open and reconnect.');throw e;}
        await new Promise(resolve=>setTimeout(resolve,700));
      }
    }
  });
  // Attach a rejection handler even when called from a socket callback.
  voiceSaveQueue.catch(()=>{});
  return voiceSaveQueue;
}
setInterval(()=>{if(liveReady)persistLiveTurn();},2000);
document.addEventListener('visibilitychange',()=>{if(document.hidden)persistLiveTurn();});
function autoRemember(user, assistant = '', source = 'chat'){
  if (window.calmSession && !window.calmSession.remember) return;   // Calm mode stays private unless allowed
  const text = String(user || '').trim();
  if (!text || text.startsWith('/')) return;
  fetch('/api/memory/observe', {method:'POST', headers:apiHeaders({'content-type':'application/json'}),
    body:JSON.stringify({user:text.slice(0,4000), assistant:String(assistant||'').slice(0,3000), source})})
    .then(() => { setTimeout(pollPersonalInbox, 2500); setTimeout(pollPersonalInbox, 9000); }).catch(() => {});
}
function askSkillSearch(source){
  const q=($('#skillSearch')?.value||'').trim();
  if(!q){ log('error','SKILLS','enter a skill search query first'); $('#skillSearch')?.focus(); return; }
  showView('chat');
  transmit(`Search ${source} for Hermes/Zuzu compatible capabilities about: ${q}. Include skills, plugins, MCP servers, tools, models, Hugging Face Spaces/models, GitHub projects, and Hermes catalogue options. Return a catalogue with source links, install requirements, risks, and how to add the chosen one to Zuzu. Do not install anything yet.`,{speak:false});
}
async function searchHermesCatalogue(source){
  const q=($('#skillSearch')?.value||'').trim();
  if(q.length<2){ log('error','SKILLS','enter at least 2 characters'); $('#skillSearch')?.focus(); return; }
  const grid=$('#catalogueGrid'); grid.innerHTML='<div class="empty-state">Searching Hermes skill registries…</div>';
  try{
    const r=await fetch(`/api/catalog/search?q=${encodeURIComponent(q)}&source=${encodeURIComponent(source)}`,{headers:apiHeaders()});
    const data=await r.json(); if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
    grid.innerHTML=(data.results||[]).map(item=>`<article class="catalogue-card"><div><span>${esc(item.kind||'skill')} · ${esc(item.source||'Hermes')}</span><b>${esc(item.name)}</b><small>${esc(item.identifier)} · ${esc(item.trust_level)}</small><p>${esc(item.description)}</p></div><div class="catalogue-actions"><button type="button" data-hermes-install="${esc(item.identifier)}" data-hermes-kind="${esc(item.kind||'skill')}">Install in Hermes</button></div></article>`).join('')||'<div class="empty-state">Hermes found no matching skills or plugins.</div>';
  }catch(error){grid.innerHTML=`<div class="empty-state">${esc(error.message||error)}</div>`;}
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
  const install=e.target.closest('[data-hermes-install]');
  if(install){
    const identifier=install.dataset.hermesInstall, kind=install.dataset.hermesKind||'skill';
    if(!confirm(`Install ${kind} ${identifier} into your Hermes profile? Plugins are installed disabled until you review and enable them in Hermes.`)) return;
    install.disabled=true;
    try{
      const r=await fetch('/api/catalog/install',{method:'POST',headers:apiHeaders({'content-type':'application/json'}),body:JSON.stringify({identifier,kind,confirmed:true})});
      const result=await r.json(); if(!r.ok) throw new Error(result.error||`HTTP ${r.status}`);
      log('complete','HERMES SKILL',`${result.identifier} installed`);
      install.textContent='Installed';
    }catch(error){log('error','HERMES SKILL',String(error.message||error));install.disabled=false;}
    return;
  }
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
  const b=e.target.closest('[data-project],[data-session],[data-delete-project],[data-delete-session],[data-delete-skill],[data-delete-memory],[data-edit-memory]'); if(!b||!WS)return;
  try{
    if(b.dataset.editMemory){
      const memory=(WS.memory||[]).find(m=>m.id===b.dataset.editMemory);
      if(memory){
        mgMemoryEditor('Edit memory',{label:memory.label,value:memory.value,tags:(memory.tags||[]).join(', ')},v=>workspaceRequest({action:'edit_memory',id:memory.id,...v}));
      }
      return;
    }
    if(b.dataset.project){ await workspaceRequest({action:'select_session',projectId:b.dataset.project,sessionId:''}); await loadHistory(); }
    if(b.dataset.session){ await workspaceRequest({action:'select_session',projectId:b.dataset.chatProject||WS.selectedProject,sessionId:b.dataset.session}); showView('chat'); await loadHistory(); }
    if(b.dataset.deleteProject) await workspaceRequest({action:'delete_project',id:b.dataset.deleteProject});
    if(b.dataset.deleteSession) await workspaceRequest({action:'delete_session',id:b.dataset.deleteSession});
    if(b.dataset.deleteSkill) await workspaceRequest({action:'delete_skill',id:b.dataset.deleteSkill});
    if(b.dataset.deleteMemory) await workspaceRequest({action:'delete_memory',id:b.dataset.deleteMemory});
  }catch(err){log('error','WORKSPACE',String(err.message||err));}
});
$('#saveSettings').onclick=async()=>{const s=WS.settings; await workspaceRequest({action:'save_settings',settings:{...s,profile:$('#profileName').value,workdir:$('#workdir').value,persona:$('#personaText').value,computerControl:$('#computerControl').checked,mobileControl:$('#mobileControl').checked,liveModel:$('#liveModel').value,voice:$('#voiceSelect').value,shortcutName:$('#shortcutName').value}}); log('complete','SETTINGS','agent settings saved'); refreshStatus();};
$('#signOut').onclick=async()=>{await fetch('/api/logout',{method:'POST',headers:apiHeaders({'content-type':'application/json'}),body:'{}'}).catch(()=>{});location.replace('/login.html');};
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
const isMobileClient=/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
$('#mobileCapability').textContent=isiOS?(standalone?'Installed as an iPhone app · Shortcuts control ready':'Open in Safari and choose Add to Home Screen'):'Apple Shortcuts control is available when this dashboard is opened on iPhone.';
function clientDeviceContext(){
  return {
    device_type: isMobileClient ? 'mobile' : 'desktop',
    platform: navigator.platform || '',
    user_agent: navigator.userAgent || '',
    standalone,
    url: location.href,
    screen: `${screen.width}x${screen.height}`,
    viewport: `${innerWidth}x${innerHeight}`,
    visual_kind: visualKind || '',
    visual_url: visualBrowserUrl || '',
    note: isMobileClient ? 'The user is controlling Zuzu from a mobile browser/PWA; laptop actions happen on the Windows host and should be shown back in the Zuzu core when useful.' : 'The user is controlling Zuzu from the desktop browser on the Windows host.'
  };
}
function clientContextSystemText(){
  const ctx=clientDeviceContext();
  return `Current Zuzu client context: device=${ctx.device_type}; platform=${ctx.platform}; standalone=${ctx.standalone}; viewport=${ctx.viewport}; page=${ctx.url}; current visual panel=${ctx.visual_kind||'none'} ${ctx.visual_url?`at ${ctx.visual_url}`:''}. ${ctx.note}`;
}
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
  if(frame){ frame.hidden=true; frame.removeAttribute('src'); frame.removeAttribute('srcdoc'); }
  if(empty){ empty.hidden=false; empty.innerHTML='Show laptop live screen, screenshot, picture, video, YouTube, browser, camera, or screen share.'; }
  if(visualObjectUrl){ URL.revokeObjectURL(visualObjectUrl); visualObjectUrl=''; }
  visualBrowserUrl='';
}
function stopVisualStream(){
  if (visualStream){ visualStream.getTracks().forEach(t=>t.stop()); visualStream=null; }
  if ($('#drawScreen')){ $('#drawScreen').hidden = true; $('#clearDrawing').hidden = true; setDrawMode(false); }
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
    if(visualKind!=='laptop-live') return;
    // Swap the frame in place: going through showImageBlob would stop this live timer.
    const img=$('#visualImage'), previous=visualObjectUrl;
    visualObjectUrl=URL.createObjectURL(blob);
    if(img){ img.src=visualObjectUrl; img.hidden=false; }
    ['#visualPreview','#visualFrame','#visualEmpty'].forEach(sel=>{ const el=$(sel); if(el) el.hidden=true; });
    if(previous) setTimeout(()=>URL.revokeObjectURL(previous), 2000);
    setVisualStatus('Laptop live'); setVisionBox(true); document.body.classList.add('vision-on');
  }catch(err){
    stopLaptopScreen();
    setVisualStatus('Laptop screen unavailable');
    log('error','LAPTOP',String(err.message||err));
  }
}
async function startLaptopLive(){
  stopVisualStream();
  visualKind='laptop-live';
  $('#drawScreen').hidden = false; $('#clearDrawing').hidden = false;
  setVisualStatus('Laptop live');
  setVisionBox(true); document.body.classList.add('vision-on');
  await refreshLaptopLive();
  laptopScreenTimer=setInterval(refreshLaptopLive, 1200);
}
function isProbablyDomain(text){
  return /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(String(text||'').trim());
}
function googleSearchUrl(query){
  return `https://www.google.com/search?igu=1&q=${encodeURIComponent(query)}`;
}
function youtubeSearchUrl(query){
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}
function isBlockedFrameUrl(url){
  try{
    const u=new URL(url, location.href);
    return /(^|\.)google\./i.test(u.hostname) || /(^|\.)youtube\.com$/i.test(u.hostname) || /(^|\.)youtu\.be$/i.test(u.hostname);
  }catch(_){ return false; }
}
function escapeAttr(value){
  return String(value||'').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function openExternalUrl(url){
  try{
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (opened) return true;
  }catch(_){}
  try{
    const a=document.createElement('a');
    a.href=url; a.target='_blank'; a.rel='noopener noreferrer';
    document.body.appendChild(a); a.click(); a.remove();
    return true;
  }catch(_){ return false; }
}
function launcherMarkup(url, status='Browser preview', opened=false){
  const safeUrl=escapeAttr(url), safeStatus=escapeAttr(status);
  const openedText = opened ? 'Opened in a real browser tab.' : 'Tap Open now to launch it in a real browser tab.';
  return `<div class="external-launcher"><b>${safeStatus}</b><span>${openedText}</span><small>${safeUrl}</small><a href="${safeUrl}" target="_blank" rel="noopener noreferrer">Open now</a><button type="button" data-copy-url="${safeUrl}">Copy link</button></div>`;
}
function showExternalLauncher(url, status='Browser preview', opened=false){
  const video=$('#visualPreview'), img=$('#visualImage'), frame=$('#visualFrame'), empty=$('#visualEmpty'), flip=$('#flipCamera');
  if(video){ video.hidden=true; video.removeAttribute('src'); video.srcObject=null; video.removeAttribute('data-active'); }
  if(img) img.hidden=true; if(flip) flip.hidden=true;
  if(frame){ frame.hidden=true; frame.removeAttribute('src'); frame.removeAttribute('srcdoc'); }
  if(empty){ empty.innerHTML=launcherMarkup(url, status, opened); empty.hidden=false; }
  setVisualStatus(status); setVisionBox(true); document.body.classList.add('vision-on');
}
function normalizeBrowserTarget(input, mode='google'){
  const raw=String(input||'').trim();
  if(!raw) return '';
  if(/^https?:\/\//i.test(raw)) return raw;
  if(isProbablyDomain(raw)) return `https://${raw}`;
  if(/^youtube\s*:/i.test(raw)) return youtubeSearchUrl(raw.replace(/^youtube\s*:/i,'').trim());
  if(/^google\s*:/i.test(raw)) return googleSearchUrl(raw.replace(/^google\s*:/i,'').trim());
  return mode === 'youtube' ? youtubeSearchUrl(raw) : googleSearchUrl(raw);
}
function setFrameUrl(url, status='Browser preview'){
  stopVisualStream(); visualKind='browser'; visualBrowserUrl=url;
  const video=$('#visualPreview'), img=$('#visualImage'), frame=$('#visualFrame'), empty=$('#visualEmpty'), flip=$('#flipCamera');
  if(video){ video.hidden=true; video.removeAttribute('src'); video.srcObject=null; video.removeAttribute('data-active'); }
  if(img) img.hidden=true; if(flip) flip.hidden=true; if(empty) empty.hidden=true;
  if(frame){ frame.removeAttribute('srcdoc'); frame.src=url; frame.hidden=false; }
  setVisualStatus(status); setVisionBox(true); document.body.classList.add('vision-on');
}
function showSearchResultsPanel(data, mode='web'){
  const best=data.best || (data.results||[])[0];
  const title=mode==='youtube'?'YouTube results':'Browser results';
  const rows=(data.results||[]).map((r,i)=>`<button type="button" data-open-result="${escapeAttr(r.embed||r.url)}" data-result-mode="${mode}"><b>${i+1}. ${escapeAttr(r.title||r.url)}</b><small>${escapeAttr(r.url)}</small></button>`).join('');
  const html=`<div class="external-launcher search-results"><b>${title}</b><span>${escapeAttr(data.query||'')}</span>${rows||'<span>No results</span>'}</div>`;
  const video=$('#visualPreview'), img=$('#visualImage'), frame=$('#visualFrame'), empty=$('#visualEmpty'), flip=$('#flipCamera');
  if(video) video.hidden=true; if(img) img.hidden=true; if(flip) flip.hidden=true; if(frame) frame.hidden=true;
  if(empty){ empty.innerHTML=html; empty.hidden=false; }
  setVisualStatus(title); setVisionBox(true); document.body.classList.add('vision-on');
  if(best){
    if(mode==='youtube' && best.embed) setFrameUrl(best.embed, best.title || 'YouTube video');
    else showExternalLauncher(best.url, best.title || 'Browser result', false);
  }
}
async function resolveAndShowYoutube(queryOrUrl, status='Video / YouTube'){
  if(!queryOrUrl) return;
  const raw=String(queryOrUrl).trim();
  if(/^https?:\/\//i.test(raw)){
    const embed=youtubeEmbedUrl(raw);
    if(embed && embed !== raw) setFrameUrl(embed, status);
    else showExternalLauncher(raw, status, false);
    return;
  }
  setVisualStatus('Searching YouTube…'); setVisionBox(true); document.body.classList.add('vision-on');
  try{
    const r=await fetch(`/api/youtube-search?q=${encodeURIComponent(raw)}`,{headers:apiHeaders()});
    const data=await r.json(); if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
    showSearchResultsPanel(data,'youtube');
    log('complete','YOUTUBE',`opened ${data.best?.title||raw}`);
  }catch(err){
    const url=youtubeSearchUrl(raw);
    showExternalLauncher(url, 'YouTube search', openExternalUrl(url));
    log('error','YOUTUBE',String(err.message||err));
  }
}
async function resolveAndShowBrowser(queryOrUrl, status='Browser preview'){
  if(!queryOrUrl) return;
  const raw=String(queryOrUrl).trim();
  if(/^https?:\/\//i.test(raw) || isProbablyDomain(raw)){
    const url=normalizeBrowserTarget(raw,'google');
    showExternalLauncher(url, status, openExternalUrl(url));
    return;
  }
  setVisualStatus('Searching web…'); setVisionBox(true); document.body.classList.add('vision-on');
  try{
    const r=await fetch(`/api/web-search?q=${encodeURIComponent(raw)}`,{headers:apiHeaders()});
    const data=await r.json(); if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
    showSearchResultsPanel(data,'web');
    log('complete','BROWSER',`found ${data.best?.title||raw}`);
  }catch(err){
    const url=googleSearchUrl(raw);
    showExternalLauncher(url, 'Google search', openExternalUrl(url));
    log('error','BROWSER',String(err.message||err));
  }
}
function showBrowserUrl(url, status='Browser preview'){ return resolveAndShowBrowser(url, status); }
function showVideoUrl(url, status='Video / YouTube'){
  if(!url) return;
  const lower=String(url).toLowerCase();
  if(/\.(mp4|webm|ogg)(\?|#|$)/i.test(lower)){
    stopVisualStream(); visualKind='remote-video'; visualBrowserUrl=url;
    const video=$('#visualPreview'), img=$('#visualImage'), frame=$('#visualFrame'), empty=$('#visualEmpty'), flip=$('#flipCamera');
    if(img) img.hidden=true; if(flip) flip.hidden=true; if(empty) empty.hidden=true; if(frame) frame.hidden=true;
    if(video){ video.src=url; video.srcObject=null; video.dataset.active='1'; video.hidden=false; video.controls=true; video.loop=false; }
    setVisualStatus(status); setVisionBox(true); document.body.classList.add('vision-on');
    return;
  }
  return resolveAndShowYoutube(url, status);
}
function requestLaptopPicture(){
  transmit('/pc Take a screenshot or create/find the picture you want to show me from the laptop, save it if needed, and return a direct file path or URL. Describe what I should judge, then ask me what I think.',{speak:false});
}
function requestLaptopVideo(){
  const raw=prompt('Show YouTube/video in Zuzu core. Paste a URL or type a search:', '');
  if(raw && raw.trim()){
    showVideoUrl(raw.trim(), /^https?:\/\//i.test(raw.trim()) ? 'Video / YouTube' : 'YouTube search');
    log('status','VIDEO',`searching/showing ${raw.trim()}`);
    return;
  }
  transmit('/pc Find or open the video/YouTube item relevant to my current request and return the direct URL so the dashboard can display it to me. If you cannot open it directly, return the best URL and explain why.',{speak:false});
}
function openBrowserPreview(){
  const raw=prompt('Open browser view inside Zuzu core. Enter a URL or search words:', '');
  if(!raw) return;
  showBrowserUrl(raw.trim(), 'Browser search');
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
document.addEventListener('click', e => {
  const b=e.target.closest('[data-copy-url]');
  if(!b) return;
  const url=b.getAttribute('data-copy-url')||'';
  navigator.clipboard?.writeText(url).then(()=>log('complete','COPY','link copied')).catch(()=>log('error','COPY','copy failed'));
});
document.addEventListener('click', e => {
  const b=e.target.closest('[data-open-result]');
  if(!b) return;
  const url=b.getAttribute('data-open-result')||'';
  const mode=b.getAttribute('data-result-mode')||'web';
  if(mode==='youtube') setFrameUrl(url, 'YouTube video');
  else showExternalLauncher(url, 'Browser result', openExternalUrl(url));
});
$('#dockLaptop')?.addEventListener('click',requestLaptopScreen);
$('#dockImage')?.addEventListener('click',showLaptopSnapshot);
$('#dockVideo')?.addEventListener('click',requestLaptopVideo);
$('#dockBrowser')?.addEventListener('click',openBrowserPreview);
$('#flipCamera')?.addEventListener('click',flipCamera);
$('#stopVisual')?.addEventListener('click',stopVisualStream);
document.querySelectorAll('.generate-btn').forEach(b=>b.onclick=async()=>{const type=b.dataset.media,prompt=$(`#${type}Prompt`).value.trim();if(!prompt)return;b.disabled=true;const label=b.textContent;b.textContent='Creating…';try{ type==='video'?await createVideo(prompt):await createImage(prompt); }catch(err){showToast(String(err.message||err),'error');}finally{b.disabled=false;b.textContent=label;}});
// ── memory graph (Obsidian-style; engine in memory-graph.js) ──
const MG = {graph:null, engine:null, selected:'', local:false, depth:1, query:'', hidden:new Set(), opts:{tags:true, smart:true, mentions:true, orphans:true}};
try{ const saved=JSON.parse(localStorage.getItem('zuzu-memory-graph')||'{}'); if(saved.hidden) MG.hidden=new Set(saved.hidden); Object.assign(MG.opts, saved.opts||{}); MG.labels=saved.labels!==false; }catch(_){ MG.labels=true; }
function mgRemember(){ try{ localStorage.setItem('zuzu-memory-graph', JSON.stringify({hidden:[...MG.hidden], opts:MG.opts, labels:MG.labels})); }catch(_){} }
function mgMatches(n, q){
  if(!q) return true;
  if(q.startsWith('#')) return n.tags.includes(q.slice(1)) || n.id===`t:${q.slice(1)}`;
  return `${n.label}\n${n.text}\n${n.tags.map(t=>'#'+t).join(' ')}`.toLowerCase().includes(q);
}
function mgVisible(){
  const g=MG.graph; if(!g) return {nodes:[], links:[]};
  let keep=g.nodes.filter(n=>!MG.hidden.has(n.group));
  if(MG.local && MG.selected && g.byId.has(MG.selected)){ const ids=localIds(g, MG.selected, MG.depth); keep=keep.filter(n=>ids.has(n.id)); }
  const ids=new Set(keep.map(n=>n.id));
  return {nodes:keep, links:g.links.filter(l=>ids.has(l.source)&&ids.has(l.target))};
}
function drawMemoryBrain(){
  const canvas=$('#memoryCanvas'); if(!canvas||!WS||typeof buildMemoryGraph!=='function') return;
  MG.graph=buildMemoryGraph(WS, MG.opts);
  if(!MG.engine){
    MG.engine=new ForceGraph(canvas,{
      onSelect:n=>{ if(n) mgOpen(n.id); },
      onOpen:n=>{ mgOpen(n.id); mgSetLocal(true); },
      onHover:(n,x,y)=>mgTip(n,x,y)
    });
  }
  MG.engine.labels=MG.labels;
  if(MG.selected && !MG.graph.byId.has(MG.selected)) MG.selected='';
  const view=mgVisible(); MG.engine.setData(view.nodes, view.links, {reheat:.35});
  mgApplySearch(); mgRenderSide(); mgRenderStats(view);
  if(!MG.selected){ const first=MG.graph.nodes.find(n=>n.group==='memory')||MG.graph.nodes[0]; if(first) mgOpen(first.id,{center:false}); }
  else mgOpen(MG.selected,{center:false});
}
function mgApplySearch(){
  if(!MG.engine||!MG.graph) return;
  const q=MG.query.trim().toLowerCase();
  MG.engine.highlight=q ? new Set(MG.graph.nodes.filter(n=>mgMatches(n,q)).map(n=>n.id)) : null;
  MG.engine.draw();
}
function mgRenderStats(view){
  const box=$('#mgStats'); if(!box) return;
  const notes=view.nodes.filter(n=>n.group!=='tag'&&n.group!=='ghost').length;
  box.textContent=`${notes} notes · ${view.links.length} links${MG.local?` · local ${MG.depth} hop${MG.depth>1?'s':''}`:''}`;
}
function mgRenderSide(){
  const g=MG.graph; if(!g) return;
  const counts={}; g.nodes.forEach(n=>counts[n.group]=(counts[n.group]||0)+1);
  $('#mgFilters').innerHTML=Object.keys(MG_GROUP_NAMES).filter(k=>counts[k]).map(k=>`<button type="button" class="mg-chip ${MG.hidden.has(k)?'off':''}" data-mg-group="${k}" aria-pressed="${!MG.hidden.has(k)}"><i style="background:${MG_COLORS[k]}"></i>${esc(MG_GROUP_NAMES[k])}<small>${counts[k]}</small></button>`).join('');
  $('#mgLegend').innerHTML=Object.keys(MG_GROUP_NAMES).filter(k=>counts[k]&&!MG.hidden.has(k)).map(k=>`<span><i style="background:${MG_COLORS[k]}"></i>${esc(MG_GROUP_NAMES[k])}</span>`).join('');
  const q=MG.query.trim().toLowerCase();
  const order=['memory','hermes','project','skill','you','ghost','tag'];
  const groups=order.map(k=>[k,g.nodes.filter(n=>n.group===k&&mgMatches(n,q)).sort((a,b)=>(b.updated||b.created||0)-(a.updated||a.created||0)||a.label.localeCompare(b.label))]).filter(([,list])=>list.length);
  $('#mgList').innerHTML=groups.map(([k,list])=>`<div class="mg-group"><div class="mg-group-head"><i style="background:${MG_COLORS[k]}"></i>${esc(MG_GROUP_NAMES[k])}<small>${list.length}</small></div>${list.slice(0,k==='tag'?40:120).map(n=>`<button type="button" class="mg-item ${n.id===MG.selected?'active':''}" data-mg-open="${esc(n.id)}"><b>${esc(n.label)}</b>${n.group!=='tag'&&n.text?`<small>${esc(n.text.replace(/\s+/g,' ').slice(0,90))}</small>`:''}</button>`).join('')}</div>`).join('')
    || `<div class="empty-state">${q?'No notes match.':'No memories yet. Add your first one.'}</div>`;
}
function mgTip(n,x,y){
  const tip=$('#mgTip'); if(!tip) return;
  if(!n){ tip.hidden=true; return; }
  tip.innerHTML=`<b>${esc(n.label)}</b><em>${esc(MG_GROUP_NAMES[n.group])} · ${n.degree} link${n.degree===1?'':'s'}</em>${n.text?`<span>${esc(n.text.replace(/\s+/g,' ').slice(0,140))}</span>`:''}`;
  tip.hidden=false;
  const stage=tip.parentElement.getBoundingClientRect();
  tip.style.left=`${Math.min(x+14, stage.width-250)}px`; tip.style.top=`${Math.min(y+14, stage.height-110)}px`;
}
function mgNoteLinks(n){
  const g=MG.graph, out=[], back=[], related=[];
  for(const l of g.links){
    if(l.kind==='home') continue;
    const other=l.source===n.id?l.target:l.target===n.id?l.source:null; if(!other) continue;
    const o=g.byId.get(other); if(!o||o.group==='tag') continue;
    if(l.kind==='related') related.push(o);
    else if(l.source===n.id) out.push(o); else back.push(o);
  }
  return {out, back, related};
}
function mgOpen(id,{center=true}={}){
  const g=MG.graph; if(!g) return;
  const n=g.byId.get(id); if(!n) return;
  MG.selected=id;
  if(MG.local){ const view=mgVisible(); MG.engine.setData(view.nodes,view.links,{reheat:.5}); mgRenderStats(view); }
  MG.engine?.select(MG.engine.nodes.find(x=>x.id===id)||null,{center});
  document.querySelectorAll('#mgList .mg-item').forEach(b=>b.classList.toggle('active',b.dataset.mgOpen===id));
  const box=$('#brainDetail'); if(!box) return;
  const {out,back,related}=mgNoteLinks(n);
  const chips=list=>list.length?list.map(o=>`<button type="button" class="mg-ref" data-mg-open="${esc(o.id)}"><i style="background:${o.color}"></i>${esc(o.label)}</button>`).join(''):'<span class="mg-none">None yet</span>';
  const when=n.updated||n.created; const date=when?new Date(when*1000).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):'';
  const actions=n.group==='memory'
    ? `<button type="button" class="secondary-btn" data-edit-memory="${esc(n.ref)}">Edit</button><button type="button" class="secondary-btn" data-mg-link-new="${esc(n.label)}">+ Linked note</button><button type="button" class="danger-link" data-delete-memory="${esc(n.ref)}">Delete</button>`
    : n.group==='ghost' ? `<button type="button" class="primary-btn" data-mg-create="${esc(n.label)}">Create this note</button>`
    : n.group==='tag' ? `<button type="button" class="secondary-btn" data-mg-tag="${esc(n.label.slice(1))}">Show all ${esc(n.label)}</button>` : '';
  const body=n.group==='tag'
    ? `<p>${g.links.filter(l=>l.target===n.id||l.source===n.id).length} notes use this tag.</p>`
    : renderNoteMarkdown(n.text, esc);
  box.innerHTML=`<div class="mg-note-head"><span class="mg-type" style="--c:${n.color}">${esc(MG_GROUP_NAMES[n.group])}</span>${date?`<small>${esc(date)}</small>`:''}</div>
    <h2 class="mg-title">${esc(n.label)}</h2>
    ${n.tags.length?`<div class="mg-tags">${n.tags.map(t=>`<button type="button" class="mg-tag" data-mg-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>`:''}
    ${n.group==='memory'&&(n.auto||n.history.length)?`<div class="mg-learned">🧠 ${n.auto?`Learned by Zuzu from ${n.source==='voice'?'voice':'chat'}`:'Written by you'}${n.history.length?` · updated ${n.history.length}×`:''}</div>`:''}
    <div class="mg-body">${body}</div>
    ${n.history.length?`<details class="mg-history"><summary>Earlier versions (${n.history.length})</summary>${n.history.slice().reverse().map(h=>`<p><small>${esc(new Date(h.at*1000).toLocaleDateString())}</small>${esc(h.value)}</p>`).join('')}</details>`:''}
    ${actions?`<div class="mg-actions">${actions}<button type="button" class="secondary-btn" data-mg-ask="${esc(n.id)}">Ask Zuzu</button></div>`:`<div class="mg-actions"><button type="button" class="secondary-btn" data-mg-ask="${esc(n.id)}">Ask Zuzu</button></div>`}
    <div class="mg-section"><h3>Links <small>${out.length}</small></h3><div class="mg-refs">${chips(out)}</div></div>
    <div class="mg-section"><h3>Backlinks <small>${back.length}</small></h3><div class="mg-refs">${chips(back)}</div></div>
    ${MG.opts.smart?`<div class="mg-section"><h3>Related <small>${related.length}</small></h3><div class="mg-refs">${chips(related)}</div></div>`:''}`;
}
function mgSetLocal(on){
  MG.local=!!on && !!MG.selected;
  const b=$('#mgLocal'); if(b){ b.classList.toggle('active',MG.local); b.setAttribute('aria-pressed',String(MG.local)); }
  const view=mgVisible(); MG.engine?.setData(view.nodes,view.links,{reheat:.6}); mgRenderStats(view);
  if(MG.engine){ MG.engine.touched=false; MG.engine.autoFit=true; }
}
function selectBrainNode(index){
  const list=(MG.engine?.nodes||[]).filter(n=>n.group!=='tag');
  if(!list.length) return;
  const cur=list.findIndex(n=>n.id===MG.selected);
  const next=list[((typeof index==='number'?index:cur+1)+list.length)%list.length];
  mgOpen(next.id);
}
function mgMemoryEditor(title, values={}, onSave){
  openEditor(title,[{name:'label',label:'Title'},{name:'value',label:'Note — link other notes with [[Title]], tag with #tag',long:true},{name:'tags',label:'Tags (comma separated)',placeholder:'family, health, work'}],onSave);
  for(const [k,v] of Object.entries(values)){ const f=editorFields.querySelector(`[name="${k}"]`); if(f) f.value=v; }
}
$('#memoryCanvas')?.closest('[data-view-panel]')?.addEventListener('click',async e=>{
  const t=e.target.closest('[data-mg-open],[data-mg-open-name],[data-mg-group],[data-mg-tag],[data-mg-create],[data-mg-link-new],[data-mg-ask]'); if(!t) return;
  if(t.dataset.mgOpen){ mgOpen(t.dataset.mgOpen); return; }
  if(t.dataset.mgOpenName){ const n=MG.graph?.nodes.find(x=>x.label.toLowerCase()===t.dataset.mgOpenName.toLowerCase()); if(n) mgOpen(n.id); return; }
  if(t.dataset.mgGroup){ const k=t.dataset.mgGroup; MG.hidden.has(k)?MG.hidden.delete(k):MG.hidden.add(k); mgRemember(); drawMemoryBrain(); return; }
  if(t.dataset.mgTag){ MG.query='#'+t.dataset.mgTag; $('#mgSearch').value=MG.query; mgApplySearch(); mgRenderSide(); const tag=MG.graph?.byId.get(`t:${t.dataset.mgTag}`); if(tag) mgOpen(tag.id); return; }
  if(t.dataset.mgCreate){ mgMemoryEditor('New memory',{label:t.dataset.mgCreate},v=>workspaceRequest({action:'add_memory',...v})); return; }
  if(t.dataset.mgLinkNew){ mgMemoryEditor('New linked memory',{value:`Related to [[${t.dataset.mgLinkNew}]]. `},v=>workspaceRequest({action:'add_memory',...v})); return; }
  if(t.dataset.mgAsk){
    const n=MG.graph?.byId.get(t.dataset.mgAsk); if(!n) return;
    showView('chat');
    transmit(`Use my saved memory note "${n.label}" (${MG_GROUP_NAMES[n.group]}): ${n.text.slice(0,1500)}\n\nTell me what you know about this, how it connects to my other memories, and anything I should add or update.`,{speak:false});
  }
});
$('#mgSearch')?.addEventListener('input',e=>{ MG.query=e.target.value; mgApplySearch(); mgRenderSide(); });
$('#mgSearch')?.addEventListener('keydown',e=>{ if(e.key==='Enter'){ const first=$('#mgList [data-mg-open]'); if(first) mgOpen(first.dataset.mgOpen); } });
[['#mgTags','tags'],['#mgSmart','smart'],['#mgOrphans','orphans']].forEach(([sel,key])=>{ const box=$(sel); if(!box) return; box.checked=MG.opts[key]!==false; box.addEventListener('change',()=>{ MG.opts[key]=box.checked; mgRemember(); drawMemoryBrain(); }); });
$('#mgAuto')?.addEventListener('change',e=>personalRequest({action:'save_settings',settings:{autoMemory:e.target.checked}}).then(()=>showToast(e.target.checked?'Zuzu will learn from your conversations':'Auto-learn is off','info')).catch(err=>showToast(String(err.message||err),'error')));
if($('#mgLabels')){ $('#mgLabels').checked=MG.labels; $('#mgLabels').addEventListener('change',e=>{ MG.labels=e.target.checked; mgRemember(); if(MG.engine){ MG.engine.labels=MG.labels; MG.engine.draw(); } }); }
$('#mgZoomIn')?.addEventListener('click',()=>MG.engine?.zoomBy(1.3));
$('#mgZoomOut')?.addEventListener('click',()=>MG.engine?.zoomBy(1/1.3));
$('#mgFit')?.addEventListener('click',()=>MG.engine?.fit());
$('#mgLocal')?.addEventListener('click',()=>mgSetLocal(!MG.local));
$('#mgDepth')?.addEventListener('change',e=>{ MG.depth=Number(e.target.value)||1; if(MG.local) mgSetLocal(true); });
$('#mgAsk')?.addEventListener('click',()=>{ showView('chat'); transmit('Review my Zuzu memory notes. Suggest merges for duplicates, missing [[links]] between related notes, useful #tags, and anything outdated. Show the proposed changes as a list and wait for my OK before saving.',{speak:false}); });
$('#brainPrev')?.addEventListener('click',()=>{ const list=(MG.engine?.nodes||[]).filter(n=>n.group!=='tag'); const cur=list.findIndex(n=>n.id===MG.selected); selectBrainNode(cur-1); });
$('#brainNext')?.addEventListener('click',()=>selectBrainNode());
document.addEventListener('keydown',e=>{
  if($('[data-view-panel="memory"]')?.hidden) return;
  if(e.target.closest('input,textarea,select,dialog')) return;
  if(e.key==='/'){ e.preventDefault(); $('#mgSearch')?.focus(); }
  else if(e.key==='ArrowRight') $('#brainNext')?.click();
  else if(e.key==='ArrowLeft') $('#brainPrev')?.click();
  else if(e.key.toLowerCase()==='l') mgSetLocal(!MG.local);
  else if(e.key.toLowerCase()==='f') MG.engine?.fit();
});
new MutationObserver(()=>{ if(MG.engine && !$('[data-view-panel="memory"]').hidden){ MG.engine.resize(); MG.engine.kick(.05); setTimeout(()=>MG.engine.fit(),60); } }).observe($('[data-view-panel="memory"]'),{attributes:true,attributeFilter:['hidden']});
function chatRef(){return {project_id:WS?.selectedProject,chat_id:WS?.selectedSession};}
function sameChat(ref){return ref.project_id===WS?.selectedProject&&ref.chat_id===WS?.selectedSession;}
async function newConversation(){
  await workspaceRequest({action:'add_session',projectId:WS.selectedProject,name:'New chat'});
  showView('chat'); $('#input').focus();
}
$('#newConversation').onclick=()=>newConversation().catch(e=>showToast(e.message,'error'));
if(matchMedia('(max-width:980px)').matches)$('.conversation-nav').open=false;
async function loadWorkspace(){
  try{
    const r=await fetch('/api/workspace',{headers:apiHeaders()}); const data=await r.json();
    if(!r.ok)throw Error(data.error||`HTTP ${r.status}`);
    let remembered=WS?chatRef():null;
    if(!remembered){try{remembered=JSON.parse(localStorage.getItem('zuzu-selected-chat'));}catch(_){}}
    if(data.projects.some(p=>p.id===remembered?.project_id&&p.sessions?.some(s=>s.id===remembered.chat_id))){
      data.selectedProject=remembered.project_id; data.selectedSession=remembered.chat_id;
    }
    WS=data; renderWorkspace(); await loadHistory();
  }catch(e){log('error','WORKSPACE',`Could not load workspace: ${e.message||e}`);}
}
let historyLoading=false, recoveredRun='';
async function loadHistory(){
  const box=$('#chatHistory'); if(!box||!WS)return;
  const ref=chatRef();
  try{
    const r=await fetch('/api/history?'+new URLSearchParams(ref),{headers:apiHeaders(),cache:'no-store'});
    const data=await r.json(); if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
    if(!sameChat(ref))return;
    const follow=box.scrollHeight-box.scrollTop-box.clientHeight<70;
    const latest=data.runs?.[0], active=latest?.state==='running';
    box.innerHTML=(data.messages||[]).map(m=>`<div dir="auto" class="history-message ${m.role==='user'?'user':'assistant'}"><b>${m.role==='user'?'You':'Zuzu'}</b>${esc(typeof m.content==='string'?m.content:'[media or tool content]')}</div>`).join('')||'<div class="empty-state">Start a conversation. Text, voice and action results are saved here.</div>';
    if(latest && latest.state!=='complete')box.innerHTML+=`<div class="chat-run ${esc(latest.state)}" role="status">${active?'Working':'Action stopped'} · ${esc(latest.detail)}${active?' · '+Math.floor(Date.now()/1000-latest.started)+'s':''}${active&&latest.answer?'<p dir="auto">'+esc(latest.answer)+'</p>':''}</div>`;
    if(data.warning)box.innerHTML+=`<div class="empty-state">${esc(data.warning)}</div>`;
    if(follow)box.scrollTop=box.scrollHeight;
    if(!running&&!liveReady&&latest?.state==='complete'&&recoveredRun!==latest.id){
      recoveredRun=latest.id; answer=latest.answer||'';renderAnswer();
    }
  }catch(error){if(sameChat(ref))log('error','HISTORY',String(error.message||error));}
}
setInterval(async()=>{
  if(document.hidden||historyLoading||!WS)return;
  historyLoading=true;try{await loadHistory();}finally{historyLoading=false;}
},4000);

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

function browserIntentFromMessage(message){
  const text=String(message||'').trim();
  const lower=text.toLowerCase();
  let m=text.match(/^\/browser\s+(.+)/i);
  if(m) return {mode:'google', query:m[1].trim(), reason:'slash browser'};
  m=text.match(/^\/music\s+(.+)/i);
  if(m) return {mode:'youtube', query:m[1].trim(), reason:'music'};
  m=text.match(/^\/playlist\s+(.+)/i);
  if(m) return {mode:'youtube', query:m[1].trim(), reason:'playlist'};
  m=text.match(/(?:search|google|ابحث|دور|سيرش|اعملي سيرش|اعمل سيرش)(?:\s+(?:for|عن|على|في))?\s+(.+)/i);
  if(m) return {mode:/youtube|يوتيوب/i.test(text)?'youtube':'google', query:m[1].trim(), reason:'search'};
  m=text.match(/(?:youtube|يوتيوب).*?(?:for|عن|على)?\s+(.+)/i);
  if(m) return {mode:'youtube', query:m[1].trim(), reason:'youtube'};
  if(/(?:شغلي|شغل|play)\s+/.test(lower) && /(?:اغنية|أغنية|song|music|عمرو|amr|diab)/i.test(text)){
    return {mode:'youtube', query:text.replace(/^\/music\s*/i,'').trim(), reason:'music'};
  }
  return null;
}
function maybeOpenRequestedBrowserPreview(message){
  const intent=browserIntentFromMessage(message);
  if(!intent || !intent.query) return '';
  if(intent.mode==='youtube') showVideoUrl(intent.query, 'YouTube search');
  else showBrowserUrl(intent.query, 'Google search');
  return `Zuzu is opening a ${intent.mode === 'youtube' ? 'YouTube video/search' : 'browser search'} for the user inside the visual panel using this query: ${intent.query}. Use it as visible context and do not claim nothing opened unless the resolver reports an error.`;
}

let dispatchReserved = false;
async function transmit(message, options = {}){
  if (!message.trim()) return;
  if(/^\/new\s*$/.test(message.trim())){await newConversation();return;}
  // Claim the user action before memory, attachments or preview can await.
  // Enter+click, voice+click, and re-entrant UI events then share one request.
  if (dispatchReserved || running){
    log('note','BUSY','Zuzu is already processing this submission.');
    return;
  }
  dispatchReserved = true;
  const originChat=chatRef();
  try {
    if (await handleLocalCommand(message)){ dispatchReserved = false; return; }
  } catch(error) {
    dispatchReserved = false;
    log('error','ZUZU',String(error.message||error));
    showToast(String(error.message||error), 'error');
    return;
  }
  try {
    lastUserTurn = message; liveUserTurn = message;
    pendingLiveAttachmentParts = [];
    const previewNote = maybeOpenRequestedBrowserPreview(message);
    message = await attachVisualContext(message);
    message = attachUploadedContext(message);
    if (previewNote) message = `${message}\n\n${previewNote}`;
  } catch(error) {
    dispatchReserved = false;
    log('error','SEND',String(error.message||error));
    return;
  }
  // With Live connected, typed and spoken turns share the same voice session.
  // Tool requests return through hermes_action; no second TTS voice overlaps it.
  if (liveReady && liveWs?.readyState === WebSocket.OPEN && !message.trim().startsWith('/')) {
    setUserText(message.trim().slice(0,90));
    const parts = [{text:message}, ...pendingLiveAttachmentParts];
    pendingLiveAttachmentParts = [];
    liveWs.send(JSON.stringify({clientContent:{turns:[{role:'user',parts}],turnComplete:true}}));
    persistLiveTurn();
    return;
  }
  showView('chat');
  resetSteps(message); watchPc(message);
  running = true; answer = ''; firstDelta = false; speakThisRun = options.speak !== false;
  dispatchReserved = false;
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
      body: JSON.stringify({message, fresh, ...originChat, request_id:id, client_context: clientDeviceContext(), system: clientContextSystemText()}), signal:activeController.signal
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
        if (line && sameChat(originChat)) handle(JSON.parse(line));
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
  finishSteps();
  scheduleJobPoll(1500);
  loadWorkspace();
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
      pushStep(ev);
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
      autoRemember(lastUserTurn, answer, 'chat'); lastUserTurn = '';
      speakDone = speakThisRun ? speak(answer) : Promise.resolve();
      break;
    case 'error':
      autoRemember(lastUserTurn, '', 'chat'); lastUserTurn = '';   // what the user said is still worth learning
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
let floorSum=0, floorN=0, threshold=0.02, peak=0, calibrating=true, speechFrames=0;
const SILENCE=900, MIN_TURN_MS=350, MAX_TURN_MS=18000, NO_SPEECH_MS=10000;
let liveWs=null, liveInputCtx=null, liveOutputCtx=null, liveProcessor=null;
let liveSource=null, liveReady=false, liveSpeaking=false, livePlayAt=0;
let liveSources=new Set(), bargeFrames=0, wakeLock=null, voiceWanted=false, liveLastMessageAt=0;
let liveBridge=null, liveAnswerStarted=false;
let liveConnecting=false, liveConnectTimer=null, liveFailedUntil=0, ttsFailed=false;

function useVoiceFallback(reason){
  const detail = /prepayment credits are depleted|quota|billing/i.test(reason)
    ? 'Gemini Live credits are depleted'
    : `Gemini Live failed: ${reason || 'connection closed'}`;
  stopConvo(false);
  voiceWanted=false;
  sessionStorage.removeItem('jarvis-voice-resume');
  liveFailedUntil=Date.now()+5*60*1000;
  ttsFailed=true;
  RT.live=false;
  RT.tts=false;
  log('error','VOICE',`${detail}. Switching to voice through Hermes.`);
  if (RT.stt || SpeechRecognition) {
    micToggle();
  } else {
    setState('error','VOICE UNAVAILABLE',`${detail}. Text chat still uses Hermes.`);
  }
}

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

// Calm mode: warm the voice slightly (gentle high cut, a touch quieter).
function calmVoiceChain(ctx){
  if (ctx._calmChain) return ctx._calmChain;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200; lp.Q.value = 0.5;
  const g = ctx.createGain(); g.gain.value = 0.88; lp.connect(g); g.connect(ctx.destination);
  return (ctx._calmChain = lp);
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
  src.buffer = audio; src.connect(window.calmSession ? calmVoiceChain(liveOutputCtx) : liveOutputCtx.destination);
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
  const originChat=liveChat?{...liveChat}:chatRef();
  await persistLiveTurn().catch(()=>{});
  log('tool', 'HERMES', 'Executing voice action');
  resetSteps(request); watchPc(request);
  setState('running','WORKING','Hermes is handling your request');
  const started=Date.now();
  serverBusy=true;
  const tick=setInterval(()=>{
    if(sameChat(originChat)&&!liveSpeaking)$('#strun').textContent=`Hermes working · ${Math.floor((Date.now()-started)/1000)}s`;
  },1000);
  try{
  const response = await fetch('/api/run', {
    method:'POST', headers:apiHeaders({'content-type':'application/json'}),
    body:JSON.stringify({message:request, ...originChat, request_id:rid(), client_context: clientDeviceContext(), system: clientContextSystemText()}), signal
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
    if(ev.t==='tool'&&sameChat(originChat)){ log('tool','HERMES',ev.name || 'Tool activity'); pushStep(ev); }
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
  if(sameChat(originChat)){
    answer=result;renderAnswer();showMediaFromAnswer(result);
  }
  return {result:result.slice(0,12000),instruction:'Report this outcome faithfully; do not infer success if it reports refusal, missing tools or failure.'};
  }finally{
    serverBusy=false;
    clearInterval(tick);
    if(sameChat(originChat)){loadWorkspace();if(!liveSpeaking)setState(convo?'listening':'',''+(convo?'LISTENING':'READY'),'');}
  }
}

async function startGeminiLive(){
  try{
    if (liveConnecting || liveReady) return;
    liveConnecting=true;
    await voiceSaveQueue.catch(()=>{});
    liveChat=chatRef();liveUserTurn='';liveAssistantTurn='';liveTurnId='';
    if (player) player.pause();
    speechSynth?.cancel();
    voiceWanted = true;
    setState('running','CONNECTING','Gemini native audio…');
    const auth = await fetch('/api/live-token', {
      method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify({...liveChat,client_context: clientDeviceContext(), system: clientContextSystemText(), ...(window.calmSession ? {purpose:'calm', voice:window.calmSession.voice} : {})})
    }).then(async r => { const data=await r.json(); if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`); return data; });
    micStream = await navigator.mediaDevices.getUserMedia(
      {audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1}});
    syncMicMute();
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
    liveConnectTimer=setTimeout(() => {
      if (connectedSocket === liveWs && !liveReady) useVoiceFallback('connection timed out');
    }, 12000);
    liveBridge = new HermesVoiceBridge(executeLiveAction, message => {
      if (connectedSocket === liveWs && connectedSocket.readyState === WebSocket.OPEN) connectedSocket.send(JSON.stringify(message));
    }, LOCAL_TOOLS);
    liveWs.onmessage = async event => {
      liveLastMessageAt = Date.now();
      let payload = event.data;
      if (payload instanceof Blob) payload = await payload.text();
      else if (payload instanceof ArrayBuffer) payload = new TextDecoder().decode(payload);
      const msg = JSON.parse(payload);
      if(connectedSocket!==liveWs)return;
      if (msg.setupComplete && !liveReady){
        clearTimeout(liveConnectTimer); liveConnectTimer=null; liveConnecting=false;
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
        if (SLEEP_RE.test(content.inputTranscription.text)) setTimeout(() => { if (convo) stopConvo(); }, 1800);
        liveUserTurn += content.inputTranscription.text;
        setUserText(content.inputTranscription.text.slice(0,90));
        sendLiveVisualFrame(content.inputTranscription.text.slice(0,80));
      }
      if (content.outputTranscription?.text){
        if (!liveAnswerStarted) { answer=''; liveAnswerStarted=true; }
        answer += content.outputTranscription.text;
        liveAssistantTurn += content.outputTranscription.text;
        renderAnswer();
      }
      for (const part of (content.modelTurn?.parts || [])) {
        if (part.inlineData?.data) playLivePcm(part.inlineData.data, 24000);
      }
      if (content.turnComplete){
        liveReconnectAttempts=0;
        dispatchReserved=false;
        liveAnswerStarted=false;
        if (liveUserTurn.trim()) autoRemember(liveUserTurn, answer, 'voice');
        persistLiveTurn(true).then(()=>loadWorkspace()).catch(()=>{});
        const delay = Math.max(0, (livePlayAt - liveOutputCtx.currentTime) * 1000);
        setTimeout(() => {
          if (connectedSocket !== liveWs || liveSources.size) return;
          liveSpeaking=false; document.body.classList.remove('speaking');
          if(convo) setState('listening','LISTENING','تفضّل، أنا سامعاك');
        }, delay + 30);
      }
      if (content.interrupted){
        dispatchReserved=false;
        liveAnswerStarted=false;
        persistLiveTurn(true);
        stopLivePlayback();
        if(convo) setState('listening','LISTENING','interrupted · speak now');
      }
    };
    liveWs.onerror = () => log('error','VOICE','Gemini Live connection error');
    liveWs.onclose = event => {
      if (connectedSocket !== liveWs) return;
      if(voiceWanted&&liveReady&&liveReconnectAttempts<2){
        liveReconnectAttempts++;
        stopConvo(false);
        setState('running','RECONNECTING','Your conversation and actions are saved');
        setTimeout(()=>{if(voiceWanted&&!document.hidden)startGeminiLive();},1000*liveReconnectAttempts);
      }
      else if (voiceWanted) useVoiceFallback(event.reason || `connection closed (${event.code})`);
      else stopConvo(false);
    };
  }catch(e){
    useVoiceFallback(String(e.message||e).slice(0,160));
  }
}

// ── voice out ──
let muted = false, player = null, speakResolve = null, liveTts = null, liveTtsFailedUntil = 0;

// Read a typed reply with the same Gemini native-audio model and voice as voice chat.
// Resolves true once the audio has finished playing, false if nothing was spoken.
async function speakWithLive(text){
  const auth = await fetch('/api/live-token', {method:'POST', headers:apiHeaders({'content-type':'application/json'}),
    body:JSON.stringify({purpose:'speak', ...(window.calmSession ? {soft:true, voice:window.calmSession.voice} : {})})}).then(async r => { const d=await r.json(); if(!r.ok) throw new Error(d.error||`HTTP ${r.status}`); return d; });
  return new Promise(resolve => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const sources = new Set();
    let playAt = ctx.currentTime, gotAudio = false, finished = false;
    const ws = new WebSocket('wss://generativelanguage.googleapis.com/ws/'
      + 'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained'
      + `?access_token=${encodeURIComponent(auth.token)}`);
    const finish = (ok, waitForAudio) => {
      if (finished) return; finished = true; clearTimeout(timer);
      try{ ws.close(); }catch(_){}
      const delay = waitForAudio ? Math.max(0, (playAt - ctx.currentTime) * 1000) + 60 : 0;
      setTimeout(() => {
        for (const s of sources){ try{s.stop();}catch(_){} }
        ctx.close().catch(()=>{});
        if (liveTts?.ws === ws) liveTts = null;
        resolve(ok);
      }, delay);
    };
    liveTts = {ws, stop: () => finish(gotAudio, false)};
    const timer = setTimeout(() => finish(gotAudio, gotAudio), 20000);
    ws.onopen = () => ws.send(JSON.stringify({setup:{
      model:`models/${auth.model}`,
      generationConfig:{responseModalities:['AUDIO'], thinkingConfig:{thinkingBudget:0},
        speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:auth.voice||'Kore'}}}},
      systemInstruction:{parts:[{text:auth.system}]}
    }}));
    ws.onmessage = async event => {
      let payload = event.data;
      if (payload instanceof Blob) payload = await payload.text();
      const msg = JSON.parse(payload);
      if (msg.setupComplete){
        ws.send(JSON.stringify({clientContent:{turns:[{role:'user', parts:[{text:`Read this aloud exactly, word for word:\n\n${text}`}]}], turnComplete:true}}));
        return;
      }
      for (const part of (msg.serverContent?.modelTurn?.parts || [])){
        if (!part.inlineData?.data || muted) continue;
        const raw = atob(part.inlineData.data), bytes = new Uint8Array(raw.length);
        for (let i=0; i<raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const pcm = new Int16Array(bytes.buffer), buf = ctx.createBuffer(1, pcm.length, 24000), ch = buf.getChannelData(0);
        for (let i=0; i<pcm.length; i++) ch[i] = pcm[i] / 32768;
        const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
        sources.add(src); src.onended = () => sources.delete(src);
        if (!gotAudio){ gotAudio = true; document.body.classList.add('speaking'); }
        const when = Math.max(ctx.currentTime + 0.015, playAt); src.start(when); playAt = when + buf.duration;
      }
      if (msg.serverContent?.turnComplete) finish(gotAudio, true);
    };
    ws.onerror = () => finish(gotAudio, gotAudio);
    ws.onclose = () => finish(gotAudio, gotAudio);
  });
}

function stopSpeech(){
  if (player){ try{player.pause();}catch(_){} }
  speechSynth?.cancel();
  liveTts?.stop();
  document.body.classList.remove('speaking');
  if (speakResolve){ const r = speakResolve; speakResolve = null; r(); }
}

function speak(text){
  return new Promise(resolve => {
    const voiceStarted=performance.now();
    text = cleanForSpeech(text);
    if (muted || !text) return resolve();
    speakResolve = resolve;
    suppress = true;
    const spoken = text.length > 700 ? text.slice(0, 680).replace(/\s+\S*$/,'') + '…' : text;
    if (RT.live && Date.now() >= liveTtsFailedUntil){
      speakWithLive(spoken).then(ok => {
        document.body.classList.remove('speaking');
        if (ok || speakResolve !== resolve){ log('latency','VOICE',`native voice finished after ${Math.round(performance.now()-voiceStarted)}ms`); return resolve(); }
        throw new Error('no audio returned');
      }).catch(err => {
        if (speakResolve !== resolve) return resolve();
        liveTtsFailedUntil = Date.now() + 5*60*1000;
        log('error','VOICE',`native voice unavailable (${String(err.message||err).slice(0,80)}); using backup voice`);
        speakFallback(spoken, voiceStarted, resolve);
      });
      return;
    }
    speakFallback(spoken, voiceStarted, resolve);
  });
}

function speakFallback(spoken, voiceStarted, resolve){
  if (!RT.tts && RT.browserTts && speechSynth){
    try{
      speechSynth.cancel();
      const u = new SpeechSynthesisUtterance(spoken);
      u.lang = /[\u0600-\u06ff]/.test(spoken) ? 'ar-EG' : 'en-US';
      u.rate = 0.95; u.pitch = 0.82; u.volume = 1;
      document.body.classList.add('speaking');
      u.onstart = () => log('latency','VOICE',`browser speech started after ${Math.round(performance.now()-voiceStarted)}ms`);
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
      log('latency','VOICE',`speech audio ready after ${Math.round(performance.now()-voiceStarted)}ms`);
      const url = URL.createObjectURL(blob);
      if (player) player.pause();
      player = new Audio(url);
      document.body.classList.add('speaking');
      const done = () => { document.body.classList.remove('speaking');
        URL.revokeObjectURL(url); resolve(); };
      player.onended = done; player.onerror = done;
      return player.play();
    })
    .catch(() => {
      ttsFailed=true; RT.tts=false;
      if (!speechSynth) return resolve();
      const u = new SpeechSynthesisUtterance(spoken);
      u.lang = /[\u0600-\u06ff]/.test(spoken) ? 'ar-EG' : 'en-US';
      u.onend = u.onerror = () => { document.body.classList.remove('speaking'); resolve(); };
      document.body.classList.add('speaking');
      speechSynth.speak(u);
    });
}

// ── microphone mute toggle ──
let micMuted = false;
function syncMicMute(){
  const t = micStream ? micStream.getAudioTracks()[0] : null;
  if (t) t.enabled = !micMuted;
  const b = $('#micMute');
  if (b){
    b.textContent = micMuted ? 'Unmute mic' : 'Mute mic';
    b.classList.toggle('on', !micMuted);
    b.classList.toggle('off', micMuted);
  }
}
function toggleMicMute(){
  micMuted = !micMuted;
  syncMicMute();
  log('voice','VOICE', micMuted ? 'microphone muted' : 'microphone unmuted');
}

// ── start / stop the whole conversation ──
async function micToggle(){
  if (liveConnecting){ stopConvo(); return; }
  if (convo){ stopConvo(); return; }
  if (RT.live){ await startGeminiLive(); return; }
  // Record and transcribe on the server (ElevenLabs or local Whisper).
  // Browser speech recognition depends on the device's speech service.
  if (RT.stt){
    try {
      micStream = await navigator.mediaDevices.getUserMedia(
        {audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}});
      syncMicMute();
    } catch(e){ log('error','VOICE','mic blocked — allow it in the address bar'); return; }
    actx = new (window.AudioContext||window.webkitAudioContext)();
    await actx.resume();
    analyser = actx.createAnalyser(); analyser.fftSize = 1024;
    actx.createMediaStreamSource(micStream).connect(analyser);
    vdata = new Uint8Array(analyser.fftSize);
    convo = true; suppress = false;
    $('#mic').classList.add('on'); $('#mic').textContent = 'Listening';
    log('voice','VOICE','server voice transcription open · listening');
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
  dispatchReserved=false;
  persistLiveTurn(true);
  if (manual){ voiceWanted = false; sessionStorage.removeItem('jarvis-voice-resume'); }
  convo = false; suppress = false;
  liveReady = false; liveSpeaking = false;
  liveConnecting=false;
  if (liveConnectTimer){ clearTimeout(liveConnectTimer); liveConnectTimer=null; }
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
  if (wakeWanted) setTimeout(startWakeListener, 900);
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
  floorSum = 0; floorN = 0; calibrating = true; threshold = 0.02; speechFrames = 0;
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
    if (!spoke && ++speechFrames >= 3){ spoke = true; log('voice','VOICE','speech detected'); }
  } else if (spoke && t - loudAt > SILENCE){
    return endTurn('silence');
  } else if (!spoke){
    speechFrames = 0;
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
    const response = await fetch('/api/listen', {method:'POST',
      headers:apiHeaders({'content-type':blob.type||'audio/webm'}), body:blob});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const text = (result.text||'').trim();
    const ms = Math.round(performance.now() - t0);
    if (!text){
      log('voice','VOICE','No words recognized; listening again');
      if (convo){
        setState('listening','LISTENING','لم أسمع كلامًا واضحًا — حاول مرة ثانية');
        setTimeout(() => { if (convo && !suppress) beginTurn(); }, 1200);
      } else setState('','STANDBY','nothing heard');
      return;
    }
    log('voice','VOICE',`transcribed on server in ${ms}ms: "${text}"`);
    const armed = $('#input').dataset.cmd || '';
    const full = (armed ? armed + ' ' : '') + text;
    $('#input').value = ''; disarm();
    log('send','SEND',`auto-sent voice: ${full}`);
    await transmit(full);                       // runs, then speaks; both with mic deaf
    // turn's done — hand the floor back and listen again
    suppress = false;
    if (convo) beginTurn();
  } catch(e){
    const detail = String(e?.message || e).slice(0,160);
    log('error','VOICE',`transcription failed: ${detail}`);
    stopConvo(false);
    voiceWanted=false;
    setState('error','VOICE ERROR',detail);
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
$('#micMute').onclick = toggleMicMute;
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
let serverBusy = false, lastStatus = null, backgroundMissions = 0;
function isBusy(){
  return running || serverBusy || convo || liveConnecting || !!liveTts || liveSpeaking
    || document.body.classList.contains('speaking') || !!(player && !player.paused) || !!speechSynth?.speaking;
}
function stopEverything(){
  if (running || serverBusy){
    fetch('/api/cancel', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify({client_context: clientDeviceContext(), system: clientContextSystemText(), ...(window.calmSession ? {purpose:'calm', voice:window.calmSession.voice} : {})})}).catch(()=>{});
  }
  if (activeController) activeController.abort();
  stopSpeech();
  if (convo || liveConnecting) stopConvo();
  serverBusy = false;
  setState('', 'STOPPED', 'stopped by you');
  setTag('', 'IDLE');
  log('note','STOP','stopped the running request, speech and voice');
  refreshStopButton();
}
function refreshStopButton(){ const b=$('#stopBtn'); if (b) b.hidden = !isBusy(); }
$('#stopBtn').onclick = stopEverything;
setInterval(refreshStopButton, 250);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !isBusy()) return;
  e.preventDefault();
  stopEverything();
});
$('#mute').onclick = () => {
  muted = !muted; const b=$('#mute');
  b.textContent = muted?'🔇':'🔊'; b.classList.toggle('on',!muted); b.classList.toggle('off',muted);
  if (muted) stopSpeech();
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
    backgroundMissions = (j.running || []).length;
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
  RT.tts = s.tts !== 'browser' && !ttsFailed; RT.stt = s.stt === 'elevenlabs' || s.stt === 'local';
  RT.live = !!s.live_voice && Date.now() >= liveFailedUntil; RT.liveModel = s.live_model || '';
  RT.browserStt = !!SpeechRecognition; RT.browserTts = !!speechSynth;
  const hermesReady = !!s.hermes_connected;
  const hermesChecking = !!s.hermes_pending;
  const hermesLabel = hermesReady ? 'Connected' : (hermesChecking ? 'Checking' : 'Offline');
  const providerName = s.provider === 'gemini' ? 'Gemini' : (s.provider || 'profile model');
  const modeName={hybrid:'Hybrid',hermes:'Hermes Only',direct:'Direct Model'}[s.conversation_mode]||'Hybrid';
  const brain = s.runtime === 'direct' ? `Direct · ${providerName}` : (s.runtime === 'hermes' ? `${modeName} · ${providerName}` : 'Core offline');
  const ttsLabel = s.tts === 'gemini' ? 'Gemini TTS' : (RT.tts ? 'ElevenLabs TTS' : 'Browser TTS');
  const sttLabel = RT.live ? 'Gemini Live' : (s.stt === 'local' ? 'Local STT' : (RT.stt ? 'ElevenLabs STT' : (RT.browserStt ? 'Browser STT' : 'Text only')));
  sys('gw', 'Online', 'ok');
  sys('hermes', hermesLabel, hermesReady ? 'ok' : (hermesChecking ? '' : 'warn'));
  const hasActiveOperation = renderActiveOperation(s.active_operation, 'status');
  serverBusy = !!hasActiveOperation;
  lastStatus = s;
  renderCommandCenterStatus(s);
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
  if (!hasActiveOperation && !running && !convo) setState('', 'READY', '');
}
async function refreshStatus(attempt = 0){
  try{
    const started=performance.now();
    const response = await fetch('/api/status', {cache:'no-store'});
    if(response.status===401){location.replace('/login.html');return;}
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    renderStatus(status);
    $('#healthDetail').textContent=`Dashboard online · Hermes ${status.hermes_connected?'connected':'offline'} via ${status.transport||'CLI'} (${status.hermes_detail||'no detail'}) · voice ${status.stt||'unavailable'} / ${status.tts||'unavailable'} · check ${Math.round(performance.now()-started)}ms`;
    if (status.tools_pending && !(status.tools || []).length && attempt < 20){
      setTimeout(() => refreshStatus(attempt + 1), 900);
    }
  }catch(error){
    sys('gw','Offline','warn');
    $('#healthDetail').textContent=`Dashboard connection failed: ${error.message||error}`;
    $('#top-gw').textContent = 'Zuzu offline';
    $('#top-hermes').textContent = 'Hermes unknown';
    if (!bootLogged) log('error','STATUS','server unreachable');
  }
}
defaultTip = $('#tip').textContent;
const callNumber = () => $('#callNumber').value.trim();
const validCallNumber = number => /^\+[1-9]\d{7,14}$/.test(number);
$('#openDialer').onclick = () => {
  const number = callNumber();
  if (!validCallNumber(number)) { $('#callResult').textContent='Enter a phone number with country code, such as +15551234567.'; return; }
  location.href = `tel:${number}`;
};
$('#startAiCall').onclick = async () => {
  const number = callNumber();
  if (!validCallNumber(number)) { $('#callResult').textContent='Enter a phone number with country code.'; return; }
  if (!confirm(`Ask Zuzu to place a paid AI call to ${number}?`)) return;
  const button=$('#startAiCall'); button.disabled=true;
  $('#callResult').textContent='Starting the call…';
  try {
    const response=await fetch('/api/calls/outbound',{method:'POST',headers:apiHeaders({'content-type':'application/json'}),
      body:JSON.stringify({number,confirmed:true,requestId:crypto.randomUUID().replace(/-/g,'')})});
    const result=await response.json();
    if(!response.ok) throw new Error(result.error||`HTTP ${response.status}`);
    $('#callResult').textContent=`Call ${result.status||'queued'} · ${result.id}`;
    refreshCalls();
  } catch(error) { $('#callResult').textContent=String(error.message||error); }
  finally { button.disabled=false; }
};
async function refreshCalls(){
  try {
    const statusResponse=await fetch('/api/calls/status',{headers:apiHeaders()});
    if(!statusResponse.ok) throw new Error(`HTTP ${statusResponse.status}`);
    const status=await statusResponse.json();
    $('#callReady').textContent=status.configured?'Vapi credentials are present. Verify the assistant and number before your first call.':
      `AI calls are not connected yet. Configure ${status.missing.join(', ')} privately on the laptop.`;
    $('#startAiCall').disabled=!status.configured;
    if(!status.configured) { $('#callHistory').innerHTML='<p class="empty-state">Connect Vapi to load calls.</p>'; return; }
    const historyResponse=await fetch('/api/calls/history',{headers:apiHeaders()});
    const history=await historyResponse.json();
    if(!historyResponse.ok) throw new Error(history.error||`HTTP ${historyResponse.status}`);
    $('#callHistory').innerHTML=(history.calls||[]).map(call=>`<div class="call-row"><div><b>${esc(call.type||'Call')}</b> · ${esc(call.status||'unknown')}<br><small>${esc(call.summary||'No summary')}</small></div><small>${esc(call.startedAt||'')}</small></div>`).join('')||'<p class="empty-state">No AI calls yet.</p>';
  }catch(error){$('#callReady').textContent=`Phone status unavailable: ${error.message||error}`;}
}
$('#reconnectBtn').onclick=()=>{log('status','RECONNECT','checking Zuzu and Hermes again');refreshStatus();};
setInterval(()=>refreshStatus(),15000);
$('#refreshCalls').onclick=refreshCalls;
loadWorkspace();
refreshStatus();
refreshCalls();

// ══════════ command center (main page) ══════════
const fmtBytes = n => { if (!n && n !== 0) return '—'; const u=['B','KB','MB','GB','TB']; let i=0; while (n>=1024 && i<u.length-1){ n/=1024; i++; } return `${n.toFixed(i>2?1:0)} ${u[i]}`; };
const fmtUptime = s => { if (s == null) return '—'; const d=Math.floor(s/86400), h=Math.floor(s%86400/3600), m=Math.floor(s%3600/60); return d ? `${d}d ${h}h` : (h ? `${h}h ${m}m` : `${m}m`); };
const kv = rows => rows.filter(r => r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k,v]) => `<dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(v)}</dd>`).join('');
function setPill(id, tone, value){
  const el = $(id); if (!el) return;
  el.dataset.tone = tone || '';
  const em = el.querySelector('em'); if (em && value !== undefined) em.textContent = value;
}

function renderCommandCenterStatus(s){
  const hermes = s.hermes_connected ? 'connected' : (s.hermes_pending ? 'checking' : 'offline');
  setPill('#ccPillHermes', s.hermes_connected ? 'ok' : (s.hermes_pending ? '' : 'bad'), `${hermes} · ${s.transport === 'api' ? 'API' : 'CLI'}`);
  setPill('#ccPillBrain', s.runtime === 'hermes' ? 'ok' : 'bad', s.model || s.provider || '—');
  const voiceText = RT.live ? `Native audio · ${WS?.settings?.voice || ''}` : (s.tts === 'browser' ? 'Browser voice' : `${s.tts} voice`);
  setPill('#ccPillVoice', RT.live ? 'ok' : '', voiceText);
  const brain = $('#ccBrain');
  if (brain) brain.innerHTML = kv([
    ['Agent', s.hermes_connected ? 'Hermes · connected' : `Hermes · ${hermes}`],
    ['Link', s.transport === 'api' ? 'Hermes API (streaming)' : 'Hermes CLI'],
    ['Model', s.model],
    ['Voice model', s.live_model || (s.tts === 'browser' ? 'Browser speech' : s.tts)],
    ['Voice', WS?.settings?.voice],
    ['Tools', (s.tools || []).length ? `${(s.tools || []).length} available` : (s.tools_pending ? 'loading…' : 'none reported')],
    ['Profile', s.profile || 'default'],
  ]);
  renderCommandCenterProfile();
}

function renderCommandCenterProfile(){
  const box = $('#ccProfile'); if (!box || !WS) return;
  const st = WS.settings || {};
  box.innerHTML = kv([
    ['Hermes profile', st.profile || 'default'],
    ['Working folder', st.workdir || '~'],
    ['Persona', (st.persona || '').slice(0, 70) + ((st.persona || '').length > 70 ? '…' : '')],
    ['Memories', `${(WS.memory || []).length} saved`],
    ['Skills', `${(WS.skills || []).filter(x => x.enabled !== false).length} active`],
    ['PC control', st.computerControl ? 'Allowed' : 'Off'],
  ]);
}

function renderCommandCenterWorkspace(){
  if (!WS) return;
  const projects = WS.projects || [];
  const selected = projects.find(p => p.id === WS.selectedProject) || projects[0];
  const select = $('#ccProject');
  if (select) select.innerHTML = projects.map(p => `<option value="${esc(p.id)}" ${p.id === selected?.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const sessions = (selected?.sessions || []).slice().sort((a,b) => (b.created||0) - (a.created||0)).slice(0, 6);
  const list = $('#ccSessions');
  if (list) list.innerHTML = sessions.map(x => `<button type="button" data-session="${esc(x.id)}" class="${x.id === WS.selectedSession ? 'active' : ''}"><span>${esc(x.name)}</span>${x.hermesSessionId ? '<i title="Has Hermes history"></i>' : ''}</button>`).join('') || '<div class="cc-empty">No chats yet.</div>';
  renderCommandCenterProfile();
}
$('#ccProject')?.addEventListener('change', async e => {
  try { await workspaceRequest({action:'select_session', projectId:e.target.value, sessionId:''}); await loadHistory(); }
  catch(err){ log('error','WORKSPACE',String(err.message||err)); }
});
$('#ccNewChat')?.addEventListener('click', () => $('#addSession').click());

let ccRunStartedAt = 0;
function renderCommandCenterNow(){
  const state = $('#ccNowState'), detail = $('#ccNowDetail'), elapsed = $('#ccNowElapsed'), missions = $('#ccNowMissions');
  if (!state) return;
  if (running && !ccRunStartedAt) ccRunStartedAt = Date.now();
  if (!running) ccRunStartedAt = 0;
  const speaking = document.body.classList.contains('speaking');
  const op = lastStatus?.active_operation;
  let label = 'Ready for your next request.', tone = 'idle', text = '', secs = 0;
  if (running){ label = 'Working on your request'; tone = 'busy'; text = $('#userText')?.textContent || ''; secs = (Date.now() - ccRunStartedAt) / 1000; }
  else if (serverBusy && op){ label = op.label || 'Hermes task'; tone = 'busy'; text = op.detail || ''; secs = op.started_ms ? (Date.now() - op.started_ms) / 1000 : 0; }
  else if (speaking){ label = 'Speaking'; tone = 'speak'; }
  else if (convo){ label = 'Listening — go ahead'; tone = 'listen'; }
  state.textContent = label; state.dataset.tone = tone;
  detail.textContent = text;
  elapsed.textContent = secs > 0.5 ? `${secs.toFixed(0)}s elapsed` : '';
  missions.textContent = backgroundMissions ? `${backgroundMissions} background mission${backgroundMissions > 1 ? 's' : ''}` : '';
  const pill = $('#ccPillState');
  if (pill){ pill.dataset.tone = tone === 'idle' ? 'ok' : 'busy'; pill.querySelector('b').textContent = ({idle:'Ready', busy:'Working', speak:'Speaking', listen:'Listening'})[tone]; }
  const clock = $('#ccClock'); if (clock) clock.textContent = new Date().toLocaleString([], {weekday:'short', hour:'2-digit', minute:'2-digit'});
}
setInterval(renderCommandCenterNow, 500);

// Mirror the live exchange from the core into a readable transcript card.
function syncConversation(){
  const you = ($('#userText')?.textContent || '').trim();
  const zuzu = ($('#response')?.textContent || '').trim();
  $('#ccYou').textContent = you; $('#ccYouRow').hidden = !you;
  $('#ccZuzu').textContent = zuzu; $('#ccZuzuRow').hidden = !zuzu;
  $('#ccLiveEmpty').hidden = !!(you || zuzu);
}
['#userText', '#response'].forEach(sel => { const el = $(sel); if (el) new MutationObserver(syncConversation).observe(el, {childList:true, subtree:true, characterData:true}); });

function syncFeed(){
  const feed = $('#ccFeed'); if (!feed) return;
  feed.innerHTML = [...document.querySelectorAll('#log .entry')].slice(0, 5).map(e => {
    const kind = e.querySelector('.kind')?.textContent || '', msg = e.querySelector('.msg')?.textContent || '', ts = e.querySelector('.ts')?.textContent || '';
    return `<li class="${esc(e.className.replace('entry',''))}"><span>${esc(ts)}</span><b>${esc(kind)}</b><em>${esc(msg.slice(0, 90))}</em></li>`;
  }).join('') || '<li class="cc-empty">No activity yet.</li>';
}
const logBox = $('#log'); if (logBox) new MutationObserver(syncFeed).observe(logBox, {childList:true});

// Smart tools: run now, or prefill the message box when details are needed.
document.addEventListener('click', e => {
  const run = e.target.closest('[data-cc-run]');
  if (run){ transmit(run.dataset.ccRun); return; }
  const compose = e.target.closest('[data-cc-compose]');
  const summarize = e.target.closest('[data-cc-summarize]');
  if (!compose && !summarize) return;
  if (summarize && activeAttachments.length){ transmit('Summarize the attached file(s) into key points, decisions and next actions.'); return; }
  const input = $('#input');
  input.value = compose ? compose.dataset.ccCompose : 'Summarize this into key points and next actions: ';
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  input.scrollIntoView({block:'center', behavior:'smooth'});
});

async function refreshPcInfo(){
  if (document.visibilityState === 'hidden') return;
  try{
    const r = await fetch('/api/system', {headers:apiHeaders(), cache:'no-store'});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = await r.json();
    $('#ccPcHost').textContent = s.host || '';
    const meter = (label, used, total, extra) => {
      const pct = total ? Math.round(used / total * 100) : null;
      return `<div class="cc-meter"><div><b>${esc(label)}</b><span>${esc(extra || (pct == null ? '—' : pct + '%'))}</span></div><i style="--p:${pct ?? 0}%" data-hot="${pct >= 85 ? 1 : 0}"></i></div>`;
    };
    const mem = s.memory, disk = s.disk;
    $('#ccPc').innerHTML =
      (s.cpu_percent != null ? meter('CPU', s.cpu_percent, 100, `${Math.round(s.cpu_percent)}% · ${s.cpus} cores`) : '')
      + (mem ? meter('Memory', mem.total - mem.available, mem.total, `${fmtBytes(mem.total - mem.available)} / ${fmtBytes(mem.total)}`) : '')
      + (disk ? meter('Disk', disk.total - disk.free, disk.total, `${fmtBytes(disk.free)} free`) : '')
      + (s.battery ? meter('Battery', s.battery.percent, 100, `${s.battery.percent}%${s.battery.plugged ? ' · charging' : ''}`) : '')
      + `<dl class="cc-kv">${kv([['System', s.os], ['Uptime', fmtUptime(s.uptime)]])}</dl>`;
  }catch(err){ $('#ccPc').innerHTML = `<div class="cc-empty">PC info unavailable (${esc(err.message||err)})</div>`; }
}
refreshPcInfo();
setInterval(refreshPcInfo, 20000);
syncFeed();

// ══════════ personal: reminders, brief, music, video, model, wake word ══════════
let PERSONAL = null, lastBrief = null, wakeRec = null, wakeWanted = false, inboxPolls = 0;
const WAKE_RE = /\b(?:hey|hi|ok|okay|ya)?\s*(?:zu\s?zu|zoo\s?zoo|zouzou|zuzo|zozo|susu)\b|زوزو/i;
const SLEEP_RE = /sleep mode|go to sleep|stop listening|وضع النوم|نامي|اسكتي يا زوزو/i;

function showToast(text, kind = 'info', link = null){
  let box = $('#toasts');
  if (!box){ box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live','polite'); document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.innerHTML = `<span>${esc(text)}</span>` + (link ? `<a href="${escapeAttr(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a>` : '') + '<button type="button" aria-label="Dismiss">×</button>';
  el.querySelector('button').onclick = () => el.remove();
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === 'reminder' ? 60000 : 9000);
}

async function personalRequest(payload){
  const r = await fetch('/api/personal', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify(payload)});
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  PERSONAL = data; renderPersonal();
  return data;
}
async function loadPersonal(){
  try{ const r = await fetch('/api/personal', {headers:apiHeaders()}); if (r.ok){ PERSONAL = await r.json(); renderPersonal(); } }catch(_){}
}
function fmtDue(iso){
  if (!iso) return 'No time set';
  const d = new Date(iso), today = new Date(), tomorrow = new Date(Date.now() + 864e5);
  const time = d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return d.toLocaleDateString([], {weekday:'short', day:'numeric', month:'short'}) + ` ${time}`;
}
function renderPersonal(){
  if (!PERSONAL) return;
  if ($('#mgAuto')) $('#mgAuto').checked = PERSONAL.settings?.autoMemory !== false;
  const list = $('#reminderList');
  const items = PERSONAL.reminders || [];
  if (list) list.innerHTML = items.map(r => `<div class="pf-item ${r.done ? 'done' : ''} ${!r.done && r.due && new Date(r.due) < new Date() ? 'overdue' : ''}">
      <label><input type="checkbox" data-rem-done="${esc(r.id)}" ${r.done ? 'checked' : ''}><span>${esc(r.text)}</span></label>
      <small>${esc(fmtDue(r.due))}${r.repeat ? ` · ${esc(r.repeat)}` : ''}</small>
      <button type="button" class="danger-link" data-rem-delete="${esc(r.id)}" aria-label="Delete reminder">×</button></div>`).join('')
    || '<div class="empty-state">No reminders yet. Try "call mom tomorrow 6pm".</div>';
  const form = $('#briefForm'), st = PERSONAL.settings || {};
  if (form && !form.contains(document.activeElement)){
    $('#pfCity').value = st.city || ''; $('#pfMorning').value = st.briefMorning || ''; $('#pfEvening').value = st.briefEvening || '';
    $('#pfRegion').value = st.newsRegion || 'AE'; $('#pfLang').value = st.newsLang || 'en'; $('#pfTopic').value = st.newsTopic || '';
    $('#pfIcs').value = st.calendarIcs || ''; $('#pfTelegram').value = st.telegramTarget || '';
    $('#pfBriefs').checked = st.briefsEnabled !== false; $('#pfWake').checked = !!st.wakeWord;
  }
  if (!!st.wakeWord !== wakeWanted) setWakeWord(!!st.wakeWord);
  renderToday();
}
function renderToday(){
  const box = $('#ccToday'); if (!box) return;
  const now = new Date();
  const w = lastBrief?.weather;
  const upcoming = (PERSONAL?.reminders || []).filter(r => !r.done && r.due && new Date(r.due) >= new Date(now - 36e5)).slice(0, 3);
  box.innerHTML = `<div class="cc-today-date">${esc(now.toLocaleDateString([], {weekday:'long', day:'numeric', month:'long'}))}</div>`
    + (w ? `<div class="cc-today-weather"><b>${Math.round(w.temp)}°</b><span>${esc(w.summary)} · H ${Math.round(w.high)}° L ${Math.round(w.low)}°${w.rain != null ? ` · rain ${w.rain}%` : ''}</span><small>${esc(lastBrief.city)}</small></div>` : '')
    + (upcoming.length ? `<ul class="cc-today-list">${upcoming.map(r => `<li><span>${esc(fmtDue(r.due))}</span>${esc(r.text)}</li>`).join('')}</ul>` : '<div class="cc-empty">No upcoming reminders.</div>')
    + (lastBrief?.news?.length ? `<div class="cc-today-news"><b>Headline</b> ${esc(lastBrief.news[0].title)}</div>` : '');
}
async function fetchBrief(kind = 'morning'){
  const r = await fetch(`/api/personal/brief?kind=${kind === 'evening' ? 'evening' : 'morning'}`, {headers:apiHeaders(), cache:'no-store'});
  if (!r.ok) throw new Error(`brief unavailable (HTTP ${r.status})`);
  lastBrief = await r.json();
  renderToday(); renderBriefPreview(lastBrief);
  return lastBrief;
}
function renderBriefPreview(b){
  const box = $('#briefPreview'); if (!box || !b) return;
  const w = b.weather;
  box.innerHTML = `<h3>${esc(b.date)}</h3>`
    + (w ? `<p><b>${esc(b.city)}:</b> ${Math.round(w.temp)}° ${esc(w.summary)}, high ${Math.round(w.high)}°, low ${Math.round(w.low)}°</p>` : '')
    + (b.events.length ? `<p><b>Schedule:</b> ${b.events.map(e => esc(`${e.time} ${e.title}`)).join(' · ')}</p>` : '')
    + `<p><b>Reminders:</b> ${b.reminders.length ? b.reminders.map(r => esc(`${r.time} ${r.text}`)).join(' · ') : 'none'}</p>`
    + (b.news.length ? `<ol>${b.news.map(n => `<li><a href="${escapeAttr(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a> <small>${esc(n.source)}</small></li>`).join('')}</ol>` : '')
    + (b.errors.length ? `<p class="form-note">${esc(b.errors.join(' · '))}</p>` : '');
}
function announce(text){
  if (liveReady && liveWs?.readyState === WebSocket.OPEN){
    liveWs.send(JSON.stringify({clientContent:{turns:[{role:'user', parts:[{text:`Announce this to me now, briefly and naturally in my language: ${text}`}]}], turnComplete:true}}));
    return Promise.resolve();
  }
  return speak(text);
}
async function playBrief(kind){
  const hour = new Date().getHours();
  const b = await fetchBrief(kind || (hour >= 16 ? 'evening' : 'morning'));
  log('complete','BRIEF', b.speech.slice(0, 200));
  setUserText('Daily brief'); answer = b.speech; renderAnswer(true);
  await announce(b.speech);
  return b;
}

async function youtubeResults(query){
  const r = await fetch(`/api/youtube-search?q=${encodeURIComponent(query)}`, {headers:apiHeaders()});
  const data = await r.json();
  if (!r.ok || !data.results?.length) throw new Error(data.error || 'Nothing found on YouTube');
  return data;
}
async function playMusic(query){
  const data = await youtubeResults(query);
  const ids = data.results.map(v => v.id);
  const url = `https://www.youtube.com/embed/${ids[0]}?autoplay=1&playsinline=1&rel=0` + (ids.length > 1 ? `&playlist=${ids.slice(1).join(',')}` : '');
  showView('chat');
  setFrameUrl(url, `Music · ${data.best.title}`);
  const ytm = `https://music.youtube.com/watch?v=${ids[0]}`;
  showToast(`Playing: ${data.best.title}`, 'info', {url: ytm, label: 'Open in YouTube Music'});
  log('complete','MUSIC', `${data.best.title} (+${ids.length - 1} queued)`);
  return {playing: data.best.title, queued: ids.length - 1, youtube_music_link: ytm};
}
async function playVideo(query){
  const data = await youtubeResults(query);
  showView('chat');
  setFrameUrl(data.best.embed, `Video · ${data.best.title}`);
  showToast(`Showing: ${data.best.title}`, 'info', {url: data.best.url, label: 'Open on YouTube'});
  log('complete','VIDEO', data.best.title);
  return {showing: data.best.title, other_results: data.results.slice(1, 4).map(v => v.title)};
}
const PROVIDER_ALIASES = {google:'gemini', gemini:'gemini', claude:'anthropic', anthropic:'anthropic', gpt:'openai', chatgpt:'openai', openai:'openai',
  openrouter:'openrouter', ollama:'ollama', local:'ollama', hermes:'hermes', default:'hermes'};
async function switchModel(provider, model){
  const key = PROVIDER_ALIASES[String(provider || '').toLowerCase().replace(/[^a-z]/g, '')];
  if (!key || !WS?.models?.[key]) throw new Error(`Unknown provider "${provider}". Use gemini, openai, anthropic, openrouter, ollama or hermes.`);
  const chosen = String(model || '').trim() || WS.models[key][0];
  await workspaceRequest({action:'save_settings', settings:{...WS.settings, provider:key, model:chosen, apiBase:WS.settings.apiBase || ''}});
  refreshStatus();
  log('complete','MODEL', `Hermes now thinks with ${providerLabel(key)} · ${chosen}`);
  showToast(`Model: ${providerLabel(key)} · ${chosen}`);
  return {provider:key, model:chosen};
}
async function addReminderFromText(text, due = '', repeat = ''){
  const data = await personalRequest({action:'add_reminder', text, due, repeat});
  const it = data.item;
  showToast(`Reminder saved: ${it.text} — ${fmtDue(it.due)}`);
  log('complete','REMINDER', `${it.text} · ${fmtDue(it.due)}`);
  return it;
}

const LOCAL_TOOLS = {
  get_conversation_status: async () => {
    const r=await fetch('/api/history?'+new URLSearchParams(liveChat||chatRef()),{headers:apiHeaders(),cache:'no-store'});
    const data=await r.json();
    if(!r.ok)throw Error(data.error||'Could not read the conversation');
    return {actions:(data.runs||[]).slice(0,4).map(run=>({state:run.state,detail:run.detail,result:run.answer.slice(-8000)})),
      instruction:'Report these saved outcomes accurately. A running request is still in progress; do not dispatch it again.'};
  },
  add_reminder: async a => { const it = await addReminderFromText(a.text, a.due || '', a.repeat || ''); return {saved:true, text:it.text, due:it.due || 'no time set'}; },
  get_daily_brief: async a => { const b = await fetchBrief(a.kind); return {brief:b.speech, date:b.date, weather:b.weather, events:b.events, reminders:b.reminders, headlines:b.news.map(n => n.title)}; },
  play_music: async a => playMusic(a.query),
  play_video: async a => playVideo(a.query),
  switch_model: async a => switchModel(a.provider, a.model),
  sleep_mode: async () => { setTimeout(() => { if (convo) stopConvo(); }, 2500); return {ok:true, note:'Say a very short goodbye now.'}; },
  get_markets: async () => { const m = await loadMarkets(); return {note:m.note, top5:m.top5.map(q => ({name:q.name, price:q.price, change_pct:q.change})), watchlist:m.watchlist.map(q => ({name:q.name, price:q.price, change_pct:q.change}))}; },
  set_price_alert: async a => { await marketsRequest({action:'add_alert', symbol:a.symbol, direction:a.direction, price:a.price}); return {saved:true}; },
  create_image: async a => { const r = await createImage(a.prompt); return {created:true, file:r.name}; },
  create_video: async a => { await createVideo(a.prompt); return {started:true, note:'It takes 1 to 5 minutes; I will announce it when ready.'}; },
  find_books: async a => { showView('library'); const list = await searchBooks(a.query); return {found:list.slice(0, 5).map(b => `${b.title} by ${b.authors}`)}; },
  point_at: async a => pointAt(a.description),
  clear_screen_drawing: async () => { await overlayCommand({type:'clear'}); return {cleared:true}; },
  find_new_skills: async a => { const d = await skillsRequest({action:'scout', topic:a.topic || ''}); return {found:d.found.map(p => `${p.name}: ${p.description.slice(0, 80)}`), note:'Ask the user which one to install; install only after a clear yes.'}; },
  install_skill: async a => {
    if (!/^(yes|true|نعم|اه|أيوه|ايوه)$/i.test(String(a.confirmed || '').trim())) return {installed:false, note:'Ask the user to confirm first.'};
    const list = PROPOSALS.filter(p => p.status === 'new');
    const pick = list.find(p => p.name.toLowerCase() === String(a.name || '').toLowerCase()) || list.find(p => p.name.toLowerCase().includes(String(a.name || '').toLowerCase()));
    if (!pick) return {installed:false, note:'No matching proposal. Use find_new_skills first.'};
    const d = await skillsRequest({action:'approve', id:pick.id, confirmed:true});
    return {installed:true, name:d.item.name};
  },
  autocad_task: async (a, signal) => executeLiveAction(cadTaskPrompt(a.request), signal),
};

// Slash commands handled instantly in the page.
async function handleLocalCommand(message){
  const m = message.trim().match(/^\/(music|play|video|model|brief|remind|reminder)\b\s*(.*)$/is);
  if (!m) return false;
  const [, cmd, arg] = m;
  if (cmd === 'music' || cmd === 'play'){ if (!arg) throw new Error('Type what to play, e.g. /music Amr Diab'); await playMusic(arg); return true; }
  if (cmd === 'video'){ if (!arg) throw new Error('Type what to find, e.g. /video resin table pour'); await playVideo(arg); return true; }
  if (cmd === 'brief'){ await playBrief(/evening|tonight|مساء/i.test(arg) ? 'evening' : undefined); return true; }
  if (cmd === 'model'){ const [provider, ...rest] = arg.split(/\s+/); await switchModel(provider, rest.join(' ')); return true; }
  if (!arg) throw new Error('Type the reminder, e.g. /remind call mom tomorrow 6pm');
  await addReminderFromText(arg); return true;
}

// "Hey Zuzu" wake word (Chrome / Edge on the laptop).
function startWakeListener(){
  if (!wakeWanted || !SpeechRecognition || wakeRec || convo || liveConnecting) return;
  const rec = new SpeechRecognition();
  rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
  rec.onresult = e => {
    const heard = [...e.results].slice(e.resultIndex).map(r => r[0].transcript).join(' ');
    if (WAKE_RE.test(heard)){ stopWakeListener(); log('voice','WAKE','"Hey Zuzu" heard'); micToggle(); }
  };
  rec.onerror = e => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed'){ wakeWanted = false; log('error','WAKE','microphone permission is needed for the wake word'); } };
  rec.onend = () => { wakeRec = null; if (wakeWanted && !convo && !liveConnecting) setTimeout(startWakeListener, 500); };
  try{ rec.start(); wakeRec = rec; document.body.classList.add('wake-on'); }catch(_){ wakeRec = null; }
}
function stopWakeListener(){
  const rec = wakeRec; wakeRec = null; document.body.classList.remove('wake-on');
  if (rec){ rec.onend = null; try{ rec.stop(); }catch(_){} }
}
function setWakeWord(on){
  wakeWanted = !!on && !!SpeechRecognition;
  if (on && !SpeechRecognition) log('error','WAKE','this browser has no speech recognition; use Chrome or Edge on the laptop');
  wakeWanted ? startWakeListener() : stopWakeListener();
}

// Spoken announcements: due reminders and scheduled briefs.
async function pollPersonalInbox(){
  if (document.visibilityState === 'hidden') return;
  try{
    const r = await fetch('/api/personal/inbox', {headers:apiHeaders(), cache:'no-store'});
    if (!r.ok) return;
    for (const item of (await r.json()).items || []){
      if (item.kind === 'memory'){ showToast(`🧠 ${item.text.slice(0, 200)}`, 'info'); log('complete', 'MEMORY', item.text.slice(0, 200)); loadWorkspace(); continue; }
      if (item.kind === 'brief'){ lastBrief = item.payload; renderToday(); renderBriefPreview(lastBrief); }
      if (item.kind === 'media' && item.payload?.url && item.payload.kind === 'video'){ showView('chat'); showVideoFile(item.payload.url); refreshMediaJobs(); loadWorkspace(); }
      else if (item.kind === 'media'){ if (typeof refreshCreativeJobs === 'function') refreshCreativeJobs(); loadWorkspace(); }
      showToast(item.text.slice(0, 220), item.kind === 'reminder' ? 'reminder' : 'info');
      log('note', item.kind.toUpperCase(), item.text.slice(0, 200));
      if (!running) await announce(item.text);
    }
    if (++inboxPolls % 3 === 0) loadPersonal();
  }catch(_){}
}

$('#reminderForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('#reminderText').value.trim(); if (!text) return;
  const due = $('#reminderDue').value, repeat = $('#reminderRepeat').value;
  try{ await addReminderFromText(text, due, repeat); $('#reminderText').value = ''; $('#reminderDue').value = ''; $('#reminderRepeat').value = ''; }
  catch(err){ showToast(String(err.message || err), 'error'); }
});
$('#briefForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  try{
    await personalRequest({action:'save_settings', settings:{city:$('#pfCity').value, briefMorning:$('#pfMorning').value, briefEvening:$('#pfEvening').value,
      newsRegion:$('#pfRegion').value, newsLang:$('#pfLang').value, newsTopic:$('#pfTopic').value, calendarIcs:$('#pfIcs').value,
      telegramTarget:$('#pfTelegram').value, briefsEnabled:$('#pfBriefs').checked, wakeWord:$('#pfWake').checked}});
    showToast('Daily brief settings saved'); fetchBrief().catch(() => {});
  }catch(err){ showToast(String(err.message || err), 'error'); }
});
document.addEventListener('click', async e => {
  const done = e.target.closest('[data-rem-done]');
  const del = e.target.closest('[data-rem-delete]');
  const brief = e.target.closest('[data-cc-brief]');
  try{
    if (done) await personalRequest({action:'update_reminder', id:done.dataset.remDone, done:done.checked});
    if (del) await personalRequest({action:'delete_reminder', id:del.dataset.remDelete});
    if (brief) await playBrief();
  }catch(err){ showToast(String(err.message || err), 'error'); }
});
$('#briefNow')?.addEventListener('click', () => playBrief().catch(err => showToast(String(err.message || err), 'error')));
$('#ccAddReminder')?.addEventListener('click', () => { const input = $('#input'); input.value = '/remind '; input.focus(); });

loadPersonal();
fetchBrief().catch(() => {});
setInterval(pollPersonalInbox, 20000);
setInterval(() => fetchBrief().catch(() => {}), 30 * 60 * 1000);
setInterval(renderToday, 60000);

// ══════════ markets ══════════
let MARKETS = null;
async function marketsRequest(payload){
  const r = await fetch('/api/markets', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify(payload)});
  const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  MARKETS = data; renderMarkets(); return data;
}
async function loadMarkets(){
  const r = await fetch('/api/markets', {headers:apiHeaders(), cache:'no-store'});
  const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  MARKETS = data; renderMarkets(); return data;
}
function sparkline(values){
  if (!values || values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1) * 100).toFixed(1)},${(28 - (v - min) / span * 26).toFixed(1)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return `<svg class="mk-spark ${up ? 'up' : 'down'}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
}
const fmtPrice = q => q.price == null ? '—' : Number(q.price).toLocaleString([], {maximumFractionDigits: q.price < 5 ? 4 : 2});
const fmtChange = c => `${c > 0 ? '+' : ''}${Number(c).toFixed(2)}%`;
function renderMarkets(){
  if (!MARKETS) return;
  const top = MARKETS.top5 || [];
  const card = q => `<div class="mk-card ${q.change >= 0 ? 'up' : 'down'}"><div><b>${esc(q.name)}</b><small>${esc(q.symbol)}</small></div>
      <div class="mk-price">${esc(fmtPrice(q))}<span>${esc(fmtChange(q.change))}</span></div>${sparkline(q.spark)}
      <small class="mk-meta">5-day ${esc(fmtChange(q.trend5d))} · ${q.bias === 'flat' ? 'quiet' : q.bias === 'up' ? 'buyers in control' : 'sellers in control'}</small></div>`;
  if ($('#mkTop')) $('#mkTop').innerHTML = top.map(card).join('') || '<div class="empty-state">Market data is unavailable right now.</div>';
  const row = (q, extra) => `<div class="mk-row"><b>${esc(q.name)}</b><span>${esc(fmtPrice(q))}</span><em class="${(q.change || 0) >= 0 ? 'up' : 'down'}">${q.error ? esc(q.error) : esc(fmtChange(q.change))}</em>${extra}</div>`;
  if ($('#mkWatch')) $('#mkWatch').innerHTML = (MARKETS.watchlist || []).map(q => row(q, `<button type="button" class="danger-link" data-mk-unwatch="${esc(q.symbol)}">×</button>`)).join('') || '<div class="empty-state">Nothing on your watchlist yet.</div>';
  if ($('#mkAlerts')) $('#mkAlerts').innerHTML = (MARKETS.alerts || []).map(a => `<div class="mk-row ${a.fired ? 'fired' : ''}"><b>${esc(a.name)}</b><span>${esc(a.direction)} ${esc(a.price)}</span><em>${a.fired ? 'triggered' : 'waiting'}</em><button type="button" class="danger-link" data-mk-alert-del="${esc(a.id)}">×</button></div>`).join('') || '<div class="empty-state">No alerts yet.</div>';
  if ($('#mkUpdated')) $('#mkUpdated').textContent = `Updated ${MARKETS.updated}`;
  const home = $('#ccMarkets');
  if (home) home.innerHTML = top.slice(0, 5).map(q => `<div class="cc-mk"><span>${esc(q.name)}</span><b>${esc(fmtPrice(q))}</b><em class="${q.change >= 0 ? 'up' : 'down'}">${esc(fmtChange(q.change))}</em></div>`).join('') || '<div class="cc-empty">Markets unavailable.</div>';
}
$('#mkWatchForm')?.addEventListener('submit', async e => { e.preventDefault(); try{ await marketsRequest({action:'watch', symbol:$('#mkSymbol').value}); $('#mkSymbol').value=''; }catch(err){ showToast(String(err.message||err),'error'); } });
$('#mkAlertForm')?.addEventListener('submit', async e => { e.preventDefault(); try{ await marketsRequest({action:'add_alert', symbol:$('#mkAlertSymbol').value, direction:$('#mkAlertDir').value, price:$('#mkAlertPrice').value}); $('#mkAlertPrice').value=''; showToast('Price alert saved'); }catch(err){ showToast(String(err.message||err),'error'); } });
document.addEventListener('click', async e => {
  const un = e.target.closest('[data-mk-unwatch]'), del = e.target.closest('[data-mk-alert-del]');
  try{
    if (un) await marketsRequest({action:'unwatch', symbol:un.dataset.mkUnwatch});
    if (del) await marketsRequest({action:'delete_alert', id:del.dataset.mkAlertDel});
  }catch(err){ showToast(String(err.message||err),'error'); }
});
function marketsVisible(){ const home = !$('[data-view-panel="chat"]')?.hidden, page = !$('[data-view-panel="markets"]')?.hidden; return document.visibilityState === 'visible' && (home || page); }
loadMarkets().catch(() => { if ($('#ccMarkets')) $('#ccMarkets').innerHTML = '<div class="cc-empty">Markets unavailable.</div>'; });
setInterval(() => { if (marketsVisible()) loadMarkets().catch(() => {}); }, 60000);

// ══════════ library ══════════
let BOOK = null, bookListening = false;
async function searchBooks(query = '', topic = ''){
  const lang = $('#bkLang')?.value || '';
  $('#bkResults').innerHTML = '<div class="empty-state">Searching the library…</div>';
  const r = await fetch(`/api/books/search?q=${encodeURIComponent(query)}&topic=${encodeURIComponent(topic)}&lang=${encodeURIComponent(lang)}`, {headers:apiHeaders()});
  const data = await r.json();
  if (!r.ok){ $('#bkResults').innerHTML = `<div class="empty-state">${esc(data.error || 'Library unavailable')}</div>`; throw new Error(data.error || 'Library unavailable'); }
  const list = data.results || [];
  $('#bkResults').innerHTML = list.filter(b => b.readable).map(b => `<button type="button" class="bk-card" data-bk-open="${esc(b.id)}">
      ${b.cover ? `<img src="${escapeAttr(b.cover)}" alt="" loading="lazy">` : '<div class="bk-nocover">📖</div>'}
      <b>${esc(b.title)}</b><small>${esc(b.authors || 'Unknown author')}</small></button>`).join('') || '<div class="empty-state">No readable books found.</div>';
  return list;
}
async function loadShelf(){
  try{
    const r = await fetch('/api/books/shelf', {headers:apiHeaders()}); const data = await r.json();
    const shelf = data.shelf || [];
    const box = $('#bkShelf'); if (!box) return;
    box.hidden = !shelf.length;
    box.innerHTML = '<h3>Continue reading</h3>' + shelf.map(b => `<button type="button" class="bk-cont" data-bk-open="${esc(b.id)}">${esc(b.title)} <small>page ${b.page + 1} of ${b.pages}</small></button>`).join('');
  }catch(_){}
}
async function openBook(id, pageNo){
  const r = await fetch(`/api/books/page?id=${encodeURIComponent(id)}${pageNo != null ? `&page=${pageNo}` : ''}`, {headers:apiHeaders()});
  const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Could not open the book');
  BOOK = data;
  $('#bkReader').hidden = false;
  $('#bkTitle').textContent = data.title; $('#bkAuthor').textContent = data.authors;
  $('#bkText').textContent = data.text;
  $('#bkPage').textContent = `Page ${data.page + 1} of ${data.pages}`;
  $('#bkPrev').disabled = data.page === 0; $('#bkNext').disabled = data.page >= data.pages - 1;
  $('#bkBriefText').hidden = !data.brief; $('#bkBriefText').textContent = data.brief || '';
  $('#bkReader').scrollIntoView({block:'start', behavior:'smooth'});
  loadShelf();
  return data;
}
async function listenLoop(){
  while (bookListening && BOOK){
    const chunks = BOOK.text.match(/[^.!?؟\n]{1,600}(?:[.!?؟]+|\n|$)/g) || [BOOK.text];
    let part = '';
    for (const piece of chunks){
      if ((part + piece).length > 620 && part){ if (!bookListening) break; await speak(part); part = ''; }
      part += piece;
    }
    if (bookListening && part.trim()) await speak(part);
    if (!bookListening || BOOK.page >= BOOK.pages - 1) break;
    await openBook(BOOK.id, BOOK.page + 1);
  }
  bookListening = false; $('#bkListen').textContent = 'Listen';
}
$('#bkSearchForm')?.addEventListener('submit', e => { e.preventDefault(); searchBooks($('#bkQuery').value.trim()).catch(() => {}); });
document.addEventListener('click', e => {
  const topic = e.target.closest('[data-bk-topic]'), open = e.target.closest('[data-bk-open]');
  if (topic) searchBooks('', topic.dataset.bkTopic).catch(() => {});
  if (open) openBook(open.dataset.bkOpen).catch(err => showToast(String(err.message||err),'error'));
});
$('#bkPrev')?.addEventListener('click', () => BOOK && openBook(BOOK.id, BOOK.page - 1));
$('#bkNext')?.addEventListener('click', () => BOOK && openBook(BOOK.id, BOOK.page + 1));
$('#bkClose')?.addEventListener('click', () => { bookListening = false; stopSpeech(); $('#bkReader').hidden = true; });
$('#bkListen')?.addEventListener('click', () => {
  if (bookListening){ bookListening = false; stopSpeech(); $('#bkListen').textContent = 'Listen'; return; }
  bookListening = true; $('#bkListen').textContent = 'Stop listening'; listenLoop();
});
$('#bkBrief')?.addEventListener('click', async () => {
  if (!BOOK) return;
  const btn = $('#bkBrief'); btn.disabled = true; btn.textContent = 'Reading the book…';
  try{
    const r = await fetch('/api/books', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify({action:'brief', id:BOOK.id, language:/[؀-ۿ]/.test(WS?.settings?.persona || '') ? 'Egyptian Arabic' : 'English'})});
    const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Brief failed');
    $('#bkBriefText').hidden = false; $('#bkBriefText').textContent = data.brief;
    announce(data.brief);
  }catch(err){ showToast(String(err.message||err),'error'); }
  finally{ btn.disabled = false; btn.textContent = 'Brief this book'; }
});
loadShelf();

// ══════════ image & video creation ══════════
function showVideoFile(url){
  const video = $('#visualPreview'), img = $('#visualImage'), frame = $('#visualFrame'), empty = $('#visualEmpty');
  stopVisualStream();
  if (frame){ frame.hidden = true; frame.removeAttribute('src'); }
  if (img) img.hidden = true; if (empty) empty.hidden = true;
  if (video){ video.srcObject = null; video.src = url; video.controls = true; video.muted = false; video.hidden = false; video.setAttribute('data-active', 'file'); video.play().catch(() => {}); }
  setVisualStatus('Zuzu video'); setVisionBox(true); document.body.classList.add('vision-on');
}
async function createImage(prompt){
  showToast('Creating your image…');
  const r = await fetch('/api/media', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify({kind:'image', prompt})});
  const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Image failed');
  const blob = await (await fetch(data.url, {headers:apiHeaders()})).blob();
  showView('chat'); showImageBlob(blob, 'Zuzu image');
  showToast('Image ready', 'info', {url:data.url, label:'Open full size'});
  log('complete','IMAGE', data.name); loadWorkspace();
  return data;
}
async function createVideo(prompt){
  const r = await fetch('/api/media', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify({kind:'video', prompt})});
  const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Video failed');
  showToast('Video started — Zuzu will announce it when ready (1–5 min)');
  log('run','VIDEO', `started: ${prompt.slice(0, 80)}`); refreshMediaJobs();
  return data;
}
async function refreshMediaJobs(){
  try{
    const data = await (await fetch('/api/media/jobs', {headers:apiHeaders()})).json();
    const box = $('#mediaJobs'); if (!box) return;
    box.innerHTML = (data.jobs || []).slice(-5).reverse().map(j => `<div class="mk-row"><b>${esc(j.prompt.slice(0, 50))}</b><span>${esc(j.status)}</span>${j.url ? `<a href="${escapeAttr(j.url)}" target="_blank" rel="noopener">open</a>` : `<em>${esc(j.error || '')}</em>`}</div>`).join('');
  }catch(_){}
}
refreshMediaJobs();

// ══════════ live PC control: see the screen and every step while Hermes works ══════════
const PC_INTENT_RE = /^\/(?:pc|computer)\b|\b(?:open|close|launch|run|click|tap|type|press|download|install|uninstall|move|rename|delete|control|navigate|switch to|minimi[sz]e|maximi[sz]e)\b.*\b(?:pc|computer|laptop|desktop|windows|chrome|edge|browser|file|folder|app|application|notepad|calculator|excel|word|powerpoint|outlook|teams|whatsapp|settings|explorer|spotify)\b|(?:افتح|اقفل|شغل|اضغط|اكتب|نزل|حمل|احذف|انقل|غير).*(?:الكمبيوتر|اللابتوب|الويندوز|كروم|إيدج|المتصفح|ملف|مجلد|برنامج)/i;
let STEPS = [], pcAutoLive = false;
function resetSteps(){ STEPS = []; renderSteps(); }
function pushStep(ev){
  if (ev.phase === 'use' || !STEPS.length || STEPS[STEPS.length - 1].done){
    STEPS.push({name: ev.name || 'step', input: ev.input || '', done: ev.phase !== 'use', ok: ev.ok !== false});
  } else {
    Object.assign(STEPS[STEPS.length - 1], {done: true, ok: ev.ok !== false});
  }
  STEPS = STEPS.slice(-8); renderSteps();
}
function renderSteps(){
  const box = $('#ccSteps'); if (!box) return;
  box.hidden = !STEPS.length;
  box.innerHTML = STEPS.map(s => `<li class="${s.done ? (s.ok ? 'ok' : 'fail') : 'live'}"><b>${esc(s.name)}</b>${s.input ? `<span>${esc(s.input.slice(0, 90))}</span>` : ''}</li>`).join('');
}
function watchPc(message){
  if (!PC_INTENT_RE.test(String(message || ''))) return;
  if (visualKind !== 'laptop-live'){ pcAutoLive = true; startLaptopLive().catch(() => {}); log('status','PC','showing your laptop screen live while Hermes works'); }
}
function finishSteps(){
  STEPS.forEach(s => { s.done = true; }); renderSteps();
  if (pcAutoLive){ pcAutoLive = false; setTimeout(() => { if (!running) stopLaptopScreen(); }, 6000); }
}

// ══════════ drawing on the laptop screen (from the laptop or the phone) ══════════
let drawMode = false, drawPoints = [];
async function overlayCommand(cmd){
  const r = await fetch('/api/overlay', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify(cmd)});
  const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Drawing failed');
  return data;
}
async function pointAt(description){
  showToast(`Looking for: ${description}`);
  const r = await fetch('/api/overlay/point', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify({description})});
  const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Could not point');
  if (!data.found) showToast(`I couldn't see "${description}" on the screen`, 'error');
  else log('complete','POINT', `pointed at ${data.label}`);
  return data.found ? {pointed:true, at:data.label} : {pointed:false, note:'Not visible on the screen right now.'};
}
function imageContentRect(img){
  const box = img.getBoundingClientRect();
  const nw = img.naturalWidth || box.width, nh = img.naturalHeight || box.height;
  const scale = Math.min(box.width / nw, box.height / nh);
  const w = nw * scale, h = nh * scale;
  return {left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h};
}
function setDrawMode(on){
  drawMode = !!on;
  const canvas = $('#drawCanvas'), img = $('#visualImage'), btn = $('#drawScreen');
  if (btn){ btn.classList.toggle('on', drawMode); btn.textContent = drawMode ? 'Drawing…' : 'Draw'; }
  if (!canvas) return;
  canvas.hidden = !drawMode;
  if (drawMode && img){
    const parent = canvas.parentElement.getBoundingClientRect();
    canvas.width = parent.width; canvas.height = parent.height;
  }
}
function canvasPoint(e){
  const img = $('#visualImage'), rect = imageContentRect(img);
  return {nx: (e.clientX - rect.left) / rect.width, ny: (e.clientY - rect.top) / rect.height};
}
$('#drawScreen')?.addEventListener('click', () => setDrawMode(!drawMode));
$('#clearDrawing')?.addEventListener('click', () => overlayCommand({type:'clear'}).catch(err => showToast(String(err.message||err),'error')));
(() => {
  const canvas = $('#drawCanvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.addEventListener('pointerdown', e => { drawPoints = []; canvas.setPointerCapture(e.pointerId); const p = canvasPoint(e); drawPoints.push([p.nx, p.ny]);
    const b = canvas.getBoundingClientRect(); ctx.strokeStyle = '#ffad35'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(e.clientX - b.left, e.clientY - b.top); });
  canvas.addEventListener('pointermove', e => { if (!drawPoints.length || !(e.buttons & 1)) return; const p = canvasPoint(e); drawPoints.push([p.nx, p.ny]);
    const b = canvas.getBoundingClientRect(); ctx.lineTo(e.clientX - b.left, e.clientY - b.top); ctx.stroke(); });
  canvas.addEventListener('pointerup', async () => {
    const pts = drawPoints.filter(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1); drawPoints = [];
    setTimeout(() => ctx.clearRect(0, 0, canvas.width, canvas.height), 1200);
    if (pts.length > 1){ try{ await overlayCommand({type:'path', points:pts, ttl:20}); }catch(err){ showToast(String(err.message||err),'error'); } }
  });
})();

// ══════════ skill suggestions ══════════
let PROPOSALS = [];
async function skillsRequest(payload){
  const r = await fetch('/api/skills', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify(payload)});
  const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  PROPOSALS = data.proposals || PROPOSALS; renderProposals(); return data;
}
async function loadProposals(){
  try{ const data = await (await fetch('/api/skills/proposals', {headers:apiHeaders()})).json(); PROPOSALS = data.proposals || []; renderProposals(); }catch(_){}
}
function renderProposals(){
  const box = $('#skProposals'); if (!box) return;
  const open = PROPOSALS.filter(p => p.status === 'new').reverse(), done = PROPOSALS.filter(p => p.status !== 'new').slice(-4).reverse();
  box.innerHTML = open.map(p => `<div class="sk-item"><div><b>${esc(p.name)}</b> <small>${esc(p.kind)} · ${esc(p.source || 'Hermes')}${p.trust ? ' · ' + esc(p.trust) : ''}</small><p>${esc(p.description || 'No description')}</p><small>Found while looking for: ${esc(p.reason)}</small></div>
      <div class="sk-actions"><button type="button" class="primary-btn" data-sk-approve="${esc(p.id)}">Install</button><button type="button" class="secondary-btn" data-sk-dismiss="${esc(p.id)}">Dismiss</button></div></div>`).join('')
    + done.map(p => `<div class="mk-row"><b>${esc(p.name)}</b><span>${esc(p.kind)}</span><em>${esc(p.status)}</em></div>`).join('')
    || '<div class="empty-state">No suggestions yet. Ask Zuzu to look for skills.</div>';
  const st = PERSONAL?.settings;
  if (st && !$('#skScoutForm').contains(document.activeElement)){ $('#skAuto').checked = !!st.skillScout; $('#skDays').value = String(st.skillScoutDays || 7); }
}
$('#skScoutForm')?.addEventListener('submit', async e => {
  e.preventDefault(); const btn = e.submitter; if (btn){ btn.disabled = true; btn.textContent = 'Searching…'; }
  try{ const d = await skillsRequest({action:'scout', topic:$('#skTopic').value}); showToast(d.found.length ? `Found ${d.found.length} new skills` : 'No new skills found this time'); }
  catch(err){ showToast(String(err.message||err),'error'); }
  finally{ if (btn){ btn.disabled = false; btn.textContent = 'Look for skills'; } }
});
['#skAuto', '#skDays'].forEach(sel => $(sel)?.addEventListener('change', () => personalRequest({action:'save_settings', settings:{skillScout:$('#skAuto').checked, skillScoutDays:$('#skDays').value}}).catch(() => {})));
document.addEventListener('click', async e => {
  const ok = e.target.closest('[data-sk-approve]'), no = e.target.closest('[data-sk-dismiss]');
  if (!ok && !no) return;
  try{
    if (ok){
      const item = PROPOSALS.find(p => p.id === ok.dataset.skApprove);
      if (!confirm(`Install "${item?.name}" into Hermes?`)) return;
      ok.disabled = true; ok.textContent = 'Installing…';
      const d = await skillsRequest({action:'approve', id:ok.dataset.skApprove, confirmed:true}); showToast(`Installed ${d.item.name}`);
    }
    if (no) await skillsRequest({action:'dismiss', id:no.dataset.skDismiss});
  }catch(err){ showToast(String(err.message||err),'error'); renderProposals(); }
});
loadProposals();

$('#cadRefresh')?.addEventListener('click',()=>refreshCad(true));
$('#cadRun')?.addEventListener('click',()=>{const q=$('#cadRequest')?.value.trim();if(!q)return showToast('Write the AutoCAD task first.','error');showView('chat');transmit(cadTaskPrompt(q));});
document.querySelectorAll('[data-cad-prompt]').forEach(b=>b.addEventListener('click',()=>{showView('chat');transmit(cadTaskPrompt(b.dataset.cadPrompt));}));
refreshCad(false);

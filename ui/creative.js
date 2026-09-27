/* Zuzu creative studio: photo editor (adjust, crop, draw, arrows, text, AI edits, undo/redo,
   before/after), room redesign, resin & wood calculator, shop listing, music (Lyria) and 3D (Meshy).
   Loaded after app.js and uses its helpers ($, esc, apiHeaders, showToast, showView). */

const CR = {tab: 'editor', styles: [], style: '', quote: null, meshy: false, poll: null, rooms: [], designs: []};

async function crApi(payload){
  const r = await fetch('/api/creative', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify(payload)});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
async function crUpload(blob, name){
  const r = await fetch('/api/upload', {method:'POST', headers:apiHeaders({'content-type':blob.type || 'image/jpeg', 'x-filename':name}), body:blob});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Upload failed (HTTP ${r.status})`);
  return data.url;
}
function crTab(name){
  CR.tab = name;
  document.querySelectorAll('[data-cr-tab]').forEach(b => b.classList.toggle('active', b.dataset.crTab === name));
  document.querySelectorAll('[data-cr-pane]').forEach(p => p.hidden = p.dataset.crPane !== name);
  try{ localStorage.setItem('zuzu-creative-tab', name); }catch(_){}
  if (name === 'editor') edFit();
  if (name === 'music' || name === 'model3d') refreshCreativeJobs();
}
function crBusy(button, busy, text){
  if (!button) return;
  if (busy){ button.dataset.label = button.textContent; button.textContent = text || 'Working…'; button.disabled = true; }
  else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; }
}
async function crPick(input, preview){
  const file = input.files?.[0]; if (!file) return '';
  if (preview){ preview.src = URL.createObjectURL(file); preview.hidden = false; }
  input.dataset.url = await crUpload(file, file.name || 'photo.jpg');
  return input.dataset.url;
}
function crCard(item, title){
  return `<figure class="cr-card"><img src="${esc(item.url)}" alt="${esc(title || item.prompt || 'result')}" loading="lazy">
    <figcaption><span>${esc(title || item.prompt || '')}</span><span class="cr-card-actions"><button type="button" data-ed-open="${esc(item.url)}">Edit</button><a href="${esc(item.url)}" download>Download</a></span></figcaption></figure>`;
}

// ── photo editor ─────────────────────────────────────────────────────
const ED = {base:null, history:[], idx:-1, adjust:{b:0, c:0, s:0, w:0}, mode:'', drag:null, crop:null, stroke:null, comparing:false, frame:0};
const edCanvas = $('#edCanvas'), edCtx = edCanvas?.getContext('2d');
function edCopy(src){ const c = document.createElement('canvas'); c.width = src.width; c.height = src.height; c.getContext('2d').drawImage(src, 0, 0); return c; }
function edPush(canvas){
  ED.history = ED.history.slice(0, ED.idx + 1); ED.history.push(canvas);
  if (ED.history.length > 25) ED.history.splice(1, 1);           // keep the original at index 0
  ED.idx = ED.history.length - 1; ED.base = canvas; edResetAdjust(false); edRender(); edButtons();
}
function edButtons(){
  const has = !!ED.base;
  $('#edUndo').disabled = ED.idx <= 0; $('#edRedo').disabled = ED.idx >= ED.history.length - 1;
  ['#edCompare', '#edSave', '#edDownload', '#edAi', '#edApplyAdjust'].forEach(s => { const b = $(s); if (b) b.disabled = !has; });
  $('#edEmpty').hidden = has; edCanvas.hidden = !has;
}
async function edLoad(src, fresh = true){
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.src = src instanceof Blob ? URL.createObjectURL(src) : src;
  await img.decode();
  const scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  if (fresh){ ED.history = []; ED.idx = -1; }
  edPush(c); edFit();
}
function edFit(){ /* CSS keeps the canvas inside the stage; nothing to measure */ }
function adjustPixels(data, a){
  const d = data.data, C = a.c * 2.55, f = (259 * (C + 255)) / (255 * (259 - C)), sat = 1 + a.s / 100, bri = a.b * 1.1, warm = a.w * 0.35;
  for (let i = 0; i < d.length; i += 4){
    let r = f * (d[i] + bri - 128) + 128, g = f * (d[i + 1] + bri - 128) + 128, b = f * (d[i + 2] + bri - 128) + 128;
    const L = 0.299 * r + 0.587 * g + 0.114 * b;
    d[i] = L + (r - L) * sat + warm; d[i + 1] = L + (g - L) * sat + warm * 0.25; d[i + 2] = L + (b - L) * sat - warm;
  }
  return data;
}
function edAdjusted(){
  const a = ED.adjust; const c = edCopy(ED.base);
  if (a.b || a.c || a.s || a.w){ const x = c.getContext('2d'); x.putImageData(adjustPixels(x.getImageData(0, 0, c.width, c.height), a), 0, 0); }
  return c;
}
function edRender(){
  if (!ED.base || !edCtx) return;
  cancelAnimationFrame(ED.frame);
  ED.frame = requestAnimationFrame(() => {
    const src = ED.comparing ? ED.history[0] : edAdjusted();
    if (edCanvas.width !== src.width || edCanvas.height !== src.height){ edCanvas.width = src.width; edCanvas.height = src.height; }
    edCtx.drawImage(src, 0, 0);
    if (ED.comparing) return;
    const unit = Math.max(edCanvas.width, edCanvas.height) / 900;
    if (ED.stroke) edStroke(edCtx, ED.stroke);
    if (ED.crop){
      const {x, y, w, h} = edRect(ED.crop);
      edCtx.fillStyle = 'rgba(0,0,0,.55)';
      edCtx.fillRect(0, 0, edCanvas.width, y); edCtx.fillRect(0, y + h, edCanvas.width, edCanvas.height - y - h);
      edCtx.fillRect(0, y, x, h); edCtx.fillRect(x + w, y, edCanvas.width - x - w, h);
      edCtx.strokeStyle = '#ffad35'; edCtx.lineWidth = 2 * unit; edCtx.setLineDash([8 * unit, 6 * unit]); edCtx.strokeRect(x, y, w, h); edCtx.setLineDash([]);
    }
  });
}
function edRect(c){
  let x = Math.min(c.x1, c.x2), y = Math.min(c.y1, c.y2), w = Math.abs(c.x2 - c.x1), h = Math.abs(c.y2 - c.y1);
  const ratio = Number($('#edAspect').value || 0);       // height / width
  if (ratio){ h = w * ratio; if (c.y2 < c.y1) y = c.y1 - h; }
  x = Math.max(0, x); y = Math.max(0, y); w = Math.min(w, edCanvas.width - x); h = Math.min(h, edCanvas.height - y);
  return {x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h)};
}
function edStroke(ctx, s){
  ctx.save(); ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = s.size;
  if (s.kind === 'draw'){
    ctx.beginPath(); s.points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
  } else if (s.kind === 'arrow' && s.points.length > 1){
    const [[x1, y1], [x2, y2]] = [s.points[0], s.points[s.points.length - 1]];
    const ang = Math.atan2(y2 - y1, x2 - x1), head = s.size * 4;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2 - Math.cos(ang) * head * 0.6, y2 - Math.sin(ang) * head * 0.6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
    ctx.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
function edBake(draw){
  const c = edAdjusted(); draw(c.getContext('2d'), c); edPush(c);
}
function edPoint(ev){
  const r = edCanvas.getBoundingClientRect();
  return [(ev.clientX - r.left) * edCanvas.width / r.width, (ev.clientY - r.top) * edCanvas.height / r.height];
}
function edSetMode(mode){
  ED.mode = ED.mode === mode ? '' : mode; ED.crop = null; ED.stroke = null;
  document.querySelectorAll('[data-ed-mode]').forEach(b => b.classList.toggle('active', b.dataset.edMode === ED.mode));
  $('#edModeActions').hidden = ED.mode !== 'crop';
  edCanvas.style.cursor = ED.mode ? 'crosshair' : 'default';
  edRender();
}
function edResetAdjust(render = true){
  ED.adjust = {b:0, c:0, s:0, w:0};
  [['#edBright', 'b'], ['#edContrast', 'c'], ['#edSat', 's'], ['#edWarm', 'w']].forEach(([sel]) => { const el = $(sel); if (el) el.value = 0; });
  if (render) edRender();
}
function edAutoLevels(){
  edBake((ctx, c) => {
    const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data, hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 16) hist[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
    const total = hist.reduce((a, b) => a + b, 0); let lo = 0, hi = 255, acc = 0;
    for (; lo < 255 && (acc += hist[lo]) < total * 0.01; lo++);
    acc = 0; for (; hi > 0 && (acc += hist[hi]) < total * 0.01; hi--);
    const k = 255 / Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4){ d[i] = (d[i] - lo) * k; d[i + 1] = (d[i + 1] - lo) * k; d[i + 2] = (d[i + 2] - lo) * k; }
    ctx.putImageData(img, 0, 0);
  });
}
function edTransform(op){
  const src = edAdjusted(), c = document.createElement('canvas'), turn = op === 'rotl' || op === 'rotr';
  c.width = turn ? src.height : src.width; c.height = turn ? src.width : src.height;
  const x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2);
  if (op === 'rotl') x.rotate(-Math.PI / 2); if (op === 'rotr') x.rotate(Math.PI / 2);
  if (op === 'fliph') x.scale(-1, 1); if (op === 'flipv') x.scale(1, -1);
  x.drawImage(src, -src.width / 2, -src.height / 2); edPush(c);
}
function edBlob(type = 'image/jpeg'){ return new Promise(res => edAdjusted().toBlob(res, type, 0.92)); }
async function edAiEdit(prompt){
  prompt = String(prompt || '').trim();
  if (!ED.base){ showToast('Open a photo first', 'error'); return; }
  if (!prompt){ $('#edPrompt').focus(); showToast('Describe the change you want', 'error'); return; }
  $('#edBusy').hidden = false; crBusy($('#edAi'), true, 'Editing…');
  try{
    const url = await crUpload(await edBlob(), 'edit_source.jpg');
    const out = await crApi({action:'edit', image:url, prompt});
    await edLoad(out.url, false);
    showToast('AI edit applied — Undo to go back', 'info');
  }catch(err){ showToast(String(err.message || err), 'error'); }
  finally{ $('#edBusy').hidden = true; crBusy($('#edAi'), false); }
}
function edRecent(){
  const sel = $('#edRecent'); if (!sel || typeof WS === 'undefined' || !WS) return;
  const imgs = (WS.uploads || []).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f.name)).slice(0, 25);
  sel.innerHTML = '<option value="">Recent images…</option>' + imgs.map(f => `<option value="${esc(f.url)}">${esc(f.name.replace(/^\d+_/, ''))}</option>`).join('');
}
function openInEditor(url){ showView('creative'); crTab('editor'); edLoad(url).catch(err => showToast(String(err.message || err), 'error')); }

if (edCanvas){
  $('#edFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) edLoad(f).catch(err => showToast(String(err.message || err), 'error')); e.target.value = ''; });
  $('#edRecent').addEventListener('focus', edRecent);
  $('#edRecent').addEventListener('change', e => { if (e.target.value) edLoad(e.target.value); e.target.value = ''; });
  const wrap = $('#edWrap');
  wrap.addEventListener('dragover', e => { e.preventDefault(); wrap.classList.add('drop'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
  wrap.addEventListener('drop', e => { e.preventDefault(); wrap.classList.remove('drop'); const f = [...e.dataTransfer.files].find(x => x.type.startsWith('image/')); if (f) edLoad(f); });
  $('#edUndo').onclick = () => { if (ED.idx > 0){ ED.idx--; ED.base = ED.history[ED.idx]; edResetAdjust(false); edRender(); edButtons(); } };
  $('#edRedo').onclick = () => { if (ED.idx < ED.history.length - 1){ ED.idx++; ED.base = ED.history[ED.idx]; edResetAdjust(false); edRender(); edButtons(); } };
  const cmp = $('#edCompare');
  const cmpOn = e => { e.preventDefault(); ED.comparing = true; edRender(); }, cmpOff = () => { if (ED.comparing){ ED.comparing = false; edRender(); } };
  cmp.addEventListener('pointerdown', cmpOn); ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => cmp.addEventListener(t, cmpOff));
  $('#edSave').onclick = async () => {
    try{ const url = await crUpload(await edBlob(), 'edited_photo.jpg'); showToast('Saved to your files', 'info'); if (typeof loadWorkspace === 'function') loadWorkspace(); return url; }
    catch(err){ showToast(String(err.message || err), 'error'); }
  };
  $('#edDownload').onclick = async () => { const a = document.createElement('a'); a.href = URL.createObjectURL(await edBlob()); a.download = `zuzu_edit_${Date.now()}.jpg`; a.click(); };
  [['#edBright', 'b'], ['#edContrast', 'c'], ['#edSat', 's'], ['#edWarm', 'w']].forEach(([sel, key]) => $(sel).addEventListener('input', e => { ED.adjust[key] = Number(e.target.value); edRender(); }));
  $('#edApplyAdjust').onclick = () => { if (ED.base) edBake(() => {}); };
  $('#edResetAdjust').onclick = () => edResetAdjust();
  document.querySelectorAll('[data-ed-filter]').forEach(b => b.onclick = () => {
    if (!ED.base) return;
    const f = b.dataset.edFilter;
    if (f === 'auto') return edAutoLevels();
    const presets = {bw:{b:0, c:10, s:-100, w:0}, warm:{b:4, c:5, s:10, w:35}, cool:{b:0, c:5, s:0, w:-35}, vivid:{b:3, c:15, s:40, w:0}};
    ED.adjust = {...presets[f]};
    [['#edBright', 'b'], ['#edContrast', 'c'], ['#edSat', 's'], ['#edWarm', 'w']].forEach(([sel, key]) => $(sel).value = ED.adjust[key]);
    edRender();
  });
  document.querySelectorAll('[data-ed-op]').forEach(b => b.onclick = () => ED.base && edTransform(b.dataset.edOp));
  document.querySelectorAll('[data-ed-mode]').forEach(b => b.onclick = () => ED.base && edSetMode(b.dataset.edMode));
  $('#edModeDone').onclick = () => {
    if (ED.mode === 'crop' && ED.crop){
      const {x, y, w, h} = edRect(ED.crop);
      if (w > 8 && h > 8){ const src = edAdjusted(), c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h); ED.crop = null; edPush(c); }
    }
    edSetMode('');
  };
  $('#edModeCancel').onclick = () => edSetMode('');
  edCanvas.addEventListener('pointerdown', ev => {
    if (!ED.mode || !ED.base) return;
    edCanvas.setPointerCapture(ev.pointerId);
    const [x, y] = edPoint(ev), size = Number($('#edSize').value) * Math.max(1, edCanvas.width / 1200), color = $('#edColor').value;
    if (ED.mode === 'crop') ED.crop = {x1:x, y1:y, x2:x, y2:y};
    else if (ED.mode === 'draw' || ED.mode === 'arrow') ED.stroke = {kind:ED.mode, points:[[x, y]], size, color};
    else if (ED.mode === 'text'){
      const text = prompt('Text to add'); if (!text) return;
      edBake(ctx => { ctx.font = `800 ${Math.round(Math.max(size * 6, edCanvas.width / 22))}px Inter, Segoe UI, sans-serif`; ctx.fillStyle = color; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = Math.max(2, size / 2); ctx.textBaseline = 'middle'; ctx.strokeText(text, x, y); ctx.fillText(text, x, y); });
    }
    ED.drag = true; edRender();
  });
  edCanvas.addEventListener('pointermove', ev => {
    if (!ED.drag) return;
    const [x, y] = edPoint(ev);
    if (ED.crop){ ED.crop.x2 = x; ED.crop.y2 = y; }
    if (ED.stroke){ if (ED.stroke.kind === 'draw') ED.stroke.points.push([x, y]); else ED.stroke.points[1] = [x, y]; }
    edRender();
  });
  const edUp = () => {
    if (!ED.drag) return; ED.drag = false;
    if (ED.stroke && ED.stroke.points.length > 1){ const s = ED.stroke; ED.stroke = null; edBake(ctx => edStroke(ctx, s)); }
    ED.stroke = null; edRender();
  };
  edCanvas.addEventListener('pointerup', edUp); edCanvas.addEventListener('pointercancel', edUp);
  $('#edPresets').addEventListener('click', e => { const b = e.target.closest('[data-ed-preset]'); if (!b) return; $('#edPrompt').value = b.dataset.edPreset; $('#edPrompt').focus(); if (!b.dataset.edPreset.endsWith(' ')) edAiEdit(b.dataset.edPreset); });
  $('#edAi').onclick = () => edAiEdit($('#edPrompt').value);
  document.addEventListener('keydown', e => {
    if ($('[data-view-panel="creative"]').hidden || CR.tab !== 'editor' || e.target.closest('input,textarea,select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'){ e.preventDefault(); (e.shiftKey ? $('#edRedo') : $('#edUndo')).click(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y'){ e.preventDefault(); $('#edRedo').click(); }
  });
  edButtons();
}

// ── room redesign ────────────────────────────────────────────────────
function renderRoomStyles(){
  const box = $('#roomStyles'); if (!box) return;
  box.innerHTML = CR.styles.map(s => `<button type="button" data-room-style="${esc(s)}" class="${s === CR.style ? 'active' : ''}">${esc(s.replace(/\b\w/g, c => c.toUpperCase()))}</button>`).join('')
    + `<button type="button" data-room-style="" class="${CR.style && !CR.styles.includes(CR.style) ? 'active' : ''}">Custom…</button>`;
}
$('#roomStyles')?.addEventListener('click', e => {
  const b = e.target.closest('[data-room-style]'); if (!b) return;
  CR.style = b.dataset.roomStyle || (prompt('Describe the style', 'warm modern with oak and olive green') || '');
  renderRoomStyles();
});
$('#roomFile')?.addEventListener('change', e => crPick(e.target, $('#roomPreview')).catch(err => showToast(String(err.message || err), 'error')));
$('#roomGo')?.addEventListener('click', async e => {
  const image = $('#roomFile').dataset.url; if (!image) return showToast('Add a room photo first', 'error');
  if (!CR.style) return showToast('Pick a style', 'error');
  crBusy(e.target, true, 'Designing…');
  try{
    const out = await crApi({action:'room', image, style:CR.style, materials:$('#roomMaterials').value, strength:Number($('#roomStrength').value)});
    CR.rooms.unshift({...out, title:`${CR.style} · ${$('#roomStrength').selectedOptions[0].text}`});
    $('#roomResults').innerHTML = CR.rooms.map(r => crCard(r, r.title)).join('');
  }catch(err){ showToast(String(err.message || err), 'error'); }
  finally{ crBusy(e.target, false); }
});

// ── resin & wood ─────────────────────────────────────────────────────
const RESIN_TYPES = {river:{fillPercent:35, length:180, width:90, depth:5}, full:{fillPercent:100, length:120, width:60, depth:2},
                     coasters:{fillPercent:100, length:10, width:10, depth:1, pieces:6, shape:'round', woodCost:0, extrasCost:15, hours:1}, art:{fillPercent:100, length:80, width:60, depth:0.4, woodCost:80, extrasCost:60, hours:6},
                     tray:{fillPercent:60, length:45, width:30, depth:1.2, woodCost:60, extrasCost:40, hours:4}};
function resinValues(){ return Object.fromEntries(new FormData($('#resinForm'))); }
function money(n, cur){ return `${Number(n).toLocaleString(undefined, {maximumFractionDigits:0})} ${cur}`; }
function renderQuote(q){
  CR.quote = q;
  $('#resinSummary').textContent = `Sell for ${money(q.price, q.currency)}${q.pieces > 1 ? ` (${money(q.pricePerPiece, q.currency)} each)` : ''} · profit ${money(q.profit, q.currency)}`;
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  $('#resinResult').innerHTML = `<div class="cr-kpis"><div><small>Resin</small><b>${q.resinLitres} L</b><span>${q.resinKg} kg</span></div><div><small>Cost</small><b>${money(q.costs.total, q.currency)}</b><span>materials ${money(q.costs.materials, q.currency)}</span></div><div><small>Price</small><b>${money(q.price, q.currency)}</b><span>profit ${money(q.profit, q.currency)}</span></div></div>
    <table class="cr-table">${row('Mix', `Part A ${q.partA} L + Part B ${q.partB} L (${q.ratio})`)}${row('Pour plan', `${q.layers} layer${q.layers > 1 ? 's' : ''} × ${q.layerDepthCm} cm`)}${row('Pigment', `≈ ${q.pigmentGrams} g`)}${row('Resin', money(q.costs.resin, q.currency))}${row('Pigment cost', money(q.costs.pigment, q.currency))}${row('Wood', money(q.costs.wood, q.currency))}${row('Extras', money(q.costs.extras, q.currency))}${row('Labour', money(q.costs.labour, q.currency))}</table>
    <ul class="cr-notes">${q.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
}
async function resinQuote(values){ const q = await crApi({action:'quote', values}); renderQuote(q); return q; }
$('#resinType')?.addEventListener('change', e => {
  const base = {pieces:1, shape:'rectangle', woodCost:600, extrasCost:350, hours:20, ...RESIN_TYPES[e.target.value]};
  for (const [k, v] of Object.entries(base)){ const f = $('#resinForm').elements[k]; if (f) f.value = v; }
  resinQuote(resinValues()).catch(() => {});
});
$('#resinForm')?.addEventListener('submit', e => { e.preventDefault(); resinQuote(resinValues()).catch(err => showToast(String(err.message || err), 'error')); });
$('#resinConcept')?.addEventListener('click', async e => {
  const v = resinValues(), type = $('#resinType').selectedOptions[0].text;
  crBusy(e.target, true, 'Imagining…');
  try{
    const out = await crApi({action:'design', description:`${type}, ${v.length}×${v.width} cm, ${v.look || 'natural wood with clear epoxy'}`, values:v});
    renderQuote(out.quote); CR.designs.unshift({...out.image, title:type});
    $('#resinImages').innerHTML = CR.designs.map(d => crCard(d, d.title)).join('');
  }catch(err){ showToast(String(err.message || err), 'error'); }
  finally{ crBusy(e.target, false); }
});
$('#resinToListing')?.addEventListener('click', () => {
  const v = resinValues();
  if (CR.quote) $('#listCost').value = CR.quote.costs.total / CR.quote.pieces;
  $('#listNotes').value = `${$('#resinType').selectedOptions[0].text}, ${v.length}×${v.width} cm${v.look ? `, ${v.look}` : ''}`;
  if (CR.designs[0] && !$('#listFile').dataset.url){ $('#listFile').dataset.url = CR.designs[0].url; $('#listPreview').src = CR.designs[0].url; $('#listPreview').hidden = false; }
  crTab('listing');
});

// ── shop listing ─────────────────────────────────────────────────────
$('#listFile')?.addEventListener('change', e => crPick(e.target, $('#listPreview')).catch(err => showToast(String(err.message || err), 'error')));
$('#listPhoto')?.addEventListener('click', async e => {
  const image = $('#listFile').dataset.url; if (!image) return showToast('Add a product photo first', 'error');
  crBusy(e.target, true, 'Cleaning…');
  try{ const out = await crApi({action:'product', image}); $('#listFile').dataset.url = out.url; $('#listPreview').src = out.url; showToast('Studio photo ready', 'info'); }
  catch(err){ showToast(String(err.message || err), 'error'); }
  finally{ crBusy(e.target, false); }
});
$('#listGo')?.addEventListener('click', async e => {
  const image = $('#listFile').dataset.url; if (!image) return showToast('Add a product photo first', 'error');
  crBusy(e.target, true, 'Writing…');
  try{
    const out = await crApi({action:'listing', image, notes:$('#listNotes').value, cost:Number($('#listCost').value) || null, currency:$('#listCurrency').value || 'AED'});
    const block = (label, text, rtl) => `<button type="button" class="cr-copy" data-copy="${esc(text)}"${rtl ? ' dir="rtl"' : ''}><small>${label}</small><span>${esc(text)}</span></button>`;
    const price = out.price || {};
    $('#listResult').innerHTML = `<img class="cr-list-img" src="${esc(image)}" alt="">${block('Title', out.title || '')}${block('English', out.en || '')}${block('العربية', out.ar || '', true)}
      ${block('Hashtags', (out.hashtags || []).map(h => '#' + h).join(' '))}
      <div class="cr-price"><b>${esc(price.low ?? '')}–${esc(price.high ?? '')} ${esc($('#listCurrency').value || 'AED')}</b><span>${esc(price.reason || '')}</span></div>
      ${(out.photoTips || []).length ? `<ul class="cr-notes">${out.photoTips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}`;
  }catch(err){ showToast(String(err.message || err), 'error'); }
  finally{ crBusy(e.target, false); }
});
$('#listResult')?.addEventListener('click', e => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => showToast('Copied', 'info')).catch(() => {});
});

// ── music & 3D jobs ──────────────────────────────────────────────────
async function refreshCreativeJobs(){
  try{
    const r = await fetch('/api/creative/jobs', {headers:apiHeaders(), cache:'no-store'}); if (!r.ok) return;
    const data = await r.json();
    CR.meshy = data.meshy; if (!CR.styles.length){ CR.styles = data.styles || []; renderRoomStyles(); }
    const setup = $('#m3dSetup'); if (setup) setup.hidden = CR.meshy;
    const status = j => j.status === 'working' ? `<em class="cr-working">${j.kind === '3d' && j.progress ? `${j.progress}%` : 'Working…'}</em>` : j.status === 'failed' ? `<em class="cr-failed">${esc(j.error || 'failed')}</em>` : '';
    const music = data.jobs.filter(j => j.kind === 'music'), models = data.jobs.filter(j => j.kind === '3d');
    $('#musicList').innerHTML = music.map(j => `<div class="cr-job"><b>${esc(j.prompt)}</b><small>${j.full ? 'Full song' : '30 s clip'}</small>${status(j)}
      ${j.status === 'done' ? `<audio controls preload="none" src="${esc(j.url)}"></audio><a href="${esc(j.url)}" download>Download</a>${j.lyrics ? `<details><summary>Lyrics / notes</summary><p>${esc(j.lyrics)}</p></details>` : ''}` : ''}</div>`).join('') || '<div class="empty-state">No tracks yet.</div>';
    $('#m3dList').innerHTML = models.map(j => `<div class="cr-job">${j.thumbnail ? `<img src="${esc(j.thumbnail)}" alt="">` : ''}<b>${esc(j.prompt)}</b>${status(j)}
      ${j.status === 'done' ? `<span class="cr-links">${j.glb ? `<a href="${esc(j.glb)}" download>GLB</a>` : ''}${j.stl ? `<a href="${esc(j.stl)}" download>STL (print)</a>` : ''}</span>` : ''}</div>`).join('') || '<div class="empty-state">No models yet.</div>';
    const busy = data.jobs.some(j => j.status === 'working');
    clearTimeout(CR.poll); if (busy) CR.poll = setTimeout(refreshCreativeJobs, 6000);
  }catch(_){}
}
$('#musicMoods')?.addEventListener('click', e => { const b = e.target.closest('[data-music]'); if (b) $('#musicPrompt').value = b.dataset.music; });
$('#musicFile')?.addEventListener('change', e => crPick(e.target, $('#musicPreview')).catch(err => showToast(String(err.message || err), 'error')));
async function composeMusic(prompt, full = false, image = ''){
  const job = await crApi({action:'music', prompt, full, image});
  showToast(full ? 'Composing a full song — Zuzu will tell you when it is ready' : 'Composing a clip (about 30 s)…', 'info');
  refreshCreativeJobs(); return job;
}
$('#musicGo')?.addEventListener('click', async e => {
  const prompt = $('#musicPrompt').value.trim(); if (!prompt) return showToast('Describe the music', 'error');
  crBusy(e.target, true, 'Starting…');
  try{ await composeMusic(prompt, $('#musicFull').checked, $('#musicFile').dataset.url || ''); }
  catch(err){ showToast(String(err.message || err), 'error'); }
  finally{ crBusy(e.target, false); }
});
$('#m3dFile')?.addEventListener('change', e => crPick(e.target, $('#m3dPreview')).catch(err => showToast(String(err.message || err), 'error')));
$('#m3dGo')?.addEventListener('click', async e => {
  const image = $('#m3dFile').dataset.url || '', prompt = $('#m3dPrompt').value.trim();
  if (!image && !prompt) return showToast('Add a photo or describe the object', 'error');
  crBusy(e.target, true, 'Starting…');
  try{ await crApi({action:'3d', image, prompt}); showToast('Building the 3D model — usually 2 to 5 minutes', 'info'); refreshCreativeJobs(); }
  catch(err){ showToast(String(err.message || err), 'error'); }
  finally{ crBusy(e.target, false); }
});

// ── shared wiring ────────────────────────────────────────────────────
document.querySelectorAll('[data-cr-tab]').forEach(b => b.addEventListener('click', () => crTab(b.dataset.crTab)));
document.addEventListener('click', e => { const b = e.target.closest('[data-ed-open]'); if (b){ e.preventDefault(); openInEditor(b.dataset.edOpen); } });
try{ const saved = localStorage.getItem('zuzu-creative-tab'); if (saved && document.querySelector(`[data-cr-tab="${saved}"]`)) crTab(saved); }catch(_){}
refreshCreativeJobs();
if ($('#resinForm')) resinQuote(resinValues()).catch(() => {});

if (typeof LOCAL_TOOLS !== 'undefined'){
  LOCAL_TOOLS.make_music = async a => { showView('creative'); crTab('music'); const job = await composeMusic(a.prompt, /^y/i.test(String(a.full || '')));
    return {started:true, id:job.id, note:'It will play in the Music tab and Zuzu announces when it is ready.'}; };
  LOCAL_TOOLS.resin_quote = async a => {
    const q = await crApi({action:'quote', values:{length:a.length, width:a.width, depth:a.depth, fillPercent:a.fill_percent || 100, pieces:a.pieces || 1}});
    showView('creative'); crTab('resin'); renderQuote(q);
    return {resin_litres:q.resinLitres, layers:q.layers, cost:q.costs.total, price:q.price, currency:q.currency, note:'Uses the default prices in the calculator; the user can adjust them on screen.'};
  };
  LOCAL_TOOLS.open_creative_studio = async a => { showView('creative'); const tab = ['editor', 'room', 'resin', 'listing', 'music', 'model3d'].includes(a.tab) ? a.tab : 'editor'; crTab(tab); return {opened:tab}; };
}

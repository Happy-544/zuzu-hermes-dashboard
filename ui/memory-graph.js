/* Zuzu memory graph: an Obsidian-style knowledge graph for the Memory page.

   buildMemoryGraph() turns the workspace (memories, projects, skills, Hermes USER.md /
   MEMORY.md) into notes and links:
     [[Note name]]   explicit link (unresolved names become ghost notes, like Obsidian)
     #tag            tag note shared by every note that uses it
     mention         a note's text names another note
     related         notes sharing several meaningful words ("smart links")
   ForceGraph draws it on a canvas with a force simulation, zoom/pan, drag, hover focus
   and a local-graph mode. No dependencies; works offline. */

const MG_COLORS = {you: '#ffcf70', memory: '#b18cff', project: '#5ee7ff', skill: '#55e6a5',
                   hermes: '#ffad35', tag: '#8fbf7f', ghost: '#6b6259'};
const MG_GROUP_NAMES = {you: 'You', memory: 'Memories', project: 'Projects', skill: 'Skills',
                        hermes: 'Hermes memory', tag: 'Tags', ghost: 'Unresolved'};
const MG_STOP = new Set(('the and for with that this from have has are was were you your our about into when what which will would should could them they their there then than also just only more most very some such been being over under after before other these those where while each make made like want need using used user users zuzu hermes memory note notes always never every because does done into onto upon please thing things time today'
  + ' في من على الى إلى عن مع هذا هذه ذلك التي الذي كان يكون').split(' '));

function mgNorm(s){ return String(s || '').trim().toLowerCase(); }

function parseNote(text){
  const body = String(text || '');
  const links = [], tags = [];
  for (const m of body.matchAll(/\[\[([^\]|#\n]{1,100})(?:[|#][^\]\n]*)?\]\]/g)){
    const name = m[1].trim(); if (name && !links.includes(name)) links.push(name);
  }
  for (const m of body.matchAll(/(^|[\s(,;])#([\p{L}\p{N}_][\p{L}\p{N}_/-]{0,39})/gu)){
    const tag = m[2].toLowerCase(); if (!/^\d+$/.test(tag) && !tags.includes(tag)) tags.push(tag);
  }
  return {links, tags};
}

function mgWords(text){
  const words = new Set();
  for (const w of String(text || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []){
    if (!MG_STOP.has(w) && !/^\d+$/.test(w)) words.add(w);
  }
  return words;
}

/* Split a Hermes markdown memory file into notes: by headings, else by § entries, else paragraphs. */
function hermesSections(file){
  const content = String(file.content || ''), out = [];
  const lines = content.split(/\r?\n/);
  if (lines.some(l => /^#{1,3}\s+\S/.test(l))){
    let cur = null;
    for (const line of lines){
      const h = line.match(/^#{1,3}\s+(.+)/);
      if (h){ cur = {label: h[1].trim().slice(0, 80), text: ''}; out.push(cur); }
      else if (cur) cur.text += line + '\n';
    }
  } else {
    const parts = content.includes('§') ? content.split('§') : content.split(/\n\s*\n/);
    for (const part of parts){
      const text = part.trim(); if (!text) continue;
      const words = text.replace(/[#*_`>-]/g, ' ').split(/\s+/).filter(Boolean);
      out.push({label: words.slice(0, 6).join(' ').slice(0, 60) + (words.length > 6 ? '…' : ''), text});
    }
  }
  return out.filter(s => s.label).slice(0, 40).map(s => ({...s, text: s.text.trim()}));
}

function buildMemoryGraph(ws, opts = {}){
  const o = {tags: true, smart: true, mentions: true, orphans: true, ...opts};
  const nodes = [], links = [], byId = new Map(), byName = new Map(), seen = new Set();
  const add = n => {
    n.color = MG_COLORS[n.group]; n.text = n.text || ''; n.tags = n.tags || []; n.history = n.history || [];
    nodes.push(n); byId.set(n.id, n);
    const key = mgNorm(n.label); if (key && !byName.has(key)) byName.set(key, n);
    return n;
  };
  const link = (a, b, kind) => {
    if (!a || !b || a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return; seen.add(key);
    links.push({source: a, target: b, kind});
  };
  const settings = (ws && ws.settings) || {};
  add({id: 'you', group: 'you', label: settings.profile && settings.profile !== 'default' ? settings.profile : 'You',
       text: `Profile: ${settings.profile || 'default'}\nWorkdir: ${settings.workdir || '~'}\nVoice: ${settings.voice || 'default'}`});
  for (const m of (ws && ws.memory) || []){
    const parsed = parseNote(m.value);
    add({id: `m:${m.id}`, group: 'memory', label: m.label || 'Memory', text: m.value || '', ref: m.id,
         tags: [...new Set([...(m.tags || []), ...parsed.tags])], wiki: parsed.links, created: m.created, updated: m.updated,
         auto: !!m.auto, source: m.source || '', history: m.history || []});
  }
  for (const p of (ws && ws.projects) || []){
    add({id: `p:${p.id}`, group: 'project', label: p.name || 'Project', text: `Folder: ${p.folder || '—'}\nChats: ${(p.sessions || []).map(s => s.name).join(', ') || 'none'}`, ref: p.id});
    link('you', `p:${p.id}`, 'home');
  }
  for (const s of (ws && ws.skills) || []){
    const parsed = parseNote(s.instructions);
    add({id: `s:${s.id}`, group: 'skill', label: s.name || 'Skill', text: s.instructions || '', ref: s.id, tags: parsed.tags, wiki: parsed.links});
  }
  for (const file of (ws && ws.hermesMemory) || []){
    const fileId = `h:${file.source}`;
    add({id: fileId, group: 'hermes', label: file.source, text: `Hermes curated memory file (${file.source}). Read-only here; Hermes edits it itself.`, file: true});
    if (/user/i.test(file.source)) link('you', fileId, 'home');
    hermesSections(file).forEach((sec, i) => {
      const parsed = parseNote(sec.text);
      add({id: `${fileId}:${i}`, group: 'hermes', label: sec.label, text: sec.text, tags: parsed.tags, wiki: parsed.links, source: file.source});
      link(fileId, `${fileId}:${i}`, 'home');
    });
  }
  const notes = nodes.slice();
  // explicit [[links]]; unknown names become ghost notes
  for (const n of notes){
    for (const name of n.wiki || []){
      let target = byName.get(mgNorm(name));
      if (!target){ target = add({id: `g:${mgNorm(name)}`, group: 'ghost', label: name, text: 'Linked but not written yet. Create it to fill it in.'}); }
      link(n.id, target.id, 'link');
    }
  }
  // tags
  if (o.tags){
    for (const n of notes){
      for (const tag of n.tags){
        const id = `t:${tag}`;
        if (!byId.has(id)) add({id, group: 'tag', label: `#${tag}`, text: ''});
        link(n.id, id, 'tag');
      }
    }
  }
  // unlinked mentions: a note's text names another note (labels of 4+ chars)
  if (o.mentions){
    const named = notes.filter(n => n.group !== 'you' && !n.file && mgNorm(n.label).length >= 4 && mgNorm(n.label).length <= 60);
    for (const n of notes){
      const text = ' ' + mgNorm(n.text) + ' ';
      if (text.length < 6) continue;
      for (const t of named){
        if (t === n) continue;
        const i = text.indexOf(mgNorm(t.label));
        if (i > 0 && !/[\p{L}\p{N}]/u.test(text[i - 1]) && !/[\p{L}\p{N}]/u.test(text[i + mgNorm(t.label).length] || ' ')) link(n.id, t.id, 'mention');
      }
    }
  }
  // smart links: notes that share several meaningful words
  if (o.smart){
    const bags = notes.filter(n => !n.file && n.group !== 'you').map(n => ({n, w: mgWords(`${n.label} ${n.text}`)})).filter(b => b.w.size);
    const count = new Map();
    for (let i = 0; i < bags.length; i++){
      const best = [];
      for (let j = 0; j < bags.length; j++){
        if (i === j) continue;
        let shared = 0; for (const w of bags[i].w) if (bags[j].w.has(w)) shared++;
        const score = shared / Math.min(bags[i].w.size, bags[j].w.size);
        if (shared >= 2 && score >= 0.2) best.push({j, score});
      }
      best.sort((a, b) => b.score - a.score).slice(0, 3).forEach(({j}) => {
        const a = bags[i].n.id, b = bags[j].n.id;
        if ((count.get(a) || 0) < 4 && (count.get(b) || 0) < 4){ link(a, b, 'related'); count.set(a, (count.get(a) || 0) + 1); count.set(b, (count.get(b) || 0) + 1); }
      });
    }
  }
  // degree + neighbours
  for (const n of nodes){ n.degree = 0; n.neighbors = new Set(); }
  for (const l of links){
    const a = byId.get(l.source), b = byId.get(l.target);
    a.degree++; b.degree++; a.neighbors.add(b.id); b.neighbors.add(a.id);
  }
  let out = nodes;
  if (!o.orphans) out = nodes.filter(n => n.degree > 0 || n.group === 'you');
  return {nodes: out, links: links.filter(l => out.includes(byId.get(l.source)) && out.includes(byId.get(l.target))), byId};
}

/* Nodes within `depth` hops of `id` (the Obsidian "local graph"). */
function localIds(graph, id, depth = 1){
  const keep = new Set([id]); let frontier = [id];
  for (let d = 0; d < depth; d++){
    const next = [];
    for (const cur of frontier){
      for (const nb of graph.byId.get(cur)?.neighbors || []) if (!keep.has(nb)){ keep.add(nb); next.push(nb); }
    }
    frontier = next;
  }
  return keep;
}

/* Minimal safe markdown for the note pane. Escapes first; [[links]] and #tags become buttons. */
function renderNoteMarkdown(text, escFn){
  const esc = escFn || (s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])));
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[\[([^\]|#\n]{1,100})(?:[|#]([^\]\n]*))?\]\]/g, (_, name, alias) => `<button type="button" class="mg-wikilink" data-mg-open-name="${name.trim()}">${(alias || name).trim()}</button>`)
    .replace(/(^|[\s(,;])#([\p{L}\p{N}_][\p{L}\p{N}_/-]{0,39})/gu, (m, pre, tag) => /^\d+$/.test(tag) ? m : `${pre}<button type="button" class="mg-tag" data-mg-tag="${tag.toLowerCase()}">#${tag}</button>`);
  const html = []; let list = null;
  for (const raw of String(text || '').split(/\r?\n/)){
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (bullet){ if (!list){ list = []; } list.push(`<li>${inline(bullet[1])}</li>`); continue; }
    if (list){ html.push(`<ul>${list.join('')}</ul>`); list = null; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) html.push(`<h${Math.min(6, h[1].length + 2)}>${inline(h[2])}</h${Math.min(6, h[1].length + 2)}>`);
    else if (line.trim()) html.push(`<p>${inline(line)}</p>`);
  }
  if (list) html.push(`<ul>${list.join('')}</ul>`);
  return html.join('') || '<p class="mg-empty">Empty note.</p>';
}

/* Canvas force-directed graph with Obsidian-like interaction. */
class ForceGraph {
  constructor(canvas, handlers = {}){
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.h = handlers;
    this.nodes = []; this.links = []; this.pos = new Map();
    this.k = 1; this.tx = 0; this.ty = 0; this.alpha = 0; this.frame = 0;
    this.hover = null; this.selected = null; this.highlight = null; this.labels = true;
    this.pointers = new Map(); this.drag = null; this.cam = null; this.autoFit = true; this.touched = false;
    this.w = 300; this.hgt = 300; this.dpr = 1;
    this._bind();
    if (typeof ResizeObserver !== 'undefined'){ this.ro = new ResizeObserver(() => { this.resize(); if (!this.touched) this.fit(null, false); else this.draw(); }); this.ro.observe(canvas); }
    this.resize();
  }
  setData(nodes, links, {reheat = 0.9} = {}){
    const ids = new Map(nodes.map(n => [n.id, n]));
    this.nodes = nodes; this.links = links.map(l => ({...l, a: ids.get(l.source), b: ids.get(l.target)})).filter(l => l.a && l.b);
    const fresh = [];
    nodes.forEach((n, i) => {
      const p = this.pos.get(n.id);
      if (p){ Object.assign(n, {x: p.x, y: p.y, vx: 0, vy: 0}); }
      else fresh.push(n);
      n.r = n.group === 'you' ? 11 : n.group === 'tag' ? 3.5 : Math.min(14, 4.5 + Math.sqrt(n.degree || 0) * 2);
    });
    fresh.forEach((n, i) => {
      const anchor = [...(n.neighbors || [])].map(id => this.pos.get(id)).find(Boolean);
      const a = i * 2.39996, r = 30 + 12 * Math.sqrt(i + 1);
      n.x = (anchor ? anchor.x : 0) + Math.cos(a) * (anchor ? 40 : r); n.y = (anchor ? anchor.y : 0) + Math.sin(a) * (anchor ? 40 : r);
      n.vx = 0; n.vy = 0;
    });
    this.kick(fresh.length ? Math.max(reheat, 0.9) : reheat);
  }
  resize(){
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);
    this.w = Math.max(280, rect.width); this.hgt = Math.max(260, rect.height);
    const W = Math.round(this.w * this.dpr), H = Math.round(this.hgt * this.dpr);
    if (this.canvas.width !== W || this.canvas.height !== H){ this.canvas.width = W; this.canvas.height = H; }
  }
  kick(alpha = 0.3){ this.alpha = Math.max(this.alpha, alpha); this._loop(); }
  _visible(){ return !!this.canvas.offsetParent; }
  _loop(){
    if (this.frame) return;
    const step = () => {
      this.frame = 0;
      if (!this._visible()) return;            // page hidden: sleep until kicked again
      if (this.alpha > 0.004) this._tick();
      if (this.autoFit && this.alpha < 0.3){ this.autoFit = false; this.fit(); }
      this._camStep();
      this.draw();
      if (this.alpha > 0.004 || this.drag || this.cam) this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }
  _tick(){
    const nodes = this.nodes, n = nodes.length, alpha = this.alpha;
    const charge = n > 160 ? 520 : 760;
    for (let i = 0; i < n; i++){
      const a = nodes[i];
      for (let j = i + 1; j < n; j++){
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 < 1){ dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        if (d2 > 250000) continue;
        const f = charge * alpha / d2;
        a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
      }
    }
    for (const l of this.links){
      const {a, b} = l, len = l.kind === 'tag' ? 42 : l.kind === 'related' ? 90 : l.kind === 'home' ? 70 : 62;
      const strength = l.kind === 'related' ? 0.03 : l.kind === 'mention' ? 0.05 : 0.09;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - len) / d * strength * alpha * 4;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const node of nodes){
      node.vx -= node.x * 0.018 * alpha; node.vy -= node.y * 0.018 * alpha;
      if (node.fx != null){ node.x = node.fx; node.y = node.fy; node.vx = node.vy = 0; continue; }
      node.vx *= 0.58; node.vy *= 0.58;
      node.x += Math.max(-40, Math.min(40, node.vx)); node.y += Math.max(-40, Math.min(40, node.vy));
      this.pos.set(node.id, {x: node.x, y: node.y});
    }
    this.alpha *= this.drag ? 1 : 0.982;
    if (this.drag) this.alpha = Math.max(this.alpha, 0.12);
  }
  toScreen(x, y){ return [x * this.k + this.tx + this.w / 2, y * this.k + this.ty + this.hgt / 2]; }
  toWorld(sx, sy){ return [(sx - this.w / 2 - this.tx) / this.k, (sy - this.hgt / 2 - this.ty) / this.k]; }
  nodeAt(sx, sy){
    const [x, y] = this.toWorld(sx, sy); let best = null, bestD = Infinity;
    for (const n of this.nodes){
      const d = Math.hypot(n.x - x, n.y - y), hit = Math.max(n.r + 4, 10 / this.k);
      if (d < hit && d < bestD){ best = n; bestD = d; }
    }
    return best;
  }
  draw(){
    const ctx = this.ctx, k = this.k;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.hgt);
    const focus = this.hover || this.selected;           // selected note keeps its edges lit
    const lit = this.hover ? new Set([this.hover.id, ...this.hover.neighbors]) : null;   // only hover dims the rest
    const match = this.highlight;
    const faded = n => (lit && !lit.has(n.id)) || (match && !match.has(n.id));
    ctx.save(); ctx.translate(this.w / 2 + this.tx, this.hgt / 2 + this.ty); ctx.scale(k, k);
    for (const l of this.links){
      const on = focus && (l.a === focus || l.b === focus);
      const dim = (lit && !on) || (match && !(match.has(l.a.id) && match.has(l.b.id)));
      ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y);
      ctx.setLineDash(l.kind === 'related' ? [3 / k, 4 / k] : l.kind === 'mention' ? [1.5 / k, 3 / k] : []);
      ctx.lineWidth = (on ? 1.6 : 1) / k;
      ctx.strokeStyle = on ? 'rgba(255,190,90,.85)' : dim ? 'rgba(150,130,110,.05)' : l.kind === 'related' ? 'rgba(177,140,255,.22)' : 'rgba(170,150,130,.26)';
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const n of this.nodes){
      const dim = faded(n), sel = n === this.selected, hov = n === this.hover;
      ctx.globalAlpha = dim ? 0.14 : 1;
      if ((sel || hov) && !dim){ ctx.shadowBlur = 18; ctx.shadowColor = n.color; }
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.group === 'ghost' ? 'rgba(0,0,0,0)' : n.color; ctx.fill();
      if (n.group === 'ghost'){ ctx.lineWidth = 1.4 / k; ctx.strokeStyle = n.color; ctx.stroke(); }
      ctx.shadowBlur = 0;
      if (sel){ ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 4 / k + 2, 0, Math.PI * 2); ctx.lineWidth = 1.6 / k; ctx.strokeStyle = '#fff1c9'; ctx.stroke(); }
    }
    ctx.globalAlpha = 1; ctx.restore();
    if (!this.labels) return;
    // labels in screen space so text stays crisp; fade in with zoom like Obsidian
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const zoomFade = Math.max(0, Math.min(1, (k - 0.55) / 0.5));
    for (const n of this.nodes){
      const important = n === this.selected || n === this.hover || (lit && lit.has(n.id)) || (match && match.has(n.id) && match.size < 30);
      let a = important ? 1 : n.group === 'you' ? 1 : n.degree >= 5 ? Math.max(zoomFade, 0.75) : zoomFade * (n.group === 'tag' ? 0.7 : 0.85);
      if (faded(n) && !important) a *= 0.12;
      if (a < 0.05) continue;
      const [sx, sy] = this.toScreen(n.x, n.y);
      if (sx < -80 || sx > this.w + 80 || sy < -20 || sy > this.hgt + 20) continue;
      const label = n.label.length > 34 ? n.label.slice(0, 33) + '…' : n.label;
      ctx.font = `${important ? 700 : 600} ${n.group === 'you' ? 13 : 11}px Inter, Segoe UI, system-ui, sans-serif`;
      ctx.globalAlpha = a; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,7,6,.85)';
      ctx.strokeText(label, sx, sy + n.r * k + 4);
      ctx.fillStyle = important ? '#fff4d6' : n.group === 'ghost' ? '#9a8f84' : '#d9cfc2';
      ctx.fillText(label, sx, sy + n.r * k + 4);
    }
    ctx.globalAlpha = 1;
  }
  zoomBy(f, sx = this.w / 2, sy = this.hgt / 2){
    const [wx, wy] = this.toWorld(sx, sy);
    this.k = Math.max(0.15, Math.min(4, this.k * f));
    this.tx = sx - this.w / 2 - wx * this.k; this.ty = sy - this.hgt / 2 - wy * this.k;
    this.cam = null; this.draw();
  }
  fit(ids, animate = true){
    const pick = ids ? this.nodes.filter(n => ids.has(n.id)) : this.nodes;
    if (!pick.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of pick){ x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const k = Math.max(0.2, Math.min(1.5, Math.min((this.w - 90) / Math.max(60, x1 - x0), (this.hgt - 90) / Math.max(60, y1 - y0))));
    const target = {k, tx: -(x0 + x1) / 2 * k, ty: -(y0 + y1) / 2 * k};
    if (!animate){ Object.assign(this, target); this.draw(); return; }
    this.cam = target; this._loop();
  }
  centerOn(node){
    if (!node) return;
    const k = Math.max(this.k, 1.1);
    this.cam = {k, tx: -node.x * k, ty: -node.y * k}; this._loop();
  }
  _camStep(){
    if (!this.cam) return;
    const c = this.cam, t = 0.16;
    this.k += (c.k - this.k) * t; this.tx += (c.tx - this.tx) * t; this.ty += (c.ty - this.ty) * t;
    if (Math.abs(c.k - this.k) < 0.002 && Math.abs(c.tx - this.tx) < 0.5 && Math.abs(c.ty - this.ty) < 0.5){ Object.assign(this, c); this.cam = null; }
  }
  select(node, {center = false} = {}){
    this.selected = node || null;
    if (center && node) this.centerOn(node);
    this.draw();
  }
  _local(ev){ const r = this.canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }
  _bind(){
    const c = this.canvas;
    c.addEventListener('pointerdown', ev => {
      c.setPointerCapture?.(ev.pointerId); this.autoFit = false; this.touched = true;
      const [sx, sy] = this._local(ev); this.pointers.set(ev.pointerId, {sx, sy});
      this.cam = null;
      if (this.pointers.size === 2){ this.drag = {pinch: this._pinch()}; return; }
      const node = this.nodeAt(sx, sy);
      this.drag = node ? {node, sx, sy, moved: false} : {pan: true, sx, sy, tx: this.tx, ty: this.ty, moved: false};
      if (node){ node.fx = node.x; node.fy = node.y; this.kick(0.12); }
    });
    c.addEventListener('pointermove', ev => {
      const [sx, sy] = this._local(ev);
      if (this.pointers.has(ev.pointerId)) this.pointers.set(ev.pointerId, {sx, sy});
      const d = this.drag;
      if (d && d.pinch && this.pointers.size === 2){
        const p = this._pinch(); this.zoomBy(p.dist / d.pinch.dist, p.cx, p.cy); d.pinch = p; return;
      }
      if (d && d.node){
        if (Math.hypot(sx - d.sx, sy - d.sy) > 3) d.moved = true;
        const [wx, wy] = this.toWorld(sx, sy); d.node.fx = wx; d.node.fy = wy; d.node.x = wx; d.node.y = wy;
        this.kick(0.12); return;
      }
      if (d && d.pan){
        if (Math.hypot(sx - d.sx, sy - d.sy) > 3) d.moved = true;
        this.tx = d.tx + sx - d.sx; this.ty = d.ty + sy - d.sy; this.draw(); return;
      }
      const hit = this.nodeAt(sx, sy);
      if (hit !== this.hover){ this.hover = hit; c.style.cursor = hit ? 'pointer' : 'grab'; this.draw(); this.h.onHover?.(hit, sx, sy); }
      else if (hit) this.h.onHover?.(hit, sx, sy);
    });
    const up = ev => {
      const d = this.drag; this.pointers.delete(ev.pointerId);
      if (!d) return;
      if (d.pinch){ if (this.pointers.size === 0) this.drag = null; return; }
      this.drag = null;
      if (d.node){ d.node.fx = d.node.fy = null; this.pos.set(d.node.id, {x: d.node.x, y: d.node.y}); if (!d.moved) this.h.onSelect?.(d.node); this.kick(0.05); }
      else if (d.pan && !d.moved) this.h.onSelect?.(null);
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => { if (this.hover && !this.drag){ this.hover = null; this.draw(); this.h.onHover?.(null); } });
    c.addEventListener('dblclick', ev => { const [sx, sy] = this._local(ev); const n = this.nodeAt(sx, sy); if (n) this.h.onOpen?.(n); });
    c.addEventListener('wheel', ev => { ev.preventDefault(); this.autoFit = false; this.touched = true; const [sx, sy] = this._local(ev); this.zoomBy(Math.exp(-ev.deltaY * 0.0015), sx, sy); }, {passive: false});
  }
  _pinch(){
    const [a, b] = [...this.pointers.values()];
    return {dist: Math.max(10, Math.hypot(a.sx - b.sx, a.sy - b.sy)), cx: (a.sx + b.sx) / 2, cy: (a.sy + b.sy) / 2};
  }
}

if (typeof module !== 'undefined') module.exports = {buildMemoryGraph, parseNote, hermesSections, localIds, renderNoteMarkdown, MG_COLORS, MG_GROUP_NAMES};

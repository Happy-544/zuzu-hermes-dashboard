/* Zuzu Calm mode: soft-voiced supportive companion with generated ambient music, animated
   relaxing scenery, guided breathing, grounding, body scan, CBT reframing, journaling, a private
   mood log and crisis help lines. Loaded after app.js (uses $, esc, apiHeaders, showToast,
   startGeminiLive, stopConvo, transmit, speakWithLive, LOCAL_TOOLS). */

const CALM = {active:false, scene:'aurora', sound:'pads', volume:0.45, voice:'Achernar', remember:false,
              state:null, history:[], mood:0, words:new Set(), tipIdx:0, timers:[], breath:null, lastYou:'', crisisShown:false};
const CALM_CRISIS = /\b(?:kill(?:ing)? myself|end (?:it|my life)|suicid\w*|self[- ]?harm|hurt(?:ing)? myself|cut(?:ting)? myself|don'?t want to (?:live|be alive|wake up)|no reason to live|better off dead|want to die|overdose)\b|انتحر|انتحار|اموت نفسي|أموت نفسي|اقتل نفسي|أقتل نفسي|مش عايز اعيش|مش عايزة اعيش|نفسي اموت|نفسي أموت|أذي نفسي|اجرح نفسي/i;
const CALM_TIPS = [
  'Longer exhales than inhales tell your nervous system it is safe.',
  'Name the feeling in one word — naming it softens it.',
  'Unclench your jaw, drop your shoulders, soften your hands.',
  'A thought is not a fact. Ask: what would I tell a friend?',
  'Two minutes of daylight or a short walk can shift a heavy mood.',
  'Put the phone away 30 minutes before sleep; dim the lights.',
  'Write tomorrow\'s one small step, then let today be finished.',
  'Cold water on the wrists or face calms a racing heart.',
  'You don\'t have to fix everything tonight. Rest is productive too.',
  'Notice three sounds around you right now. You are here.',
  'Drink a glass of water slowly — it is a small act of care.',
  'Worry has a slot: give it 10 minutes tomorrow, not all night.',
];
const CALM_WORDS = ['calm', 'tired', 'anxious', 'stressed', 'sad', 'angry', 'lonely', 'overwhelmed', 'hopeful', 'grateful'];
const CALM_BREATH = {
  box:      {name:'Box breathing', steps:[['Breathe in', 4], ['Hold', 4], ['Breathe out', 4], ['Hold', 4]]},
  '478':    {name:'4-7-8 breathing', steps:[['Breathe in', 4], ['Hold', 7], ['Breathe out slowly', 8]]},
  coherent: {name:'Coherent breathing', steps:[['Breathe in', 5.5], ['Breathe out', 5.5]]},
  sigh:     {name:'Physiological sigh', steps:[['Breathe in', 2], ['A little more', 1], ['Long breath out', 6]]},
};
const CALM_GROUND = [['5', 'things you can see', 'Look around slowly. Name them quietly.'], ['4', 'things you can feel', 'Your feet on the floor, the chair, your clothes, the air.'],
                     ['3', 'things you can hear', 'Near sounds, far sounds, your own breath.'], ['2', 'things you can smell', 'Or two smells you like.'], ['1', 'thing you can taste', 'Or one kind thing about yourself.']];
const CALM_BODY = ['Feet and toes — notice them, let them be heavy.', 'Calves and knees — soften them.', 'Thighs and hips — sink into the seat.',
                   'Belly — let it rise and fall on its own.', 'Chest and heart — breathe into any tightness.', 'Hands and arms — let them go loose.',
                   'Shoulders — drop them away from your ears.', 'Jaw, face and forehead — unclench, smooth, soften.', 'Whole body — you are here, you are safe, breathe.'];

// ── ambient sound (generated, no files) ─────────────────────────────
const CA = {ctx:null, master:null, reverb:null, nodes:[], timers:[]};
function caNoise(ctx, kind){
  const len = ctx.sampleRate * 4, buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++){
    const d = buf.getChannelData(ch); let last = 0;
    for (let i = 0; i < len; i++){ const w = Math.random() * 2 - 1; if (kind === 'brown'){ last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w * 0.5; }
  }
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; return src;
}
function caReverb(ctx){
  const len = ctx.sampleRate * 3.2, buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++){ const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
  const conv = ctx.createConvolver(); conv.buffer = buf; return conv;
}
const midi = n => 440 * Math.pow(2, (n - 69) / 12);
function caPadChord(notes, dur){
  const ctx = CA.ctx, now = ctx.currentTime;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100; lp.Q.value = 0.3;
  const env = ctx.createGain(); env.gain.setValueAtTime(0, now); env.gain.linearRampToValueAtTime(0.12, now + dur * 0.35); env.gain.linearRampToValueAtTime(0, now + dur + 4);
  lp.connect(env); env.connect(CA.master); env.connect(CA.reverb);
  for (const n of notes){
    for (const [type, cents] of [['sine', -5], ['triangle', 5]]){
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = midi(n); o.detune.value = cents;
      const g = ctx.createGain(); g.gain.value = type === 'sine' ? 0.5 : 0.18; o.connect(g); g.connect(lp);
      o.start(now); o.stop(now + dur + 5);
    }
  }
}
function caSparkle(){
  const ctx = CA.ctx, now = ctx.currentTime, scale = [72, 74, 76, 79, 81, 84];
  const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = midi(scale[Math.floor(Math.random() * scale.length)]);
  const g = ctx.createGain(); g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(0.025, now + 0.4); g.gain.exponentialRampToValueAtTime(0.0001, now + 5);
  o.connect(g); g.connect(CA.reverb); g.connect(CA.master); o.start(now); o.stop(now + 5.2);
}
function calmChime(freq = 528){
  if (!CA.ctx) return;
  const ctx = CA.ctx, now = ctx.currentTime;
  for (const [mult, vol] of [[1, 0.06], [2.01, 0.02], [3.02, 0.008]]){
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq * mult;
    const g = ctx.createGain(); g.gain.setValueAtTime(vol, now); g.gain.exponentialRampToValueAtTime(0.0001, now + 3);
    o.connect(g); g.connect(CA.master); g.connect(CA.reverb); o.start(now); o.stop(now + 3.1);
  }
}
function calmSoundStop(fade = 1.5){
  CA.timers.forEach(clearInterval); CA.timers = [];
  if (!CA.ctx) return;
  const ctx = CA.ctx, master = CA.master;
  master.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
  setTimeout(() => ctx.close().catch(() => {}), fade * 1000 + 200);
  CA.ctx = null; CA.nodes = [];
}
function calmSoundStart(kind){
  calmSoundStop(0.6);
  if (kind === 'silence') return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  CA.ctx = ctx; CA.master = ctx.createGain(); CA.master.gain.value = 0; CA.master.connect(ctx.destination);
  CA.reverb = caReverb(ctx); const wet = ctx.createGain(); wet.gain.value = 0.45; CA.reverb.connect(wet); wet.connect(CA.master);
  ctx.resume().catch(() => {});
  if (kind === 'pads'){
    const chords = [[48, 55, 59, 64], [45, 52, 57, 60, 64], [41, 48, 52, 57], [43, 50, 55, 59, 62]]; let i = 0;
    const next = () => { if (CA.ctx === ctx) caPadChord(chords[i++ % chords.length], 11); };
    next(); CA.timers.push(setInterval(next, 10000)); CA.timers.push(setInterval(() => CA.ctx === ctx && Math.random() < 0.7 && caSparkle(), 4200));
  } else {
    const noise = caNoise(ctx, kind === 'ocean' ? 'brown' : 'white');
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = kind === 'ocean' ? 700 : 5200;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = kind === 'ocean' ? 40 : 700;
    const g = ctx.createGain(); g.gain.value = kind === 'ocean' ? 0.55 : 0.22;
    noise.connect(hp); hp.connect(lp); lp.connect(g); g.connect(CA.master); noise.start();
    if (kind === 'ocean'){       // slow swell of waves
      const lfo = ctx.createOscillator(), depth = ctx.createGain(); lfo.frequency.value = 0.09; depth.gain.value = 0.35;
      lfo.connect(depth); depth.connect(g.gain); lfo.start();
    } else {                     // distant rumble under the rain
      const low = caNoise(ctx, 'brown'), lp2 = ctx.createBiquadFilter(), g2 = ctx.createGain();
      lp2.type = 'lowpass'; lp2.frequency.value = 180; g2.gain.value = 0.25; low.connect(lp2); lp2.connect(g2); g2.connect(CA.master); low.start();
    }
  }
  calmSoundLevel(3);
}
function calmSoundLevel(ramp = 0.8){
  if (!CA.ctx) return;
  const speaking = document.body.classList.contains('speaking');
  CA.master.gain.setTargetAtTime(CALM.volume * (speaking ? 0.4 : 1), CA.ctx.currentTime, ramp / 3);
}

// ── scenery ─────────────────────────────────────────────────────────
const CV = {canvas:$('#calmCanvas'), ctx:null, w:0, h:0, raf:0, t:0, last:0, parts:[]};
const SCENES = {
  aurora:{bg:['#040915', '#0a1f3a', '#08162a'], ribbons:['#37e0b4', '#5f84ff', '#a86bff'], parts:'stars'},
  ocean: {bg:['#03101f', '#08304a', '#0c4a66'], waves:['#0d5575', '#0b4763', '#093a52', '#062a3c'], moon:true, parts:'sparkle'},
  forest:{bg:['#050f09', '#0e2a1a', '#153a24'], parts:'bokeh', colors:['#a4e57f', '#f5d57a', '#6fd3a0']},
  night: {bg:['#020309', '#0a1030', '#1a1440'], nebula:['#4b3aa8', '#1f6aa8'], parts:'stars'},
  rain:  {bg:['#070b12', '#111b27', '#1b2837'], parts:'rain', colors:['#f3b562', '#7fb8ff', '#ff8f70']},
};
function cvResize(){
  const dpr = Math.min(1.5, devicePixelRatio || 1); CV.w = innerWidth; CV.h = innerHeight;
  CV.canvas.width = Math.round(CV.w * dpr); CV.canvas.height = Math.round(CV.h * dpr); CV.ctx = CV.canvas.getContext('2d'); CV.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const s = SCENES[CALM.scene], n = s.parts === 'rain' ? 140 : s.parts === 'bokeh' ? 34 : 160;
  CV.parts = Array.from({length:n}, () => ({x:Math.random() * CV.w, y:Math.random() * CV.h, r:Math.random(), v:Math.random(), c:(s.colors || ['#fff'])[Math.floor(Math.random() * (s.colors || ['#fff']).length)]}));
}
function breathScale(){
  const b = CALM.breath;
  if (!b) return 0.92 + Math.sin(CV.t / 1.6) * 0.06;                  // idle: slow ~10 s breath
  const [word, secs] = b.steps[b.i], p = Math.min(1, (performance.now() - b.at) / (secs * 1000));
  const target = /more/i.test(word) ? 1.25 : /in/i.test(word) ? 1.17 : /out/i.test(word) ? 0.72 : b.from;
  return b.from + (target - b.from) * (0.5 - Math.cos(Math.PI * p) / 2);
}
function cvDraw(){
  const {ctx, w, h, t} = CV, s = SCENES[CALM.scene];
  const g = ctx.createLinearGradient(0, 0, 0, h); s.bg.forEach((c, i) => g.addColorStop(i / (s.bg.length - 1), c)); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  if (s.nebula){ s.nebula.forEach((c, i) => { const x = w * (0.3 + 0.4 * i) + Math.sin(t / 20 + i) * 40, y = h * (0.35 + 0.1 * i); const r = ctx.createRadialGradient(x, y, 0, x, y, w * 0.45); r.addColorStop(0, c + '55'); r.addColorStop(1, c + '00'); ctx.fillStyle = r; ctx.fillRect(0, 0, w, h); }); }
  if (s.parts === 'stars' || s.parts === 'sparkle'){
    for (const p of CV.parts){ const a = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * (0.6 + p.v) + p.r * 20)); if (s.parts === 'sparkle' && p.y < h * 0.62) continue;
      ctx.fillStyle = `rgba(255,255,255,${a * (s.parts === 'sparkle' ? 0.5 : 1)})`; ctx.fillRect(p.x, s.parts === 'sparkle' ? p.y : p.y * 0.8, p.r * 1.6 + 0.4, p.r * 1.6 + 0.4); }
  }
  if (s.ribbons){
    ctx.globalCompositeOperation = 'lighter';
    s.ribbons.forEach((c, i) => {
      const base = h * (0.28 + i * 0.07); ctx.beginPath(); ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 16) ctx.lineTo(x, base + Math.sin(x * 0.0035 + t * 0.18 + i * 1.7) * 55 + Math.sin(x * 0.009 - t * 0.11 + i) * 22);
      ctx.lineTo(w, h); ctx.closePath();
      const gr = ctx.createLinearGradient(0, base - 80, 0, base + 260); gr.addColorStop(0, c + '00'); gr.addColorStop(0.25, c + '40'); gr.addColorStop(1, c + '00');
      ctx.fillStyle = gr; ctx.fill();
    });
    ctx.globalCompositeOperation = 'source-over';
  }
  if (s.moon){ const x = w * 0.78, y = h * 0.2, r = ctx.createRadialGradient(x, y, 0, x, y, 140); r.addColorStop(0, 'rgba(255,245,220,.95)'); r.addColorStop(0.18, 'rgba(255,240,210,.55)'); r.addColorStop(1, 'rgba(255,240,210,0)'); ctx.fillStyle = r; ctx.fillRect(x - 140, y - 140, 280, 280); }
  if (s.waves){
    s.waves.forEach((c, i) => { const base = h * (0.62 + i * 0.09); ctx.beginPath(); ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 12) ctx.lineTo(x, base + Math.sin(x * 0.008 + t * (0.35 + i * 0.08) + i) * (10 + i * 4) + Math.sin(x * 0.02 - t * 0.5) * 3);
      ctx.lineTo(w, h); ctx.closePath(); ctx.fillStyle = c + 'dd'; ctx.fill(); });
  }
  if (s.parts === 'bokeh'){
    for (const p of CV.parts){ p.y -= 0.15 + p.v * 0.25; p.x += Math.sin(t * 0.3 + p.r * 9) * 0.2; if (p.y < -60){ p.y = h + 60; p.x = Math.random() * w; }
      const rad = 12 + p.r * 34, r = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad); r.addColorStop(0, p.c + '55'); r.addColorStop(1, p.c + '00'); ctx.fillStyle = r; ctx.fillRect(p.x - rad, p.y - rad, rad * 2, rad * 2); }
  }
  if (s.parts === 'rain'){
    for (const p of CV.parts.slice(0, 18)){ const rad = 30 + p.r * 50, x = p.x, y = h * 0.55 + p.v * h * 0.4, r = ctx.createRadialGradient(x, y, 0, x, y, rad); r.addColorStop(0, p.c + '30'); r.addColorStop(1, p.c + '00'); ctx.fillStyle = r; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2); }
    ctx.strokeStyle = 'rgba(180,200,230,.28)'; ctx.lineWidth = 1; ctx.beginPath();
    for (const p of CV.parts){ p.y += 9 + p.v * 7; p.x -= 1.5; if (p.y > h){ p.y = -20; p.x = Math.random() * (w + 100); } ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 3, p.y - 14 - p.r * 10); }
    ctx.stroke();
  }
  // breathing orb (also Zuzu's presence)
  const cx = w / 2, cy = h * (w < 760 ? 0.27 : 0.3), speaking = document.body.classList.contains('speaking');
  const sc = breathScale(); if (CALM.breath) CALM.breath.lastScale = sc;
  const R = Math.min(w, h) * 0.13 * sc * (speaking ? 1 + Math.sin(t * 7) * 0.025 : 1);
  const og = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 2.2); og.addColorStop(0, 'rgba(255,255,255,.55)'); og.addColorStop(0.35, 'rgba(190,230,255,.22)'); og.addColorStop(1, 'rgba(160,210,255,0)');
  ctx.fillStyle = og; ctx.beginPath(); ctx.arc(cx, cy, R * 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
}
function cvLoop(now){
  if (!CALM.active) return;
  CV.raf = requestAnimationFrame(cvLoop);
  if (now - CV.last < 33) return;                  // ~30 fps is plenty for slow motion
  CV.t += (now - (CV.last || now)) / 1000; CV.last = now;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) CV.t = 0;
  cvDraw();
}
function calmSetScene(scene){ if (!SCENES[scene]) return; CALM.scene = scene; $('#calmScene').value = scene; cvResize(); calmSave(); }
function calmSetSound(sound){ CALM.sound = sound; $('#calmSound').value = sound; if (CALM.active) calmSoundStart(sound); calmSave(); }

// ── breathing guide ─────────────────────────────────────────────────
function calmBreathe(pattern = 'box', minutes = 2){
  const p = CALM_BREATH[pattern] || CALM_BREATH.box;
  calmBreathStop();
  const until = Date.now() + Math.max(0.5, Math.min(20, Number(minutes) || 2)) * 60000;
  CALM.breath = {steps:p.steps, i:0, at:performance.now(), name:p.name};
  $('#calmBreath').hidden = false;
  const step = () => {
    const b = CALM.breath; if (!b) return;
    const [word, secs] = b.steps[b.i];
    $('#calmBreathWord').textContent = word; b.from = b.lastScale || 0.9; b.at = performance.now(); calmChime(/in|more/i.test(word) ? 528 : /out/i.test(word) ? 396 : 440);
    let left = Math.ceil(secs); $('#calmBreathCount').textContent = left;
    clearInterval(b.tick); b.tick = setInterval(() => { left = Math.max(0, left - 1); $('#calmBreathCount').textContent = left || ''; }, 1000);
    b.timer = setTimeout(() => {
      if (Date.now() > until && b.i === b.steps.length - 1){ calmBreathStop(); calmCaption('Well done. Notice how your body feels now.'); return; }
      b.i = (b.i + 1) % b.steps.length; step();
    }, secs * 1000);
  };
  step();
  document.querySelectorAll('[data-breathe]').forEach(x => x.classList.toggle('active', x.dataset.breathe === pattern));
  return {started:p.name, minutes:Number(minutes) || 2};
}
function calmBreathStop(){
  const b = CALM.breath; if (b){ clearTimeout(b.timer); clearInterval(b.tick); }
  CALM.breath = null; if ($('#calmBreath')) $('#calmBreath').hidden = true;
  document.querySelectorAll('[data-breathe]').forEach(x => x.classList.remove('active'));
}

// ── talking ─────────────────────────────────────────────────────────
function calmCaption(text){ const el = $('#calmCaption'); if (el && text) el.textContent = text; }
function calmCheckCrisis(text){
  if (!text || !CALM_CRISIS.test(text) || CALM.crisisShown) return;
  CALM.crisisShown = true;
  const lines = (CALM.state?.helpLines || []).map(l => `<li><a href="tel:${esc(l.number.replace(/[^\d+]/g, '').slice(0, 12))}"><b>${esc(l.number)}</b> ${esc(l.name)}</a><small>${esc(l.note)}</small></li>`).join('');
  $('#calmCrisis').innerHTML = `<h3>You matter, and you don't have to carry this alone.</h3><p>If you might hurt yourself or you're not safe, please talk to someone right now:</p><ul>${lines}</ul>
    <p>Reach out to someone you trust nearby, too. Zuzu is here with you while you do.</p><button type="button" id="calmSafe">I'm safe right now</button>`;
  $('#calmCrisis').hidden = false;
  $('#calmSafe').onclick = () => { $('#calmCrisis').hidden = true; };
}
function calmLiveOpen(){ return typeof liveReady !== 'undefined' && liveReady && liveWs && liveWs.readyState === WebSocket.OPEN; }
async function calmSay(text, {show = true} = {}){
  text = String(text || '').trim(); if (!text) return;
  calmCheckCrisis(text);
  if (show){ $('#calmYou').textContent = text.length > 160 ? text.slice(0, 157) + '…' : text; }
  if (calmLiveOpen()){ liveWs.send(JSON.stringify({clientContent:{turns:[{role:'user', parts:[{text}]}], turnComplete:true}})); return; }
  CALM.history.push({role:'you', text});
  calmCaption('…');
  try{
    const r = await fetch('/api/calm', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify({action:'chat', messages:CALM.history})});
    const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    CALM.history.push({role:'zuzu', text:d.reply}); calmCaption(d.reply);
    if (d.crisis) calmCheckCrisis(text);
    if (typeof speakWithLive === 'function') speakWithLive(d.reply).catch(() => {});
  }catch(err){ calmCaption('I\'m still here. The connection dropped for a moment — try again when you\'re ready.'); }
}
function calmPollTalk(){
  if (!CALM.active) return;
  const live = calmLiveOpen();
  $('#calmMic').classList.toggle('on', live || (typeof convo !== 'undefined' && convo));
  $('#calmMic').querySelector('span').textContent = live ? 'Listening' : 'Talk';
  const mute = $('#calmMute');
  if (mute){ const muted = typeof micMuted !== 'undefined' && micMuted; mute.hidden = !live && !muted; mute.textContent = muted ? 'Unmute' : 'Mute'; mute.classList.toggle('on', muted); }
  if (live && typeof answer === 'string' && answer.trim()){ const tail = answer.trim(); calmCaption(tail.length > 260 ? '…' + tail.slice(-257) : tail); }
  const you = (typeof liveUserTurn === 'string' && liveUserTurn.trim()) || '';
  if (you && you !== CALM.lastYou){ CALM.lastYou = you; $('#calmYou').textContent = you.slice(-160); calmCheckCrisis(you); }
  calmSoundLevel();
}

// ── mood ────────────────────────────────────────────────────────────
function calmRenderMoods(){
  const moods = (CALM.state?.moods || []).slice(-14), faces = ['', '😞', '🙁', '😐', '🙂', '😄'];
  $('#calmMoodChart').innerHTML = moods.length ? moods.map(m => `<span title="${esc(m.at.replace('T', ' '))}${m.words.length ? ' · ' + esc(m.words.join(', ')) : ''}" style="--h:${m.mood * 20}%"><i></i><small>${faces[m.mood]}</small></span>`).join('')
    : '<p>Your check-ins will show here. Only you can see them.</p>';
  $('#calmWords').innerHTML = CALM_WORDS.map(w => `<button type="button" data-mood-word="${w}" class="${CALM.words.has(w) ? 'active' : ''}">${w}</button>`).join('');
}
async function calmLogMood(mood, words = []){
  const r = await fetch('/api/calm', {method:'POST', headers:apiHeaders({'content-type':'application/json'}), body:JSON.stringify({action:'mood', mood:Number(mood), words})});
  const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  CALM.state = {...CALM.state, ...d}; calmRenderMoods(); return d.entry;
}

// ── enter / exit ────────────────────────────────────────────────────
function calmSave(){ try{ localStorage.setItem('zuzu-calm', JSON.stringify({scene:CALM.scene, sound:CALM.sound, volume:CALM.volume, voice:CALM.voice})); }catch(_){} }
async function calmLoadState(){
  try{ const r = await fetch('/api/calm', {headers:apiHeaders(), cache:'no-store'}); if (r.ok) CALM.state = await r.json(); }catch(_){}
  const voices = CALM.state?.voices || {Achernar:'Soft'};
  $('#calmVoice').innerHTML = Object.entries(voices).map(([k, v]) => `<option value="${k}" ${k === CALM.voice ? 'selected' : ''}>${v} (${k})</option>`).join('');
  $('#calmHelp').innerHTML = `<p>If things feel too heavy, a real person can help right now:</p><ul>${(CALM.state?.helpLines || []).map(l => `<li><a href="tel:${esc(l.number.replace(/[^\d+]/g, '').slice(0, 12))}"><b>${esc(l.number)}</b> ${esc(l.name)}</a><small>${esc(l.note)}</small></li>`).join('')}</ul>`;
  calmRenderMoods();
}
async function calmEnter(){
  if (CALM.active) return {already:true};
  CALM.active = true; CALM.crisisShown = false; CALM.history = []; CALM.lastYou = '';
  window.calmSession = {voice:CALM.voice, remember:CALM.remember};
  $('#calm').hidden = false; document.body.classList.add('calm-on');
  cvResize(); CV.last = 0; CV.raf = requestAnimationFrame(cvLoop);
  calmSoundStart(CALM.sound);
  calmCaption('Take a slow breath… I\'m here with you.'); $('#calmYou').textContent = '';
  CALM.timers.push(setInterval(calmPollTalk, 400));
  CALM.timers.push(setInterval(() => { $('#calmTip').textContent = '💡 ' + CALM_TIPS[CALM.tipIdx++ % CALM_TIPS.length]; }, 25000));
  $('#calmTip').textContent = '💡 ' + CALM_TIPS[CALM.tipIdx++ % CALM_TIPS.length];
  calmLoadState();
  // Restart voice with the soft Calm persona
  if (typeof stopConvo === 'function' && (typeof liveReady !== 'undefined' && (liveReady || convo))) stopConvo(false);
  setTimeout(async () => {
    if (!CALM.active) return;
    try{ await startGeminiLive(); }catch(_){}
    let waited = 0;
    const greet = setInterval(() => {
      waited += 300;
      if (calmLiveOpen()){ clearInterval(greet); calmSay('(Calm mode just started. Greet me softly in my language and gently ask how I am feeling today.)', {show:false}); }
      else if (waited > 12000 || !CALM.active){ clearInterval(greet); if (CALM.active) calmCaption('Take a slow breath… You can type below, or press Talk when you\'re ready.'); }
    }, 300);
  }, 450);
  return {entered:true};
}
function calmExit(){
  if (!CALM.active) return;
  CALM.active = false; cancelAnimationFrame(CV.raf); CALM.timers.forEach(clearInterval); CALM.timers = [];
  calmBreathStop(); calmSoundStop(2);
  if (typeof stopConvo === 'function') stopConvo(true);
  window.calmSession = null;
  $('#calm').hidden = true; document.body.classList.remove('calm-on');
  showToast('Calm session ended. Be gentle with yourself today. 🌿', 'info');
}

// ── wiring ──────────────────────────────────────────────────────────
try{ Object.assign(CALM, JSON.parse(localStorage.getItem('zuzu-calm') || '{}')); }catch(_){}
if ($('#calm')){
  $('#calmScene').value = CALM.scene; $('#calmSound').value = CALM.sound; $('#calmVolume').value = Math.round(CALM.volume * 100);
  document.addEventListener('click', e => { if (e.target.closest('[data-calm-open]')) calmEnter(); });
  $('#calmExit').onclick = calmExit;
  $('#calmScene').onchange = e => calmSetScene(e.target.value);
  $('#calmSound').onchange = e => calmSetSound(e.target.value);
  $('#calmVolume').oninput = e => { CALM.volume = Number(e.target.value) / 100; calmSoundLevel(0.3); calmSave(); };
  $('#calmVoice').onchange = e => { CALM.voice = e.target.value; if (window.calmSession) window.calmSession.voice = CALM.voice; calmSave();
    if (calmLiveOpen()){ stopConvo(false); setTimeout(() => startGeminiLive(), 400); } };
  $('#calmRemember').onchange = e => { CALM.remember = e.target.checked; if (window.calmSession) window.calmSession.remember = CALM.remember; };
  $('#calmMic').onclick = () => { if (typeof micToggle === 'function') micToggle(); };
  $('#calmMute').onclick = () => { if (typeof toggleMicMute === 'function') toggleMicMute(); calmPollTalk(); };
  $('#calmForm').onsubmit = e => { e.preventDefault(); const v = $('#calmInput').value; $('#calmInput').value = ''; calmSay(v); };
  $('#calmBreathStop').onclick = calmBreathStop;
  document.querySelectorAll('[data-calm-tab]').forEach(b => b.onclick = () => {
    document.querySelectorAll('[data-calm-tab]').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('[data-calm-panel]').forEach(p => p.hidden = p.dataset.calmPanel !== b.dataset.calmTab);
  });
  document.querySelectorAll('[data-breathe]').forEach(b => b.onclick = () => calmBreathe(b.dataset.breathe, 2));
  $('#calmGround').innerHTML = CALM_GROUND.map(([n, what, hint], i) => `<button type="button" data-ground="${i}"><b>${n}</b><span>${what}</span><small>${hint}</small></button>`).join('')
    + '<button type="button" class="calm-guide" data-guide="Guide me slowly through the 5-4-3-2-1 grounding exercise, one step at a time, waiting for me.">Guide me by voice</button>';
  $('#calmBody').innerHTML = `<p class="calm-bodynow" id="calmBodyNow">A slow scan from feet to head, about 4 minutes.</p><div class="ed-row"><button type="button" id="calmBodyStart">Start body scan</button>
    <button type="button" class="calm-guide" data-guide="Guide me through a slow, gentle body scan from my feet to my head, with long pauses.">Guide me by voice</button></div>`;
  $('#calmGround').addEventListener('click', e => { const b = e.target.closest('[data-ground]'); if (b) b.classList.toggle('done'); });
  $('#calmBodyStart')?.addEventListener('click', () => {
    let i = 0; const show = () => { if (!CALM.active) return; $('#calmBodyNow').textContent = CALM_BODY[i]; calmCaption(CALM_BODY[i]); calmChime(432); if (++i < CALM_BODY.length) CALM.timers.push(setTimeout(show, 26000)); };
    show();
  });
  document.addEventListener('click', e => { const g = e.target.closest('[data-guide]'); if (g && CALM.active) calmSay(g.dataset.guide); });
  $('#calmReframe').onsubmit = e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    calmSay(`Help me look at a thought gently (CBT). What happened: ${f.situation || '—'}. My thought: "${f.thought || '—'}". Feeling strength ${f.feeling}/10. Ask me one question at a time about the evidence, then help me find a kinder, balanced thought.`); e.target.reset(); };
  $('#calmJournal').onsubmit = e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    calmSay(`My journal for today. Three good things: ${f.good || '—'}. What's on my mind: ${f.mind || '—'}. Reflect it back to me gently.`); e.target.reset(); };
  $('#calmMoods').addEventListener('click', async e => { const b = e.target.closest('[data-mood]'); if (!b) return;
    document.querySelectorAll('[data-mood]').forEach(x => x.classList.toggle('active', x === b));
    try{ await calmLogMood(b.dataset.mood, [...CALM.words]); showToast('Mood saved (private)', 'info'); CALM.words.clear(); calmRenderMoods(); }catch(err){ showToast(String(err.message || err), 'error'); } });
  $('#calmWords').addEventListener('click', e => { const b = e.target.closest('[data-mood-word]'); if (!b) return; const w = b.dataset.moodWord; CALM.words.has(w) ? CALM.words.delete(w) : CALM.words.add(w); calmRenderMoods(); });
  window.addEventListener('resize', () => CALM.active && cvResize());
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && CALM.active && !$('#calmCrisis').hidden){ $('#calmCrisis').hidden = true; } });
}
if (typeof LOCAL_TOOLS !== 'undefined'){
  LOCAL_TOOLS.calm_mode = async () => { await calmEnter(); return {entered:true, note:'Calm mode opens with a soft voice; the user continues there.'}; };
  LOCAL_TOOLS.start_breathing = async a => calmBreathe(String(a.pattern || 'box').replace(/[^a-z0-9]/gi, '').toLowerCase(), a.minutes);
  LOCAL_TOOLS.set_calm_scene = async a => { if (a.scene) calmSetScene(String(a.scene).toLowerCase()); if (a.sound) calmSetSound(String(a.sound).toLowerCase()); return {scene:CALM.scene, sound:CALM.sound}; };
  LOCAL_TOOLS.log_mood = async a => { const e = await calmLogMood(Math.max(1, Math.min(5, Number(a.mood) || 3)), String(a.words || '').split(',').map(w => w.trim()).filter(Boolean).slice(0, 3)); return {saved:true, mood:e.mood}; };
  LOCAL_TOOLS.leave_calm_mode = async () => { setTimeout(calmExit, 2500); return {leaving:true}; };
}

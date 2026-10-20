const {test}=require('node:test');
const assert=require('node:assert/strict');
const {HermesVoiceBridge}=require('../ui/live-bridge.js');
const {VoiceResultQueue}=require('../ui/live-bridge.js');
const chat={project_id:'home',chat_id:'a'},other={project_id:'home',chat_id:'b'};
function storage(){const data=new Map();return {getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
test('result survives interruption and reconnect, is acknowledged only after speech',()=>{
  const saved=storage(),q=new VoiceResultQueue(saved);
  q.expect('r',chat);q.complete('r',{result:'actual outcome'});q.markSent('r');
  assert.equal(q.pending(chat).length,0);
  q.resetDelivery();
  q.acknowledge(['r']); // old interrupted audio callback must not clear it
  assert.equal(q.pending(chat).length,1);
  const resumed=new VoiceResultQueue(saved);
  assert.equal(resumed.pending(other).length,0);
  assert.equal(resumed.pending(chat)[0].response.result,'actual outcome');
  resumed.markSent('r');resumed.acknowledge(['r']);
  assert.equal(new VoiceResultQueue(saved).items.length,0);
});
test('reload recovers accepted actions from saved server runs without redispatch',()=>{
  const saved=storage(),q=new VoiceResultQueue(saved);
  q.expect('r',chat);
  q.markSent('r');q.acknowledge(['r']);
  assert.equal(q.items.length,1,'A transport error is not the final action outcome');
  const reloaded=new VoiceResultQueue(saved);
  reloaded.recover(other,[{id:'r',state:'complete',answer:'wrong chat'}]);
  assert.equal(reloaded.pending(chat).length,0);
  reloaded.recover(chat,[{id:'r',state:'running'}]);
  assert.equal(reloaded.pending(chat).length,0);
  reloaded.recover(chat,[{id:'r',state:'complete',answer:'real saved result'}]);
  assert.equal(reloaded.pending(chat)[0].response.result,'real saved result');
});
test('cancelled tool result is queued for the same conversation rather than lost',async()=>{
  const q=new VoiceResultQueue(storage()),sent=[];let finish;
  const bridge=new HermesVoiceBridge(async()=>{
    q.expect('r',chat);
    const result=await new Promise(resolve=>finish=resolve);
    q.complete('r',result);return result;
  },m=>sent.push(m));
  const work=bridge.handle({id:'call',name:'hermes_action',args:{request:'test'}});
  await Promise.resolve();bridge.cancel(['call']);finish({result:'completed'});await work;
  assert.equal(sent.length,0);
  assert.equal(q.pending(chat)[0].response.result,'completed');
});
test('page sends recovered results through Live only when user is not speaking, without rerunning Hermes',()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const script=fs.readFileSync(require('node:path').join(__dirname,'../ui/app.js'),'utf8');
  const source=script.slice(script.indexOf('function deliverVoiceResults(){'),script.indexOf('setInterval(deliverVoiceResults'));
  const q=new VoiceResultQueue(storage()),sent=[];
  q.expect('r',chat);q.complete('r',{result:'real outcome'});
  const ctx=vm.createContext({liveReady:true,liveWs:{readyState:1,send:x=>sent.push(JSON.parse(x))},
    WebSocket:{OPEN:1},liveSpeaking:false,serverBusy:false,dispatchReserved:false,liveUserTurn:'still speaking',
    liveUserAudioAt:0,voiceResults:q,liveChat:chat});
  vm.runInContext(source,ctx);
  ctx.deliverVoiceResults();assert.equal(sent.length,0);
  ctx.liveUserTurn='';ctx.liveChat=other;
  ctx.deliverVoiceResults();assert.equal(sent.length,0);
  ctx.liveChat=chat;ctx.liveUserAudioAt=Date.now();
  ctx.deliverVoiceResults();assert.equal(sent.length,0);
  ctx.liveUserAudioAt=0;
  ctx.serverBusy=true;
  ctx.deliverVoiceResults();assert.equal(sent.length,0);
  ctx.serverBusy=false;
  ctx.deliverVoiceResults();ctx.deliverVoiceResults();
  assert.equal(sent.length,1);
  assert.match(sent[0].clientContent.turns[0].parts[0].text,/real outcome/);
  assert.equal(ctx.dispatchReserved,true);
  assert.equal(q.items.length,1,'Sending alone must not acknowledge spoken delivery');
});
test('Live connection failure preserves selected engine instead of silently changing voice',()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const script=fs.readFileSync(require('node:path').join(__dirname,'../ui/app.js'),'utf8');
  const source=script.slice(script.indexOf('function useVoiceFallback(reason){'),script.indexOf('function floatToPcm16Base64'));
  const states=[],runtime={live:true,tts:true},ctx=vm.createContext({
    stopConvo:()=>{},sessionStorage:storage(),RT:runtime,log:()=>{},setState:(...args)=>states.push(args),
    micToggle:()=>{throw Error('Unexpected engine switch')},voiceWanted:true,liveFailedUntil:0,renderVoiceConversation:()=>{},
  });
  vm.runInContext(source,ctx);ctx.useVoiceFallback('network interrupted');
  assert.deepEqual(runtime,{live:true,tts:true});
  assert.equal(states[0][1],'RECONNECT VOICE');
});
test('repeated call ID dispatches once and returns one result to original voice',async()=>{
  let count=0; const sent=[];
  const bridge=new HermesVoiceBridge(async()=>{count++;return {result:'actual result'}},m=>sent.push(m));
  const call={id:'a',name:'hermes_action',args:{request:'Open Paint'}};
  await Promise.all([bridge.handle(call),bridge.handle(call)]);
  assert.equal(count,1);assert.equal(sent.length,1);
  assert.equal(sent[0].toolResponse.functionResponses[0].response.result,'actual result');
  await bridge.handle({...call,id:'b'});assert.equal(count,2);
});
test('failure goes back as an error, never success',async()=>{
  const sent=[];
  const bridge=new HermesVoiceBridge(async()=>{throw Error('Provider denied access')},m=>sent.push(m));
  await bridge.handle({id:'a',name:'hermes_action',args:{request:'Open Paint'}});
  assert.match(sent[0].toolResponse.functionResponses[0].response.error,/denied/);
});
test('cancelled or disconnected requests cannot speak late results',async()=>{
  let finish,signal;const sent=[];
  const bridge=new HermesVoiceBridge((_,s)=>{signal=s;return new Promise(r=>finish=r)},m=>sent.push(m));
  const promise=bridge.handle({id:'a',name:'hermes_action',args:{request:'Open Paint'}});
  await Promise.resolve();bridge.cancel(['a']);finish({result:'done'});await promise;
  assert.equal(signal.aborted,false,'Barge-in must not abort an accepted action');
  assert.equal(sent.length,0);bridge.close();
  await bridge.handle({id:'b',name:'hermes_action',args:{request:'Open Paint'}});
  assert.equal(sent.length,0);
});
test('local voice tools run in the page and never reach Hermes',async()=>{
  const sent=[];let hermesCalls=0;
  const bridge=new HermesVoiceBridge(async()=>{hermesCalls++;return {result:'x'};},m=>sent.push(m),
    {play_music:async args=>({playing:args.query})});
  await bridge.handle({id:'m1',name:'play_music',args:{query:'Amr Diab'}});
  assert.equal(hermesCalls,0);
  assert.deepEqual(sent[0].toolResponse.functionResponses[0].response,{playing:'Amr Diab'});
  await bridge.handle({id:'m2',name:'unknown_tool',args:{}});
  assert.match(sent[1].toolResponse.functionResponses[0].response.error,/Invalid/);
});
const MG=require('../ui/memory-graph.js');
test('memory graph links notes by [[links]], #tags, mentions and ghosts',()=>{
  const ws={settings:{profile:'Ali'},projects:[{id:'p1',name:'Villa fit-out',folder:'C:/work/villa',sessions:[]}],
    memory:[{id:'a',label:'Wife',value:'Birthday 12 March. Loves [[Resin art]] #family'},
            {id:'b',label:'Resin art',value:'Epoxy table project for the Villa fit-out #craft',tags:['hobby']},
            {id:'c',label:'Gym',value:'Train Mon/Wed [[Coach Sam]]'}],
    skills:[],hermesMemory:[{source:'MEMORY.md',content:'Prefers Arabic replies§Works in Dubai fit-out'}]};
  const g=MG.buildMemoryGraph(ws);
  assert.ok(g.nodes.every(n=>Array.isArray(n.history)),'Every selectable node supports the details panel');
  const has=(a,b,kind)=>g.links.some(l=>((l.source===a&&l.target===b)||(l.source===b&&l.target===a))&&(!kind||l.kind===kind));
  assert.ok(has('m:a','m:b','link'));
  assert.ok(has('m:a','t:family','tag')); assert.ok(has('m:b','t:hobby','tag')); assert.ok(has('m:b','t:craft','tag'));
  assert.ok(has('m:b','p:p1','mention'));
  assert.equal(g.byId.get('g:coach sam').group,'ghost'); assert.ok(has('m:c','g:coach sam','link'));
  assert.equal(g.nodes.filter(n=>n.source==='MEMORY.md').length,2);
  assert.ok(!MG.buildMemoryGraph(ws,{tags:false}).nodes.some(n=>n.group==='tag'));
  assert.deepEqual([...MG.localIds(g,'m:c',1)].sort(),['g:coach sam','m:c']);
});
test('note markdown escapes HTML and turns links and tags into buttons',()=>{
  const html=MG.renderNoteMarkdown('<img src=x onerror=alert(1)> see [[Resin art]] #family\n- **bold** item');
  assert.ok(!html.includes('<img')); assert.match(html,/data-mg-open-name="Resin art"/);
  assert.match(html,/data-mg-tag="family"/); assert.match(html,/<ul><li><b>bold<\/b> item<\/li><\/ul>/);
});

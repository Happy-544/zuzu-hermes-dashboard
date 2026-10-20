const {test}=require('node:test');
const assert=require('node:assert/strict');
const {HermesVoiceBridge}=require('../ui/live-bridge.js');
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

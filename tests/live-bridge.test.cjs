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
  let finish;const sent=[];
  const bridge=new HermesVoiceBridge(()=>new Promise(r=>finish=r),m=>sent.push(m));
  const promise=bridge.handle({id:'a',name:'hermes_action',args:{request:'Open Paint'}});
  await Promise.resolve();bridge.cancel(['a']);finish({result:'done'});await promise;
  assert.equal(sent.length,0);bridge.close();
  await bridge.handle({id:'b',name:'hermes_action',args:{request:'Open Paint'}});
  assert.equal(sent.length,0);
});

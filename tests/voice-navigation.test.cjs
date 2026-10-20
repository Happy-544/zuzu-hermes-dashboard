const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {VoiceResultQueue}=require('../ui/live-bridge.js');
const script=fs.readFileSync(path.join(__dirname,'../ui/app.js'),'utf8');
const origin={project_id:'home',chat_id:'a'},other={project_id:'home',chat_id:'b'};
const noop=()=>{};
function state(){return {selectedProject:'home',selectedSession:'a',projects:[{id:'home',sessions:[{id:'a',name:'Original call'},{id:'b',name:'Other chat'}]}]};}
function functions(ctx){
  vm.runInContext(script.slice(script.indexOf('function chatRef(){'),script.indexOf("$('#returnToVoiceChat').onclick")),ctx);
}
test('browsing another conversation preserves live socket, origin, partial transcript and microphone',async()=>{
  const socket={close:()=>{throw Error('Voice must remain open')}};
  let persisted=0,loaded=0;
  const ctx=vm.createContext({WS:state(),liveChat:origin,liveWs:socket,liveUserTurn:'My unfinished question',
    liveAssistantTurn:'Original response',convo:true,liveConnecting:false,voiceWanted:true,
    persistLiveTurn:async()=>persisted++,localStorage:{setItem:noop},apiHeaders:x=>x,
    fetch:async()=>({ok:true,json:async()=>({...state(),selectedSession:'b'})}),
    renderWorkspace:noop,setUserText:noop,renderAnswer:noop,loadHistory:async()=>loaded++,
    stopConvo:()=>{throw Error('Browsing must not hang up')},$:()=>null});
  functions(ctx);
  vm.runInContext(script.slice(script.indexOf('const workspaceRequest ='),script.indexOf("const editor ="))+
    '\nglobalThis.navigate=workspaceRequest;',ctx);
  await ctx.navigate({action:'select_session',projectId:'home',sessionId:'b'});
  assert.equal(ctx.WS.selectedSession,'b');
  assert.equal(ctx.liveChat,origin);assert.equal(ctx.liveWs,socket);
  assert.equal(ctx.liveUserTurn,'My unfinished question');assert.equal(ctx.convo,true);
  assert.equal(persisted,1);assert.equal(loaded,1);
});
test('voice indicator names the original conversation and offers return only when browsing elsewhere',()=>{
  const elements={'#voiceConversation':{},'#voiceConversationName':{},'#returnToVoiceChat':{}};
  const ctx=vm.createContext({WS:state(),liveChat:origin,convo:true,liveConnecting:false,voiceWanted:true,$:s=>elements[s]});
  functions(ctx);ctx.renderVoiceConversation();
  assert.equal(elements['#voiceConversationName'].textContent,'Voice · Original call');
  assert.equal(elements['#returnToVoiceChat'].hidden,true);
  ctx.WS.selectedSession='b';ctx.renderVoiceConversation();
  assert.equal(elements['#returnToVoiceChat'].hidden,false);
  ctx.convo=false;ctx.voiceWanted=false;ctx.renderVoiceConversation();
  assert.equal(elements['#voiceConversation'].hidden,true);
});
function transmissionHarness(voice=false){
  const sent=[],posts=[],spoken=[];
  const ctx=vm.createContext({
    WS:{...state(),selectedSession:'b'},liveChat:origin,liveReady:!voice,liveUserTurn:'Original voice context',
    liveWs:{readyState:1,send:x=>sent.push(x)},WebSocket:{OPEN:1},convo:true,
    dispatchReserved:false,running:false,log:noop,showToast:noop,handleLocalCommand:async()=>false,
    maybeOpenRequestedBrowserPreview:()=>'',attachVisualContext:async x=>x,attachUploadedContext:x=>x,
    showView:noop,resetSteps:noop,watchPc:noop,rid:()=> 'test-run',setUserText:noop,setState:noop,setTag:noop,
    $:()=>({}),performance,setInterval:()=>1,clearInterval:noop,AbortController,TextDecoder,apiHeaders:x=>x,
    clientDeviceContext:()=>({}),clientContextSystemText:()=>'',finishSteps:noop,scheduleJobPoll:noop,
    loadWorkspace:noop,speakDone:Promise.resolve(),handle:noop,speak:x=>{spoken.push(x);return Promise.resolve()},
    fetch:async(url,options)=>{
      posts.push(JSON.parse(options.body));let finished=false;
      return {ok:true,body:{getReader:()=>({read:async()=>{
        if(finished)return {done:true};finished=true;
        return {done:false,value:new TextEncoder().encode('{"t":"delta","text":"Actual result"}\n{"t":"complete"}\n')};
      }})}};
    }
  });
  functions(ctx);
  vm.runInContext(script.slice(script.indexOf('async function transmit('),script.indexOf('function firstMediaReference')),ctx);
  return {ctx,sent,posts,spoken};
}
test('typing in a different chat goes to that chat without being sent into the live call',async()=>{
  const {ctx,sent,posts,spoken}=transmissionHarness();
  await ctx.transmit('A separate typed question');
  assert.equal(sent.length,0);assert.equal(posts.length,1);
  assert.equal(posts[0].chat_id,'b');assert.equal(ctx.liveUserTurn,'Original voice context');
  assert.equal(ctx.speakThisRun,false);assert.equal(spoken.length,0);
});
test('local voice still routes and speaks in its original conversation while another chat is visible',async()=>{
  const {ctx,posts,spoken}=transmissionHarness(true);
  await ctx.transmit('My voice question',{chat:origin,voice:true});
  assert.equal(posts[0].chat_id,'a');
  assert.deepEqual(spoken,['Actual result']);
  assert.equal(ctx.WS.selectedSession,'b');
});
test('reconnect requests context for the original chat even when another chat is selected',async()=>{
  let request;
  const ctx=vm.createContext({
    WS:{...state(),selectedSession:'b'},liveChat:origin,liveConnecting:false,liveReady:false,
    liveConnectEpoch:0,voiceSaveQueue:Promise.resolve(),voiceResults:{resetDelivery:noop},
    player:null,speechSynth:null,renderVoiceConversation:noop,setState:noop,$:()=>null,
    apiHeaders:x=>x,clientDeviceContext:()=>({}),clientContextSystemText:()=>'',window:{},
    fetch:async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({})};},
    navigator:{mediaDevices:{getUserMedia:async()=>{throw Error('End isolated connection test');}}},
    useVoiceFallback:noop,log:noop
  });
  functions(ctx);
  vm.runInContext(script.slice(script.indexOf('async function startGeminiLive(){'),script.indexOf('async function speakWithLive(')),ctx);
  await ctx.startGeminiLive();
  assert.equal(request.chat_id,'a');assert.equal(ctx.liveChat,origin);
});
test('deleting one chat discards only its voice outbox',()=>{
  const queue=new VoiceResultQueue({getItem:()=>null,setItem:noop});
  queue.expect('a',origin);queue.expect('b',other);
  queue.discardChat(other);
  assert.deepEqual(queue.items.map(x=>x.id),['a']);
});
test('delete confirmation is asynchronous and cancel leaves the conversation intact',async()=>{
  let close,shown=false,resolved=false;
  const dialog={addEventListener:(_event,fn)=>close=fn,showModal:()=>shown=true};
  const text={};
  const ctx=vm.createContext({$:s=>s==='#deleteConversationDialog'?dialog:text});
  vm.runInContext(script.slice(script.indexOf('function confirmConversationDeletion('),script.indexOf('function renderWorkspace(')),ctx);
  const pending=ctx.confirmConversationDeletion('Original call').then(result=>{resolved=true;return result;});
  await Promise.resolve();
  assert.equal(shown,true);assert.equal(resolved,false);
  assert.match(text.textContent,/Saved memories/);
  close();assert.equal(await pending,false);
  const approved=ctx.confirmConversationDeletion('Other call');
  dialog.returnValue='delete';close();assert.equal(await approved,true);
});

/* One execution per Live function-call ID; executor output is never spoken here. */
class HermesVoiceBridge {
  constructor(execute, send, local = {}) {
    this.execute = execute; this.send = send; this.local = local;
    this.calls = new Map(); this.cancelled = new Set(); this.closed = false;
    this.controllers = new Map();
  }
  cancel(ids) {
    for (const id of ids) {
      this.cancelled.add(id);
      // Barge-in cancels speech, not an already dispatched action. Its result
      // remains in the saved chat even when the Live socket has gone away.
    }
  }
  close() {
    this.closed = true;
    this.cancel([...this.controllers.keys()]);
  }
  async handle(call) {
    if (this.closed || !call.id) return;
    if (this.calls.has(call.id)) return this.calls.get(call.id);
    const controller = new AbortController();
    this.controllers.set(call.id, controller);
    const work = Promise.resolve().then(async () => {
      let response;
      try {
        if (Object.prototype.hasOwnProperty.call(this.local, call.name)) {
          response = await this.local[call.name](call.args || {}, controller.signal);
        } else {
          if (call.name !== 'hermes_action' || !call.args?.request?.trim()) throw new Error('Invalid action request');
          response = await this.execute(call.args.request, controller.signal);
        }
      } catch (e) { response = {error: String(e.message || e), run_id:e.voiceRunId}; }
      this.controllers.delete(call.id);
      if (!this.closed && !this.cancelled.has(call.id)) {
        this.send({toolResponse:{functionResponses:[{id:call.id,name:call.name,response}]}});
      }
    });
    this.calls.set(call.id, work);
    return work;
  }
}
/* Remember accepted actions until their spoken result finishes. Never rerun them. */
class VoiceResultQueue {
  constructor(storage) {
    this.storage=storage; this.sent=new Set();
    try { this.items=JSON.parse(storage?.getItem('zuzu-voice-results')||'[]'); }
    catch (_) { this.items=[]; }
    if(!Array.isArray(this.items))this.items=[];
  }
  save() { try { this.storage?.setItem('zuzu-voice-results',JSON.stringify(this.items)); } catch (_) {} }
  expect(id, chat) {
    if(!this.items.some(x=>x.id===id))this.items.push({id,chat});
    this.save();
  }
  complete(id, response) {
    const item=this.items.find(x=>x.id===id);
    if(item){item.response=response;this.save();}
  }
  recover(chat, runs) {
    for(const run of runs||[]){
      const item=this.items.find(x=>x.id===run.id&&this.matches(x,chat));
      if(item&&run.state!=='running')this.complete(run.id,run.state==='complete'
        ? {result:(run.answer||'').slice(0,12000)}
        : {error:run.detail||'Action interrupted; check before retrying.'});
    }
  }
  matches(item,chat) { return item.chat.project_id===chat?.project_id&&item.chat.chat_id===chat?.chat_id; }
  pending(chat) { return this.items.filter(x=>this.matches(x,chat)&&x.response&&!this.sent.has(x.id)); }
  markSent(id) { if(this.items.some(x=>x.id===id&&x.response))this.sent.add(id); }
  resetDelivery() { this.sent.clear(); }
  acknowledge(ids) { for(const id of ids)if(this.sent.has(id))this.forget(id); }
  forget(id) { this.items=this.items.filter(x=>x.id!==id);this.sent.delete(id);this.save(); }
}
if (typeof module !== 'undefined') module.exports = {HermesVoiceBridge,VoiceResultQueue};

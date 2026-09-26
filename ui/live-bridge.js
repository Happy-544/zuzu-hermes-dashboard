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
      this.controllers.get(id)?.abort();
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
      } catch (e) { response = {error: String(e.message || e)}; }
      this.controllers.delete(call.id);
      if (!this.closed && !this.cancelled.has(call.id)) {
        this.send({toolResponse:{functionResponses:[{id:call.id,name:call.name,response}]}});
      }
    });
    this.calls.set(call.id, work);
    return work;
  }
}
if (typeof module !== 'undefined') module.exports = {HermesVoiceBridge};

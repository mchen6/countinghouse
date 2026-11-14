// The control channel (packs in place, part 2, plan Task A2; docs/superpowers/
// specs/2026-11-14-packs-in-place-and-settings-tool-design.md section 1):
// ch-local start speaks to the runtime it spawned over an IPC fd, never over
// stdin or stdout (the client's MCP channel). Only in the single-identity
// profile (--controlChannel ipc, checked in framework.js). Module code never
// reaches it: modules run in workers, which have no process.send, and the
// handlers live only in this closure on the main thread.
//
// Requests: {id, type: 'load' | 'unload' | 'reload' | 'set', ...}, applied one
// at a time, in order. Replies: {id, ok: true, ...} or {id, ok: false, code,
// message}. The codes are internal to start and the runtime (CONTROL_*), never
// a client's.
const TYPES = ['load', 'unload', 'reload', 'set', 'notice'];

// handlers: {load, unload, reload, set}, each (msg) -> Promise of a reply's
// fields; a missing one answers CONTROL_NOT_READY. send: process.send's
// stand-in (a test's). -> {stop()}.
function start(handlers = {}, {on = (fn) => process.on('message', fn), off = (fn) => process.off('message', fn), send = (m) => process.send(m)} = {}) {
  let chain = Promise.resolve();
  const reply = (m) => { try { send(m); } catch (e) { /* start has gone: nothing to answer */ } };
  const listener = (msg) => {
    const id = (msg != null && (typeof(msg.id) === 'number' || typeof(msg.id) === 'string')) ? msg.id : null;
    if (id == null) return;
    chain = chain.then(async () => {
      if (!TYPES.includes(msg.type)) return reply({id, ok: false, code: 'CONTROL_UNKNOWN', message: `unknown request type ${JSON.stringify(String(msg.type)).slice(0, 40)}`});
      const handler = handlers[msg.type];
      if (typeof(handler) !== 'function') return reply({id, ok: false, code: 'CONTROL_NOT_READY', message: `${msg.type} is not served yet`});
      try {
        const fields = await handler(msg);
        return reply(Object.assign({}, fields, {id, ok: true}));
      } catch (e) {
        return reply({id, ok: false, code: (e != null && typeof(e.code) === 'string') ? e.code : 'CONTROL_FAILED', message: String((e != null && e.message) || e).slice(0, 300)});
      }
    });
  };
  on(listener);
  return {stop: () => off(listener)};
}

module.exports = {start, TYPES};

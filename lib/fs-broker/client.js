// Module worker's end of the file bridge (docs/superpowers/specs/2026-10-17-
// module-sandbox-fs-broker-design.md, section 2). Sync calls post on the sync
// port and wait on a shared counter; async calls use the async port. Loaded
// by lib/sandbox.js before anything else, so it holds the only references to
// receiveMessageOnPort and the ports.
const {receiveMessageOnPort} = require('worker_threads');

function toError(e) {
  const err = new Error(e.message);
  ['code', 'errno', 'syscall', 'path', 'dest'].forEach((k) => { if (e[k] !== undefined) err[k] = e[k]; });
  return err;
}

function eio(op) {
  const err = new Error(`EIO: i/o error, ${op} (the file broker did not answer)`);
  err.code = 'EIO';
  err.errno = -5;
  err.syscall = op;
  return err;
}

function createClient(t, settings) {
  const backstopMs = (settings && settings.backstopMs) || 35000;
  const counter = new Int32Array(t.flag);
  const pending = new Map();
  let seq = 0;

  t.asyncPort.on('message', (m) => {
    const w = pending.get(m.id);
    if (w == null) return;
    pending.delete(m.id);
    if (pending.size === 0) t.asyncPort.unref();
    if (m.ok) w.resolve(m.result); else w.reject(toError(m.error));
  });
  t.asyncPort.unref();

  function sync(op, args) {
    const id = ++seq;
    t.syncPort.postMessage({id, op, args});
    const deadline = Date.now() + backstopMs;
    for (;;) {
      // Read the counter before draining: a reply that lands after the drain
      // bumps it, so the wait below returns at once instead of sleeping.
      const seen = Atomics.load(counter, 0);
      let msg;
      while ((msg = receiveMessageOnPort(t.syncPort)) !== undefined) {
        const m = msg.message;
        if (m.id !== id) continue;   // a reply to a call that already timed out
        if (m.ok) return m.result;
        throw toError(m.error);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw eio(op);
      Atomics.wait(counter, 0, seen, left);
    }
  }

  function async(op, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, {resolve, reject});
      t.asyncPort.ref();
      t.asyncPort.postMessage({id, op, args});
    });
  }

  return {sync, async};
}

module.exports = {createClient};

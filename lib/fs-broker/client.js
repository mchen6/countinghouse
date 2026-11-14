// Module worker's end of the file bridge (docs/superpowers/specs/2026-10-17-
// module-sandbox-fs-broker-design.md, section 2). Sync calls post on the sync
// port and wait on a shared counter; async calls use the async port. Loaded
// by lib/sandbox.js before anything else, so it holds the only references to
// receiveMessageOnPort and the ports.
const {receiveMessageOnPort} = require('worker_threads');
// Every call crosses as an envelope of bounded bytes (#170).
const envelope = require('../message-envelope');

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

// A call over the bridge's cap: refused here, before anything is posted.
function tooLarge(op) {
  const err = new Error(`EINVAL: invalid argument, ${op} (the call's arguments are over the file bridge's ${envelope.BRIDGE_CAP} bytes)`);
  err.code = 'EINVAL';
  err.errno = -22;
  err.syscall = op;
  return err;
}

// {id, op, args} as an envelope, or throws EINVAL over the cap.
function wrapCall(id, op, args) {
  try {
    return envelope.wrap({id, op, args}, envelope.BRIDGE_CAP);
  } catch (e) {
    if (e != null && e.code === 'MESSAGE_TOO_LARGE') throw tooLarge(op);
    throw e;
  }
}

function createClient(t, settings) {
  // deaf to a patched MessagePort.prototype, like the worker's own port (#170)
  envelope.pinPort(t.syncPort);
  envelope.pinPort(t.asyncPort);
  const backstopMs = (settings && settings.backstopMs) || 35000;
  const counter = new Int32Array(t.flag);
  const pending = new Map();
  let seq = 0;

  t.asyncPort.on('message', (m) => {
    // id null: the server could not read a call (#170); it cannot say which,
    // so every call waiting fails with its answer
    const ids = (m.id === null) ? [...pending.keys()] : [m.id];
    for (const id of ids) {
      const w = pending.get(id);
      if (w == null) continue;
      pending.delete(id);
      if (m.ok) w.resolve(m.result); else w.reject(toError(m.error));
    }
    if (pending.size === 0) t.asyncPort.unref();
  });
  t.asyncPort.unref();

  function sync(op, args) {
    const id = ++seq;
    const w = wrapCall(id, op, args);
    t.syncPort.postMessage(w.envelope, w.transfer);
    const deadline = Date.now() + backstopMs;
    for (;;) {
      // Read the counter before draining: a reply that lands after the drain
      // bumps it, so the wait below returns at once instead of sleeping.
      const seen = Atomics.load(counter, 0);
      let msg;
      while ((msg = receiveMessageOnPort(t.syncPort)) !== undefined) {
        const m = msg.message;
        // a reply to a call that already timed out; id null answers the one in flight
        if (m.id !== id && m.id !== null) continue;
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
      let w;
      try { w = wrapCall(id, op, args); } catch (e) { return reject(e); }
      pending.set(id, {resolve, reject});
      t.asyncPort.ref();
      t.asyncPort.postMessage(w.envelope, w.transfer);
    });
  }

  return {sync, async};
}

module.exports = {createClient};

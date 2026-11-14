// Main thread's end of one worker's file bridge (docs/superpowers/specs/
// 2026-10-17-module-sandbox-fs-broker-design.md, sections 2 and 3). Every
// request becomes broker.handle(); every outcome goes back on the port it
// came from, and a sync reply also bumps the shared counter the worker waits
// on. A request past its deadline is answered ETIMEDOUT but keeps its
// scheduler slot until the host operation returns; maxStuck such requests
// put the worker on EIO until one returns (review F1).
const {MessageChannel} = require('worker_threads');
const {nodeError} = require('./errors');
// Every call arrives as an envelope of bounded bytes (#170).
const envelope = require('../message-envelope');

function errorOut(e) {
  const o = {message: String(e && e.message)};
  ['code', 'errno', 'syscall', 'path', 'dest'].forEach((k) => { if (e != null && e[k] !== undefined) o[k] = e[k]; });
  return o;
}

function createBridge(opts) {
  const broker = opts.broker;
  const scheduler = opts.scheduler;
  const key = opts.key;
  const deadlineMs = opts.deadlineMs || 30000;
  const maxStuck = opts.maxStuck || 2;
  const syncCh = new MessageChannel();
  const asyncCh = new MessageChannel();
  const flag = new SharedArrayBuffer(4);
  const counter = new Int32Array(flag);
  let stuck = 0;
  let inFlight = 0;
  let closed = false;

  function exec(op, args) {
    if (stuck >= maxStuck) return Promise.reject(nodeError('EIO', op));
    const work = broker.handle(op, args);
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        stuck++;
        work.then(() => {}, () => {}).then(() => { stuck--; });
        reject(nodeError('ETIMEDOUT', op));
      }, deadlineMs);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  function reply(port, id, ok, value, isSync) {
    if (closed) return;
    try {
      port.postMessage(ok ? {id, ok: true, result: value} : {id, ok: false, error: errorOut(value)});
    } catch (e) {
      port.postMessage({id, ok: false, error: errorOut(e)});
    }
    if (isSync) {
      Atomics.add(counter, 0, 1);
      Atomics.notify(counter, 0);
    }
  }

  // An envelope over the cap, malformed, or not one is a tampered worker's
  // (the client refuses an honest call over the cap itself): reported, not
  // served, and answered EINVAL with id null, which fails the call in flight
  // at once instead of at the backstop.
  const open = (port, raw, sync) => {
    const r = envelope.unwrap(raw, envelope.BRIDGE_CAP);
    if (r.violation == null) return r.message;
    if (typeof(broker.report) === 'function') broker.report('message', r.violation);
    reply(port, null, false, nodeError('EINVAL', 'bridge'), sync);
    return null;
  };

  syncCh.port1.on('message', (raw) => {
    const m = open(syncCh.port1, raw, true);
    if (m == null) return;
    // A worker waiting on a sync call cannot send another; a second one in
    // flight is not a real wait, and must not extend the heartbeat exemption.
    if (inFlight > 0) return reply(syncCh.port1, m.id, false, nodeError('EIO', m.op), true);
    inFlight++;
    exec(m.op, m.args)
      .then((r) => reply(syncCh.port1, m.id, true, r, true), (e) => reply(syncCh.port1, m.id, false, e, true))
      .finally(() => { inFlight--; });
  });
  asyncCh.port1.on('message', (raw) => {
    const m = open(asyncCh.port1, raw, false);
    if (m == null) return;
    exec(m.op, m.args).then((r) => reply(asyncCh.port1, m.id, true, r, false), (e) => reply(asyncCh.port1, m.id, false, e, false));
  });

  return {
    transfer: {syncPort: syncCh.port2, asyncPort: asyncCh.port2, flag: flag},
    transferList: [syncCh.port2, asyncCh.port2],
    syncInFlight: () => inFlight,
    stuck: () => stuck,
    async close() {
      if (closed) return;
      closed = true;
      syncCh.port1.close();
      asyncCh.port1.close();
      scheduler.forget(key);
      await broker.closeAll();
    }
  };
}

module.exports = {createBridge};

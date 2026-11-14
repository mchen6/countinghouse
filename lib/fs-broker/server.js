// Main thread's end of one worker's file bridge (docs/superpowers/specs/
// 2026-10-17-module-sandbox-fs-broker-design.md, sections 2 and 3). Every
// request becomes broker.handle(); every outcome goes back on the port it
// came from, and a sync reply also bumps the shared counter the worker waits
// on. A request past its deadline is answered ETIMEDOUT but keeps its
// scheduler slot until the host operation returns; maxStuck such requests
// put the worker on EIO until one returns (review F1).
const {MessageChannel} = require('worker_threads');
const {nodeError} = require('./errors');

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

  // The requests in flight and their deadlines, checked by one sweep while
  // any is pending (performance proposal 4: a timer, a timeout promise and a
  // race per request were most of the bridge's own allocations). A request
  // past its deadline is answered ETIMEDOUT, at most a quarter of the
  // deadline (1 s at most) late, and keeps its scheduler slot until the host
  // operation returns, as before.
  const pending = new Set();
  const sweepEveryMs = Math.max(10, Math.min(1000, Math.floor(deadlineMs / 4)));
  let sweeper = null;
  function sweep() {
    const now = Date.now();
    for (const p of pending) {
      if (now < p.deadline) continue;
      pending.delete(p);
      stuck++;
      p.work.then(() => {}, () => {}).then(() => { stuck--; });
      p.reject(nodeError('ETIMEDOUT', p.op));
    }
    if (pending.size === 0 && sweeper != null) { clearInterval(sweeper); sweeper = null; }
  }

  function exec(op, args) {
    if (stuck >= maxStuck) return Promise.reject(nodeError('EIO', op));
    const work = broker.handle(op, args);
    return new Promise((resolve, reject) => {
      const p = {deadline: Date.now() + deadlineMs, work, op, reject};
      pending.add(p);
      if (sweeper == null) sweeper = setInterval(sweep, sweepEveryMs);
      work.then((r) => { if (pending.delete(p)) resolve(r); }, (e) => { if (pending.delete(p)) reject(e); });
    });
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

  syncCh.port1.on('message', (m) => {
    // A worker waiting on a sync call cannot send another; a second one in
    // flight is not a real wait, and must not extend the heartbeat exemption.
    if (inFlight > 0) return reply(syncCh.port1, m.id, false, nodeError('EIO', m.op), true);
    inFlight++;
    exec(m.op, m.args)
      .then((r) => reply(syncCh.port1, m.id, true, r, true), (e) => reply(syncCh.port1, m.id, false, e, true))
      .finally(() => { inFlight--; });
  });
  asyncCh.port1.on('message', (m) => {
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
      if (sweeper != null) { clearInterval(sweeper); sweeper = null; }
      syncCh.port1.close();
      asyncCh.port1.close();
      scheduler.forget(key);
      await broker.closeAll();
    }
  };
}

module.exports = {createBridge};

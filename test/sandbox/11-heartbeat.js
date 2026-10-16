// lib/worker-limits.js's heartbeat, against a fake worker: it must kill a
// worker that stops answering, and must not kill one that answers, however
// small maxBlockMs is or however long the main thread itself stalls.
const assert = require('assert');
const workerLimits = require('../../lib/worker-limits');

function fakeWorker(answer) {
  const w = {killed: false, onExit: null};
  w.terminate = () => { w.killed = true; };
  w.getHeapStatistics = () => Promise.resolve({external_memory: 0});
  w.once = (ev, fn) => { if (ev === 'exit') w.onExit = fn; };
  const wm = {killReason: null, sendSandboxPingMessage: (cb) => { if (answer()) setImmediate(cb); }};
  return {w, wm};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMITS = {externalMb: 64};

describe('sandbox 11: heartbeat', function() {
  this.timeout(10000);
  let stop = null;
  afterEach(() => { if (stop) stop(); stop = null; });

  it('leaves an idle worker alone when maxBlockMs is below a second', async () => {
    const {w, wm} = fakeWorker(() => true);
    stop = workerLimits.watch(w, wm, Object.assign({maxBlockMs: 300}, LIMITS));
    await sleep(2500);
    assert.strictEqual(w.killed, false, `killed: ${wm.killReason}`);
  });

  it('kills a worker that stops answering, within about maxBlockMs', async () => {
    let answering = true;
    const {w, wm} = fakeWorker(() => answering);
    stop = workerLimits.watch(w, wm, Object.assign({maxBlockMs: 400}, LIMITS));
    await sleep(500);
    answering = false;
    const t0 = Date.now();
    while (!w.killed && Date.now() - t0 < 3000) await sleep(20);
    assert.strictEqual(wm.killReason, 'blocked event loop');
    assert.ok(Date.now() - t0 < 1200, `took ${Date.now() - t0} ms`);
  });

  it('does not blame the worker when the main thread itself stalled', async () => {
    const {w, wm} = fakeWorker(() => true);
    stop = workerLimits.watch(w, wm, Object.assign({maxBlockMs: 300}, LIMITS));
    await sleep(400);
    const until = Date.now() + 1500;
    while (Date.now() < until) { /* stall the main thread */ }
    await sleep(800);
    assert.strictEqual(w.killed, false, `killed: ${wm.killReason}`);
  });
});

// Lean worker step 3, Task 5: the CHUtil a lean worker's module sees
// (lib/chutil-facade.js). A fresh facade has loaded no implementation; it
// has no dm or ci; countinghouse-util, however it is first loaded, is wired
// once by the worker's hook. Run in a worker thread, as a lean worker runs
// it (countinghouse-util opens a Redis client at require on the main thread).
// Server-free.
const assert = require('assert');
const path = require('path');
const {Worker} = require('worker_threads');

const LIB = path.join(__dirname, '..', '..', 'lib');

// Runs `body` (the source of an async function of (facadeLib, LIB)) in a
// worker thread; resolves what it returns.
function inWorker(body) {
  const code = `
    const {parentPort, workerData} = require('worker_threads');
    const path = require('path');
    require(path.join(workerData.LIB, 'cli-options')).setOptions({workerThread: false});
    const facadeLib = require(path.join(workerData.LIB, 'chutil-facade'));
    (${body})(facadeLib, workerData.LIB).then((r) => parentPort.postMessage({r}), (e) => parentPort.postMessage({e: String(e && e.stack)}));
  `;
  return new Promise((resolve, reject) => {
    const w = new Worker(code, {eval: true, workerData: {LIB}});
    w.once('message', (m) => { w.terminate(); return (m.e != null) ? reject(new Error(m.e)) : resolve(m.r); });
    w.once('error', reject);
  });
}

describe('module-loading 26: the CHUtil facade (lean worker step 3)', function() {
  this.timeout(30000);

  it('a fresh facade has loaded no implementation, and has no dm or ci', async () => {
    const r = await inWorker(`async (facadeLib) => {
      const CHUtil = facadeLib.createFacade();
      const loaded = Object.keys(require.cache).map((k) => path.basename(k));
      return {util: loaded.includes('countinghouse-util.js'), request: Object.keys(require.cache).some((k) => k.includes('postman-request')),
        logger: loaded.includes('logger.js'), keys: Object.keys(CHUtil).sort(), dm: 'dm' in CHUtil, ci: 'ci' in CHUtil,
        internal: '__deviceLogWithID' in CHUtil};
    }`);
    assert.strictEqual(r.util, false, 'countinghouse-util loaded');
    assert.strictEqual(r.request, false, 'postman-request loaded');
    assert.strictEqual(r.logger, false, 'the logger loaded');
    assert.strictEqual(r.dm, false);
    assert.strictEqual(r.ci, false);
    assert.strictEqual(r.internal, false);
    assert.ok(r.keys.includes('request') && r.keys.includes('createServiceClient') && r.keys.includes('redis'), r.keys.join(','));
  });

  it('the first helper call loads the implementation, wired once by the worker\'s hook, whatever loads it first', async () => {
    const r = await inWorker(`async (facadeLib, LIB) => {
      let wired = 0;
      let seen = null;
      facadeLib.setWiring((impl) => { wired += 1; seen = impl; impl.redis = 'the-bridge'; });
      const CHUtil = facadeLib.createFacade();
      function A() {}
      function B() {}
      CHUtil.inherits(A, B);
      const impl = require(path.join(LIB, 'countinghouse-util'));
      return {wired, same: seen === impl, inherited: Object.getPrototypeOf(A.prototype) === B.prototype, redis: CHUtil.redis,
        notImpl: CHUtil !== impl};
    }`);
    assert.strictEqual(r.wired, 1);
    assert.strictEqual(r.same, true);
    assert.strictEqual(r.inherited, true);
    assert.strictEqual(r.redis, 'the-bridge', 'redis is read from the wired implementation');
    assert.strictEqual(r.notImpl, true);
  });

  it('a path other than the facade (handler-ctx, the peer side) loading it first gets it wired too', async () => {
    const r = await inWorker(`async (facadeLib, LIB) => {
      let wired = 0;
      facadeLib.setWiring((impl) => { wired += 1; impl.ci = {marker: true}; });
      const impl = require(path.join(LIB, 'countinghouse-util'));
      return {wired, ci: impl.ci != null && impl.ci.marker === true};
    }`);
    assert.strictEqual(r.wired, 1);
    assert.strictEqual(r.ci, true);
  });
});

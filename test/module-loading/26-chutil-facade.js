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

  it('a fresh facade has loaded no implementation, has no dm or ci, and its file exports no way to wire it', async () => {
    const r = await inWorker(`async (facadeLib) => {
      const CHUtil = facadeLib.createFacade(() => ({dm: null, ci: null, redis: null}));
      const loaded = Object.keys(require.cache).map((k) => path.basename(k));
      return {util: loaded.includes('countinghouse-util.js'), request: Object.keys(require.cache).some((k) => k.includes('postman-request')),
        logger: loaded.includes('logger.js'), keys: Object.keys(CHUtil).sort(), dm: 'dm' in CHUtil, ci: 'ci' in CHUtil,
        internal: '__deviceLogWithID' in CHUtil, exported: Object.keys(facadeLib).sort()};
    }`);
    assert.strictEqual(r.util, false, 'countinghouse-util loaded');
    assert.strictEqual(r.request, false, 'postman-request loaded');
    assert.strictEqual(r.logger, false, 'the logger loaded');
    assert.strictEqual(r.dm, false);
    assert.strictEqual(r.ci, false);
    assert.strictEqual(r.internal, false);
    assert.ok(r.keys.includes('request') && r.keys.includes('createServiceClient') && r.keys.includes('redis'), r.keys.join(','));
    assert.deepStrictEqual(r.exported, ['METHODS', 'createFacade', 'runtime']);
  });

  it('the first helper call attaches the implementation once; in a worker its dm and ci read as undefined and it cannot be attached again', async () => {
    const r = await inWorker(`async (facadeLib, LIB) => {
      let wired = 0;
      const dm = {workerMessage: null};
      const CHUtil = facadeLib.createFacade(() => { wired += 1; return {dm: dm, ci: {marker: true}, redis: 'the-bridge'}; });
      function A() {}
      function B() {}
      CHUtil.inherits(A, B);
      const impl = require(path.join(LIB, 'countinghouse-util'));
      facadeLib.runtime();
      let again = null;
      try { impl.__attach({dm: {}, ci: {}}); } catch (e) { again = e.message; }
      impl.dm = {forged: true};
      let second = null;
      try { facadeLib.createFacade(() => ({})); } catch (e) { second = e.message; }
      return {wired, inherited: Object.getPrototypeOf(A.prototype) === B.prototype, redis: CHUtil.redis,
        dm: impl.dm === undefined, ci: impl.ci === undefined, again, second};
    }`);
    assert.strictEqual(r.wired, 1);
    assert.strictEqual(r.inherited, true);
    assert.strictEqual(r.redis, 'the-bridge', 'redis is read from the attached implementation');
    assert.strictEqual(r.dm, true, 'dm is readable (or settable) in a worker');
    assert.strictEqual(r.ci, true, 'ci is readable in a worker');
    assert.match(String(r.again), /already attached/);
    assert.match(String(r.second), /one CHUtil/);
  });

  it('the implementation\'s own requests (CHUtil.invokeAction) go through the facade\'s request as the lockdown wraps it', async () => {
    const r = await inWorker(`async (facadeLib, LIB) => {
      const CHUtil = facadeLib.createFacade(() => ({dm: null, ci: null, redis: null}));
      const seen = [];
      // what the lockdown does at set-options: a wrapper locked in place
      Object.defineProperty(CHUtil, 'request', {value: (opts, cb) => { seen.push(opts.url); cb(Object.assign(new Error('denied'), {code: 'ERR_ACCESS_DENIED'})); },
        writable: false, configurable: false, enumerable: false});
      const err = await new Promise((resolve) => CHUtil.invokeAction('k', 'http://127.0.0.1:9', 'urn:x:serviceID:s', 'a', {input: {}}, (e) => resolve(e)));
      const impl = require(path.join(LIB, 'countinghouse-util'));
      const direct = await new Promise((resolve) => impl.request({url: 'http://127.0.0.1:9/direct'}, (e) => resolve(e)));
      return {seen, code: err && err.code, direct: direct && direct.code};
    }`);
    assert.deepStrictEqual(r.seen, ['http://127.0.0.1:9/invoke-action', 'http://127.0.0.1:9/direct']);
    assert.strictEqual(r.code, 'ERR_ACCESS_DENIED');
    assert.strictEqual(r.direct, 'ERR_ACCESS_DENIED');
  });

  it('a service client from CHUtil.createServiceClient holds no reference to the runtime', async () => {
    const r = await inWorker(`async (facadeLib, LIB) => {
      const CHUtil = facadeLib.createFacade(() => ({dm: null, ci: null, redis: null}));
      const impl = facadeLib.runtime();
      impl.createServiceClient = (opts, cb) => cb(null, {deviceID: 'd', serviceID: 's', cdifInterface: {deviceManager: {}}, invoke: (o, c) => c(null, 'invoked'), subscribe: () => {}});
      const client = await new Promise((resolve) => CHUtil.createServiceClient({deviceID: 'd', serviceID: 's'}, (e, c) => resolve(c)));
      const out = await new Promise((resolve) => client.invoke({actionName: 'a'}, (e, d) => resolve(d)));
      return {keys: Object.keys(client).sort(), out, frozen: Object.isFrozen(client)};
    }`);
    assert.deepStrictEqual(r.keys, ['deviceID', 'invoke', 'serviceID', 'subscribe']);
    assert.strictEqual(r.out, 'invoked');
    assert.strictEqual(r.frozen, true);
  });
});

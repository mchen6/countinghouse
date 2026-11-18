// Lean worker step 3 (the reviewer, on #184's loadFile finding): the lean
// worker requires a module's handler files through the file broker's /app
// specifier (lib/lean-dispatcher.js), with the lockdown in force, under
// --moduleSandbox enforce. A handler that requires a built-in the lockdown
// refuses, or a file outside its module, is refused, whether it does so
// when called or while its file is required at the load.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, post} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {deviceIDForName} = require('../../lib/call-address');

const PORT = testPort(9751);
const KEY = 'sandbox-46-key';
const PROBE = 'lean-lockdown-probe';
const SERVICE = 'urn:countinghouse-test:serviceID:probeService';
const TAG = /\(countinghouse module sandbox\)/;

describe('sandbox 48: a lean worker\'s handlers are under the lockdown (enforce)', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  before(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-lean-46-'));
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', 'enforce',
      '--moduleDataPath', path.join(base, 'store')]);
    const loaded = await post(PORT, KEY, '/load-module', {path: path.join(ROOT, 'test', 'fixtures', PROBE), name: PROBE});
    assert.strictEqual(loaded.status, 200, JSON.stringify(loaded.body));
    const attach = await post(PORT, KEY, '/load-module', {path: path.join(ROOT, 'test', 'fixtures', 'lean-attach-probe'), name: 'lean-attach-probe'});
    assert.strictEqual(attach.status, 200, JSON.stringify(attach.body));
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  const call = async (actionName, input) => {
    const r = await post(PORT, KEY, `/devices/${deviceIDForName(PROBE)}/invoke-action`, {serviceID: SERVICE, actionName, input});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.output;
  };

  it('a built-in the lockdown refuses, required by a handler when called: refused', async () => {
    const out = await call('builtin', {});
    assert.strictEqual(out.outcome, 'error', JSON.stringify(out));
    assert.strictEqual(out.code, 'MODULE_NOT_FOUND', JSON.stringify(out));
    assert.match(out.message, TAG);
  });

  // Refused by whichever layer meets it first: the file broker, which under
  // enforce shows the module nothing outside its grant (Node's own "Cannot
  // find module"), or the lockdown's require boundary (tagged). Under audit
  // the same require loads the file.
  it('a file outside the module, required by a handler when called: refused', async () => {
    const outside = path.join(ROOT, 'lib', 'call-address.js');
    const out = await call('outside', {path: outside});
    assert.strictEqual(out.outcome, 'error', JSON.stringify(out));
    assert.strictEqual(out.code, 'MODULE_NOT_FOUND', JSON.stringify(out));
    assert.ok(TAG.test(out.message) || out.message.startsWith(`Cannot find module '${outside}'`), JSON.stringify(out));
  });

  // The high review of #177: the implementation's own requests go through
  // the module's CHUtil.request as the lockdown wrapped it.
  it('CHUtil.invokeAction to a host with no grant: refused ERR_ACCESS_DENIED, and recorded', async () => {
    const mark = server.output.length;
    const out = await call('invokeaction', {url: 'http://127.0.0.1:9'});
    assert.strictEqual(out.outcome, 'error', JSON.stringify(out));
    assert.strictEqual(out.code, 'ERR_ACCESS_DENIED', JSON.stringify(out));
    assert.match(server.output.slice(mark), /lean-lockdown-probe violation net 127\.0\.0\.1:9/);
  });

  it('CHUtil.recordUsage, its implementation loaded on first use under the lockdown: answers', async () => {
    const out = await call('recordusage', {});
    assert.deepStrictEqual(out, {outcome: 'ok', tool: 'tool'});
  });

  // #177's re-review, item 2, as PR-c leaves it: the facade attaches
  // countinghouse-util at the worker's boot, before any module code, so
  // module code that reaches it through chutil-facade's module object
  // (require.cache: spec section 3's residual) can no longer attach it
  // itself; a request through it goes the runtime's own checked route, and
  // the lockdown refuses it. (That an attach with no route refuses every
  // request is the server-free case below.)
  it('countinghouse-util is out of module code\'s reach: no module object of the runtime\'s in require.cache to attach it through (#194\'s PR 2)', async () => {
    const mark = server.output.length;
    const r = await post(PORT, KEY, `/devices/${deviceIDForName('lean-attach-probe')}/invoke-action`,
      {serviceID: 'urn:countinghouse-test:serviceID:attachService', actionName: 'attach', input: {url: 'http://127.0.0.1:9'}});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const out = r.body.output;
    // (since #194's PR 2 the route itself is gone: the runtime's entries are
    // out of require.cache, so module code never reaches the facade's
    // module object to attach countinghouse-util through)
    assert.strictEqual(out.facadeInCache, false, JSON.stringify(out));
  });

  it('a handler file that requires a refused built-in while it loads: the load fails, naming the file', async () => {
    const r = await post(PORT, KEY, '/load-module', {path: path.join(ROOT, 'test', 'fixtures', 'lean-lockdown-load'), name: 'lean-lockdown-load'});
    assert.notStrictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'LOAD_MODULE_FAIL', JSON.stringify(r.body));
    assert.match(r.body.message, /handlers\/loadService\/ping\.js/);
    assert.match(r.body.message, /worker_threads/);
  });
});

// The guarantee module code meets if it attaches countinghouse-util before
// any facade has (a worker with no facade, as no lean worker is since PR-c):
// it gets nothing back, and with no route a request is refused, never sent
// unchecked (#177's re-review, item 2). Server-free: a worker thread of its own.
describe('sandbox 48: countinghouse-util attached with no route, in a worker', function() {
  this.timeout(30000);
  it('an attach with outbound null hands back nothing, and every request is refused ERR_ACCESS_DENIED, no checked route', async () => {
    const {Worker} = require('worker_threads');
    const code = `
      const {parentPort, workerData} = require('worker_threads');
      const path = require('path');
      require(path.join(workerData.LIB, 'cli-options')).setOptions({workerThread: false});
      const util = require(path.join(workerData.LIB, 'countinghouse-util'));
      const handed = util.__attach({dm: null, ci: null, redis: null, outbound: null});
      let again = null;
      try { util.__attach({dm: null, ci: null, redis: null, outbound: () => {}}); } catch (e) { again = e.message; }
      util.request({url: 'http://127.0.0.1:9', timeout: 1000}, (err) => parentPort.postMessage({handed: typeof(handed), again,
        code: err != null ? err.code : null, message: err != null ? err.message : null}));
    `;
    const got = await new Promise((resolve, reject) => {
      const w = new Worker(code, {eval: true, workerData: {LIB: path.join(ROOT, 'lib')}});
      w.once('message', (m) => { w.terminate(); resolve(m); });
      w.once('error', reject);
    });
    assert.deepStrictEqual([got.handed, got.code], ['undefined', 'ERR_ACCESS_DENIED'], JSON.stringify(got));
    assert.match(got.message, /no checked route/);
    assert.match(String(got.again), /already attached/, 'a second attach, with a route, is refused');
  });
});

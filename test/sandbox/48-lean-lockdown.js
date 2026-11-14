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

  it('a handler file that requires a refused built-in while it loads: the load fails, naming the file', async () => {
    const r = await post(PORT, KEY, '/load-module', {path: path.join(ROOT, 'test', 'fixtures', 'lean-lockdown-load'), name: 'lean-lockdown-load'});
    assert.notStrictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'LOAD_MODULE_FAIL', JSON.stringify(r.body));
    assert.match(r.body.message, /handlers\/loadService\/ping\.js/);
    assert.match(r.body.message, /worker_threads/);
  });
});

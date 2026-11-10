// A device a worker announces after its unload has begun is not registered:
// the worker is going, and the announcement must not undo what the unload
// recorded. It used to put the device back in the device map and clear its
// ended entry, so once the unload purged it the device answered
// DEVICE_NOT_FOUND, as if it had never been hosted, instead of
// MODULE_UNLOADED.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, post, waitFor} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');

const PORT   = 9640;
const KEY    = 'online-while-unloading-key';
const DEVICE = deviceIDForName('stray-output-module');
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));
const call   = () => post(PORT, KEY, `/devices/${DEVICE}/invoke-action`,
  {serviceID: 'urn:countinghouse-test:serviceID:svc', actionName: 'returnsCleanly', input: {v: 'x'}});
const codeOf = (r) => (r.status === 200 ? 200 : (r.body != null ? r.body.code : undefined));

describe('sandbox 30: a device announced while its worker is being unloaded', function() {
  this.timeout(60000);
  let server = null;
  let base = null;
  before(async () => {
    // Sandbox off: nothing ends the worker for blocking a moment.
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', 'off']);
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('is not registered: after the unload the device answers MODULE_UNLOADED', async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-online-while-unloading-'));
    const dir = path.join(base, 'stray-output-module');
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'stray-output-module'), dir, {recursive: true});
    // Online at once; then, once the marker exists, the worker is busy for
    // 2 s and announces the device again -- before it reads the unload
    // message that arrived meanwhile.
    const index = path.join(dir, 'index.js');
    fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace("this.emit('deviceonline', new Device(), this);",
      "this.emit('deviceonline', new Device(), this);\n" +
      "  const again = setInterval(() => {\n" +
      "    if (!require('fs').existsSync(`${__dirname}/announce-again`)) return;\n" +
      "    clearInterval(again);\n" +
      "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);\n" +
      "    this.emit('deviceonline', new Device(), this);\n" +
      "  }, 50);"));
    await post(PORT, KEY, '/load-module', {path: dir, name: 'stray-output-module'});
    await waitFor(async () => (await call()).status === 200, 20000, 'the module to answer');

    fs.writeFileSync(path.join(dir, 'announce-again'), '');
    await sleep(500);   // the worker is blocked now
    const unloaded = await post(PORT, KEY, '/unload-module', {name: 'stray-output-module'});
    assert.strictEqual(unloaded.status, 200, JSON.stringify(unloaded.body));
    // The unload answers once the worker is purged and terminated.
    const r = await call();
    assert.strictEqual(codeOf(r), 'MODULE_UNLOADED', JSON.stringify(r.body));
  });
});

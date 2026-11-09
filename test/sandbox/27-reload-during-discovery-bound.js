// A reload that reaches a worker still blocked in discovery ends that worker
// as a reload: its devices are MODULE_RELOADING until the new worker's come
// online, and the old worker's discovery bound, falling inside the unload's
// 3 s acknowledgement window, does not fire. It used to settle the reload's
// devices to MODULE_UNLOADED and unload the module a second time, so what
// was in flight or arrived in that window failed as unloaded (and a job, not
// retried on MODULE_UNLOADED, failed for good).
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, post, waitFor} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');

const PORT   = 9637;
const KEY    = 'reload-in-bound-key';
const DEVICE = deviceIDForName('stray-output-module');
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));
const call   = () => post(PORT, KEY, `/devices/${DEVICE}/invoke-action`,
  {serviceID: 'urn:countinghouse-test:serviceID:svc', actionName: 'returnsCleanly', input: {v: 'x'}});
const codeOf = (r) => (r.status === 200 ? 200 : (r.body != null ? r.body.code : undefined));

describe('sandbox 27: a reload inside the old worker\'s discovery bound', function() {
  this.timeout(90000);
  let server = null;
  let base = null;
  before(async () => {
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', 'off']);
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('is a reload throughout: MODULE_RELOADING, never MODULE_UNLOADED, and the bound does not fire', async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-reload-in-bound-'));
    const dir = path.join(base, 'stray-output-module');
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'stray-output-module'), dir, {recursive: true});
    const index = path.join(dir, 'index.js');
    const original = fs.readFileSync(index, 'utf8');
    // The device comes online, then the worker blocks before its own 5 s
    // discovery answer, so the 15 s bound is what would end it.
    fs.writeFileSync(index, original.replace("this.emit('deviceonline', new Device(), this);",
      "this.emit('deviceonline', new Device(), this);\n  setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40000), 4000);"));
    await post(PORT, KEY, '/load-module', {path: dir, name: 'stray-output-module'});
    await waitFor(async () => (await call()).status === 200, 3000, 'the device to answer before the worker blocks');
    const answered = Date.now();
    fs.writeFileSync(index, original);

    // Into the unload's 3 s window just before the bound (15 s from the start
    // of discovery, which is a little before the first answer).
    await sleep(Math.max(0, answered + 12500 - Date.now()));
    const mark = server.output.length;
    const seen = [];
    const inFlight = [];
    let done = false;
    const reload = post(PORT, KEY, '/load-module', {path: dir, name: 'stray-output-module'}).then((r) => { done = true; return r; });
    let back = false;
    const deadline = Date.now() + 40000;
    while (!back && Date.now() < deadline) {
      inFlight.push(call().then((r) => { seen.push(codeOf(r)); if (done && r.status === 200) back = true; }));
      await sleep(200);
    }
    await Promise.all(inFlight);
    const reloaded = await reload;
    const log = server.output.slice(mark);
    const notes = `\n${log.split('\n').filter((l) => /discovery did not finish|unloaded due to reason/.test(l)).join('\n')}`;
    assert.strictEqual(reloaded.status, 200, JSON.stringify(reloaded.body));
    assert.ok(back, `never answered after the reload: ${JSON.stringify(seen)}`);
    assert.ok(seen.includes('MODULE_RELOADING'), `the window was not seen: ${JSON.stringify(seen)}${notes}`);
    assert.ok(!seen.includes('MODULE_UNLOADED'), `MODULE_UNLOADED during the reload: ${JSON.stringify(seen)}${notes}`);
    assert.ok(!seen.includes('DEVICE_NOT_FOUND'), `DEVICE_NOT_FOUND during the reload: ${JSON.stringify(seen)}${notes}`);
    assert.ok(!/discovery did not finish within 15 s/.test(log), `the old worker's discovery bound fired during the reload${notes}`);
  });
});

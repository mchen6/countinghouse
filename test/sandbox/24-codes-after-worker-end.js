// After a module's worker has ended, a request addressed to one of its
// devices says why the device is not there: MODULE_UNLOADED once the module
// was unloaded, its new code failed to load, or it crashed with no
// supervisor to restart it. DEVICE_NOT_FOUND is left for a device that never
// existed. (An MCP tools/call never gets this far -- a tool that is not
// loaded is not listed -- so this is what HTTP invoke-action, composition
// hops and queued or scheduled jobs see.)
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');

const KEY     = 'codes-after-end-key';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'worker-end');
const DEVICE  = deviceIDForName('worker-end');
const SERVICE = 'urn:countinghouse-test:serviceID:endService';
const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));

const invoke = (port, deviceID) => post(port, KEY, `/devices/${deviceID || DEVICE}/invoke-action`,
  {serviceID: SERVICE, actionName: 'ping', input: {}});
const codeOf = (r) => (r.body != null ? r.body.code : undefined);

async function loadFrom(port, dir) {
  await post(port, KEY, '/load-module', {path: dir, name: 'worker-end'});
  await waitFor(async () => (await invoke(port)).status === 200, 20000, 'worker-end to answer');
}

// stray-output-module's returnsCleanly handler file, rewritten in a copy:
// `prelude` runs while the file is required (every load requires it), and
// v 'crash' ends the worker 50 ms after answering.
function writeReturnsCleanly(dir, prelude) {
  fs.writeFileSync(path.join(dir, 'handlers', 'svc', 'returnsCleanly.js'), `${prelude}\n` +
    "module.exports = (input, ctx, callback) => {\n" +
    "  if (input.v === 'crash') { setTimeout(() => process.exit(3), 50); return callback(null, {output: {v: 'bye'}}); }\n" +
    '  return callback(null, {output: {v: input.v}});\n};\n');
}

describe('sandbox 24: a request for a module that is gone says why', function() {
  this.timeout(120000);

  describe('under audit', () => {
    const PORT = 9613;
    let server = null;
    let base = null;
    let copy = null;
    before(async () => {
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-codes-after-end-'));
      copy = path.join(base, 'worker-end');
      fs.cpSync(FIXTURE, copy, {recursive: true});
      server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread']);
      await loadFrom(PORT, copy);
    });
    after(() => {
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it('a device that never existed is DEVICE_NOT_FOUND', async () => {
      const r = await invoke(PORT, deviceIDForName('never-loaded-anywhere'));
      assert.strictEqual(codeOf(r), 'DEVICE_NOT_FOUND', JSON.stringify(r.body));
    });

    it('after an unload, a request is MODULE_UNLOADED', async () => {
      assert.strictEqual((await post(PORT, KEY, '/unload-module', {name: 'worker-end'})).status, 200);
      const r = await invoke(PORT);
      assert.strictEqual(codeOf(r), 'MODULE_UNLOADED', JSON.stringify(r.body));
    });

    it('loading it again clears that', async () => {
      await loadFrom(PORT, copy);
      assert.strictEqual((await invoke(PORT)).status, 200);
    });

    it('a delayed job that comes due after an unload fails MODULE_UNLOADED, not retried', async () => {
      const added = await post(PORT, KEY, `/devices/${DEVICE}/add-job`, {serviceID: SERVICE, actionName: 'ping', input: {},
        opts: {name: 'codes-after-end-delayed', delay: 3000, attempts: 3}});
      assert.strictEqual(added.status, 200, JSON.stringify(added.body));
      assert.strictEqual((await post(PORT, KEY, '/unload-module', {name: 'worker-end'})).status, 200);
      const job = await waitFor(async () => {
        const b = (await post(PORT, KEY, `/devices/${DEVICE}/get-job`, {id: added.body.id})).body;
        return b.state === 'failed' ? b : null;
      }, 20000, 'the delayed job to fail');
      assert.match(job.job.failedReason, /^MODULE_UNLOADED: /);
      await sleep(1500);
      assert.strictEqual((await post(PORT, KEY, `/devices/${DEVICE}/get-job`, {id: added.body.id})).body.job.attemptsMade, 1);
      await loadFrom(PORT, copy);
    });

    // The new worker's devices come online only once it has discovered
    // them, seconds after the load itself answers: until then a request is
    // MODULE_RELOADING, never DEVICE_NOT_FOUND.
    it('between a reload and its devices coming back online, a request is MODULE_RELOADING', async () => {
      const seen = new Set();
      const loading = post(PORT, KEY, '/load-module', {path: copy, name: 'worker-end'});
      const deadline = Date.now() + 30000;
      let ok = false;
      while (!ok && Date.now() < deadline) {
        const r = await invoke(PORT);
        if (r.status === 200) ok = true; else seen.add(codeOf(r));
        await sleep(20);
      }
      await loading;
      assert.ok(ok, `never came back: ${JSON.stringify([...seen])}`);
      assert.ok(!seen.has('DEVICE_NOT_FOUND'), `saw DEVICE_NOT_FOUND during the reload: ${JSON.stringify([...seen])}`);
    });

    // The same for a supervised restart after a crash: from the crash until
    // the restarted worker's devices are back -- which, for a module that
    // takes a while to load (3 s here), is seconds after the supervisor has
    // it running again -- never DEVICE_NOT_FOUND.
    it('between a crash and the restarted worker\'s devices coming back, a request is never DEVICE_NOT_FOUND', async function() {
      this.timeout(60000);
      const dir = path.join(base, 'slow-load', 'stray-output-module');
      fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'stray-output-module'), dir, {recursive: true});
      writeReturnsCleanly(dir, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);');
      const id = deviceIDForName('stray-output-module');
      const call = (v) => post(PORT, KEY, `/devices/${id}/invoke-action`, {serviceID: 'urn:countinghouse-test:serviceID:svc', actionName: 'returnsCleanly', input: {v: v}});
      await post(PORT, KEY, '/load-module', {path: dir, name: 'stray-output-module'});
      await waitFor(async () => (await call('x')).status === 200, 20000, 'the slow-load copy to answer');
      await call('crash');
      const seen = new Set();
      const deadline = Date.now() + 30000;
      let down = false;
      let ok = false;
      while (!ok && Date.now() < deadline) {
        const r = await call('x');
        if (r.status === 200) { if (down) ok = true; } else { down = true; seen.add(codeOf(r)); }
        await sleep(20);
      }
      await post(PORT, KEY, '/unload-module', {name: 'stray-output-module'});
      assert.ok(ok, `never came back: ${JSON.stringify([...seen])}`);
      assert.ok(!seen.has('DEVICE_NOT_FOUND'), `saw DEVICE_NOT_FOUND during the restart: ${JSON.stringify([...seen])}`);
    });

    it('after a reload whose new code fails to load, a request is MODULE_UNLOADED', async () => {
      fs.writeFileSync(path.join(copy, 'api.json'), '{ this is not json');
      const loaded = await post(PORT, KEY, '/load-module', {path: copy, name: 'worker-end'});
      assert.notStrictEqual(loaded.status, 200, `the broken load should fail: ${JSON.stringify(loaded.body)}`);
      const r = await invoke(PORT);
      assert.strictEqual(codeOf(r), 'MODULE_UNLOADED', JSON.stringify(r.body));
    });
  });

  // MODULE_UNLOADED vs DEVICE_NOT_FOUND tells whether a device was ever
  // hosted here, so a key without a grant for it must not get either: the
  // route's grant check (from the auth config) answers first.
  describe('without a grant for the device (not under --debug)', () => {
    const PORT = 9615;
    const ADMIN = 'codes-after-end-admin';
    const OWNER = 'codes-after-end-owner';
    const OTHER = 'codes-after-end-other';
    let server = null;
    let base = null;
    const invokeAs = (key, deviceID) => post(PORT, key, `/devices/${deviceID}/invoke-action`, {serviceID: SERVICE, actionName: 'ping', input: {}});
    before(async () => {
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-codes-after-end-auth-'));
      const authPath = path.join(base, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({
        [ADMIN]: {userName: 'admin', devices: ['*'], admin: true},
        [OWNER]: {userName: 'owner', devices: [DEVICE]},
        [OTHER]: {userName: 'other', devices: [deviceIDForName('some-other-module')]}
      }));
      server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath, '--loadModule', FIXTURE]);
      await waitFor(async () => (await invokeAs(OWNER, DEVICE)).status === 200, 20000, 'worker-end to answer its owner');
      assert.strictEqual((await post(PORT, ADMIN, '/unload-module', {name: 'worker-end'})).status, 200);
    });
    after(() => {
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it('the device\'s owner is told MODULE_UNLOADED', async () => {
      assert.strictEqual(codeOf(await invokeAs(OWNER, DEVICE)), 'MODULE_UNLOADED');
    });

    it('a key with no grant gets USER_HAS_NO_DEVICE, the same as for a device that never existed', async () => {
      const unloaded = await invokeAs(OTHER, DEVICE);
      const never = await invokeAs(OTHER, deviceIDForName('never-loaded-anywhere'));
      assert.strictEqual(codeOf(unloaded), 'USER_HAS_NO_DEVICE', JSON.stringify(unloaded.body));
      assert.strictEqual(codeOf(never), 'USER_HAS_NO_DEVICE', JSON.stringify(never.body));
    });
  });

  describe('under --moduleSandbox off (no supervisor)', () => {
    const PORT = 9614;
    let server = null;
    before(async () => {
      server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', 'off']);
      await loadFrom(PORT, FIXTURE);
    });
    after(() => stopServer(server));

    it('after a crash, a request is MODULE_UNLOADED', async () => {
      await mcpCall(PORT, KEY, 'worker_end_endservice_crash', {}).catch(() => null);
      await waitFor(async () => (await invoke(PORT)).status !== 200, 10000, 'the crash to take the module down');
      const r = await invoke(PORT);
      assert.strictEqual(codeOf(r), 'MODULE_UNLOADED', JSON.stringify(r.body));
    });
  });
});

// A queued or scheduled job whose module is reloading, or being restarted
// by the supervisor, waits (up to 30 s) for the new worker and runs on it,
// instead of failing because it came due in the gap. If the module ends up
// unloaded or suspended, the job fails with that code and is not retried;
// if the wait runs out, it fails MODULE_RELOADING (or MODULE_RESTARTING),
// which bullmq retries when attempts > 1. A synchronous call in the same gap
// still fails at once.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');

const KEY     = 'jobs-wait-key';
const STRAY   = path.join(ROOT, 'test', 'fixtures', 'stray-output-module');
const SVC     = 'urn:countinghouse-test:serviceID:svc';
const ID      = deviceIDForName('stray-output-module');
const END     = path.join(ROOT, 'test', 'fixtures', 'worker-end');
const END_ID  = deviceIDForName('worker-end');
const END_SVC = 'urn:countinghouse-test:serviceID:endService';
const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf  = (r) => (r.body != null ? r.body.code : undefined);

// v2: answers {v: 'v2'}, and takes `loadMs` to load (a blocking require).
function writeV2(dir, loadMs) {
  const device = path.join(dir, 'device.js');
  fs.writeFileSync(device, fs.readFileSync(path.join(STRAY, 'device.js'), 'utf8')
    .replace("return callback(null, {output: {v: args.input.v}});", "return callback(null, {output: {v: 'v2'}});"));
  const index = path.join(dir, 'index.js');
  fs.writeFileSync(index, `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${loadMs});\n${fs.readFileSync(path.join(STRAY, 'index.js'), 'utf8')}`);
}

function suite(label, port, extraArgs) {
  return {label, port, extraArgs};
}

async function jobState(port, deviceID, id) {
  return (await post(port, KEY, `/devices/${deviceID}/get-job`, {id})).body;
}

async function settled(port, deviceID, id, ms) {
  return waitFor(async () => {
    const b = await jobState(port, deviceID, id);
    return (b.state === 'completed' || b.state === 'failed') ? b : null;
  }, ms, `job ${id} to settle`);
}

describe('sandbox 25: a job waits through its module\'s reload', function() {
  this.timeout(120000);

  [suite('under audit', 9621, ['--modulePolicy']), suite('under --moduleSandbox off', 9622, ['--moduleSandbox', 'off'])].forEach((s) => {
    describe(s.label, () => {
      let server = null;
      let base = null;
      let dir = null;
      const call = () => post(s.port, KEY, `/devices/${ID}/invoke-action`, {serviceID: SVC, actionName: 'returnsCleanly', input: {v: 'x'}});
      const addJob = (opts) => post(s.port, KEY, `/devices/${ID}/add-job`, {serviceID: SVC, actionName: 'returnsCleanly', input: {v: 'x'},
        opts: Object.assign({name: `jobs-wait-${Date.now()}`}, opts)});

      before(async () => {
        base = fs.mkdtempSync(path.join(os.homedir(), '.ch-jobs-wait-'));
        const args = ['--debug', '--debugKey', KEY, '--workerThread'];
        if (s.extraArgs[0] === '--modulePolicy') {
          // A block ceiling the slow loads below stay under.
          const policy = path.join(base, 'policy.json');
          fs.writeFileSync(policy, JSON.stringify({limits: {maxBlockMs: 60000}}));
          args.push('--modulePolicy', policy);
        } else {
          args.push(...s.extraArgs);
        }
        server = await startServer(s.port, args);
      });
      beforeEach(async () => {
        dir = path.join(base, `stray-${Date.now()}`, 'stray-output-module');
        fs.cpSync(STRAY, dir, {recursive: true});
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        pkg.countinghouse = {permissions: {limits: {maxBlockMs: 60000}}};
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
        await post(s.port, KEY, '/load-module', {path: dir, name: 'stray-output-module'});
        await waitFor(async () => (await call()).status === 200, 20000, 'v1 to answer');
      });
      after(() => {
        stopServer(server);
        if (base != null) fs.rmSync(base, {recursive: true, force: true});
      });

      it('a job that comes due during a reload runs on the new module; a call in the gap fails at once', async () => {
        writeV2(dir, 3000);
        const reload = post(s.port, KEY, '/load-module', {path: dir, name: 'stray-output-module'});
        await sleep(300);
        const started = Date.now();
        const sync = await call();
        assert.strictEqual(codeOf(sync), 'MODULE_RELOADING', JSON.stringify(sync.body));
        assert.ok(Date.now() - started < 2000, 'the call waited');
        const added = await addJob({});
        assert.strictEqual(added.status, 200, JSON.stringify(added.body));
        await reload;
        const job = await settled(s.port, ID, added.body.id, 40000);
        assert.strictEqual(job.state, 'completed', JSON.stringify(job.job.failedReason));
        assert.deepStrictEqual(job.job.returnvalue, {output: {v: 'v2'}});
      });

      it('a job waiting through a reload whose new code fails to load fails MODULE_UNLOADED, not retried', async () => {
        writeV2(dir, 2000);
        fs.writeFileSync(path.join(dir, 'api.json'), '{ not json');
        const reload = post(s.port, KEY, '/load-module', {path: dir, name: 'stray-output-module'});
        await sleep(300);
        const added = await addJob({attempts: 3});
        await reload;
        const job = await settled(s.port, ID, added.body.id, 40000);
        assert.strictEqual(job.state, 'failed');
        assert.match(job.job.failedReason, /^MODULE_UNLOADED: /);
        await sleep(1500);
        assert.strictEqual((await jobState(s.port, ID, added.body.id)).job.attemptsMade, 1);
      });

      it('a job whose reload outlasts the wait fails MODULE_RELOADING after about 30 s, once', async function() {
        this.timeout(90000);
        writeV2(dir, 45000);
        const reload = post(s.port, KEY, '/load-module', {path: dir, name: 'stray-output-module'});
        await sleep(300);
        const started = Date.now();
        const added = await addJob({});
        const job = await settled(s.port, ID, added.body.id, 45000);
        const ms = Date.now() - started;
        assert.strictEqual(job.state, 'failed', JSON.stringify(job.job));
        assert.match(job.job.failedReason, /^MODULE_RELOADING: /);
        assert.ok(ms > 25000 && ms < 40000, `failed after ${ms} ms`);
        assert.strictEqual(job.job.attemptsMade, 1, 'processed more than once (stalled?)');
        await reload;
      });
    });
  });

  describe('a supervisor restart (audit)', () => {
    const PORT = 9623;
    let server = null;
    const ping = () => post(PORT, KEY, `/devices/${END_ID}/invoke-action`, {serviceID: END_SVC, actionName: 'ping', input: {}});
    const addPing = (opts) => post(PORT, KEY, `/devices/${END_ID}/add-job`, {serviceID: END_SVC, actionName: 'ping', input: {},
      opts: Object.assign({name: `jobs-wait-restart-${Date.now()}`}, opts)});
    const crash = async () => {
      await mcpCall(PORT, KEY, 'worker_end_endservice_crash', {}).catch(() => null);
      await waitFor(async () => codeOf(await ping()) === 'MODULE_RESTARTING' || codeOf(await ping()) === 'MODULE_SUSPENDED', 10000, 'the restart to begin');
    };
    before(async () => { server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--loadModule', END]); });
    beforeEach(async () => {
      await post(PORT, KEY, '/restart-module', {name: 'worker-end'});
      await waitFor(async () => (await ping()).status === 200, 20000, 'worker-end to answer');
    });
    after(() => stopServer(server));

    it('a job that comes due while the supervisor restarts the module runs on the restarted one', async () => {
      await crash();
      const added = await addPing({});
      const job = await settled(PORT, END_ID, added.body.id, 40000);
      assert.strictEqual(job.state, 'completed', JSON.stringify(job.job.failedReason));
    });

    it('a job for a module the supervisor has suspended fails MODULE_SUSPENDED, not retried', async () => {
      for (let i = 0; i < 3; i++) {
        await crash();
        if (i < 2) await waitFor(async () => (await ping()).status === 200, 20000, 'the restart');
      }
      await waitFor(async () => codeOf(await ping()) === 'MODULE_SUSPENDED', 15000, 'suspension');
      const added = await addPing({attempts: 3});
      const job = await settled(PORT, END_ID, added.body.id, 20000);
      assert.strictEqual(job.state, 'failed');
      assert.match(job.job.failedReason, /^MODULE_SUSPENDED: /);
      await sleep(1500);
      assert.strictEqual((await jobState(PORT, END_ID, added.body.id)).job.attemptsMade, 1);
      // An operator unload of the suspended module: unloaded, not "restarting".
      assert.strictEqual((await post(PORT, KEY, '/unload-module', {name: 'worker-end'})).status, 200);
      assert.strictEqual(codeOf(await ping()), 'MODULE_UNLOADED');
    });
  });
});

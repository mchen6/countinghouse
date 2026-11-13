// Operator actions on one module name take effect in order, the latest one
// winning: a reload that arrives while an earlier reload's worker is still
// coming up supersedes it (that worker ends, the earlier caller is told
// MODULE_LOAD_SUPERSEDED), and an unload that arrives then cancels the reload
// and leaves the module unloaded; the same holds for an operator restart,
// which ends the old worker before it spawns. Through it all, the devices are reloading,
// never unloaded, until the new worker is up, so a job that came due waits
// and runs -- or, once an unload has cancelled the reload, fails at once as
// MODULE_UNLOADED. Before, a second reload terminated the first one's loading
// worker, which settled the devices to MODULE_UNLOADED and failed the waiting
// jobs for good; and an unload during a reload was refused ("unknown module")
// and then undone by the reload's worker coming up. A supervisor restart
// racing an operator reload stands down to it: one worker at the end.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer, post, waitFor} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');

const KEY     = 'operator-order-key';
const NAME    = 'stray-output-module';
const DEVICE  = deviceIDForName(NAME);
const SERVICE = 'urn:countinghouse-test:serviceID:svc';
const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf  = (r) => (r.status === 200 ? 200 : (r.body != null ? r.body.code : undefined));

// Slow to load (1.5 s, so a second action lands while the worker is still
// coming up) and slow to discover (a 3 s block just after its load, before it
// answers discover, so there is a reload window), both from its handler file,
// which every load requires; a call with v 'block' holds the worker 1.2 s, so
// an unload sent meanwhile waits that long for its acknowledgement.
function slowCopy(base) {
  const dir = path.join(base, NAME);
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', NAME), dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'handlers', 'svc', 'returnsCleanly.js'),
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);\n' +
    'setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000));\n' +
    'module.exports = (input, ctx, callback) => {\n' +
    "  if (input.v === 'crash') { setTimeout(() => process.exit(3), 50); return callback(null, {output: {v: 'bye'}}); }\n" +
    "  if (input.v === 'block') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);\n" +
    '  return callback(null, {output: {v: input.v}});\n};\n');
  return dir;
}

// Workers of the module alive now. No route lists a module's workers, so
// the server's log is the oracle: every worker started logs "spawn walk"
// (module-manager.js, under the lifecycle lock) and every worker gone logs
// "settled" once its broker is idle (lib/module-lifecycle.js
// settleAfterExit; bounded at 35 s after its exit), whatever ended it.
const alive = (server) => (server.output.match(/spawn walk/g) || []).length - (server.output.match(/file broker: stray-output-module settled/g) || []).length;
const aliveIs = (server, n) => waitFor(() => alive(server) === n, 15000, `${n} worker(s) alive (now ${alive(server)})`);

function helpers(port) {
  const url = `http://127.0.0.1:${port}`;
  const call = (v) => post(port, KEY, `/devices/${DEVICE}/invoke-action`, {serviceID: SERVICE, actionName: 'returnsCleanly', input: {v: v || 'x'}});
  return {
    call,
    load: (dir) => post(port, KEY, '/load-module', {path: dir, name: NAME}),
    ready: () => waitFor(async () => (await call()).status === 200, 30000, 'the module to answer'),
    tools: () => request(url).post('/mcp').set('X-CH-Key', KEY).set('Accept', 'application/json, text/event-stream')
      .send({jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {}})
      .then((r) => r.body.result.tools.map((t) => t.name).filter((n) => n.startsWith('stray_output_module_'))),
    addJob: (opts) => post(port, KEY, `/devices/${DEVICE}/add-job`, {serviceID: SERVICE, actionName: 'returnsCleanly', input: {v: 'job'},
      opts: Object.assign({name: `operator-order-${Date.now()}`}, opts)}),
    jobSettled: (id) => waitFor(async () => {
      const b = (await post(port, KEY, `/devices/${DEVICE}/get-job`, {id})).body;
      return (b.state === 'completed' || b.state === 'failed') ? b : null;
    }, 40000, 'the job to settle'),
    // Polls the device until it answers (and `until` holds); the codes seen meanwhile.
    untilBack: async (until) => {
      const seen = new Set();
      let back = false;
      const deadline = Date.now() + 40000;
      while (!back && Date.now() < deadline) {
        const r = await call();
        if (r.status === 200 && (until == null || until())) back = true; else if (r.status !== 200) seen.add(codeOf(r));
        await sleep(200);
      }
      return {back, seen: [...seen]};
    }
  };
}

describe('sandbox 33: operator actions on one module, back to back', function() {
  this.timeout(120000);

  describe('under --moduleSandbox off', () => {
    const PORT = 9644;
    const h = helpers(PORT);
    let server = null;
    let base = null;
    let dir = null;
    before(async () => {
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-operator-order-'));
      dir = slowCopy(base);
      // Sandbox off: no block limit ends the slow load, and no supervisor.
      server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', 'off']);
      await h.load(dir);
      await h.ready();
    });
    after(() => {
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it('a second reload supersedes the first; the devices stay reloading, a job between them runs, one worker remains', async () => {
      const first = h.load(dir);
      await sleep(150);
      const added = await h.addJob({});
      assert.strictEqual(added.status, 200, JSON.stringify(added.body));
      await sleep(150);
      const second = h.load(dir);
      let secondDone = false;
      second.then(() => { secondDone = true; });
      const {back, seen} = await h.untilBack(() => secondDone);
      const [r1, r2] = await Promise.all([first, second]);
      assert.ok(back, `the module never came back: ${JSON.stringify(seen)}`);
      assert.strictEqual(r2.status, 200, `the second reload: ${JSON.stringify(r2.body)}`);
      assert.strictEqual(codeOf(r1), 'MODULE_LOAD_SUPERSEDED', `the first reload: ${JSON.stringify(r1.body)}`);
      assert.ok(!seen.includes('MODULE_UNLOADED') && !seen.includes('DEVICE_NOT_FOUND'), `during the reloads: ${JSON.stringify(seen)}`);
      const job = await h.jobSettled(added.body.id);
      assert.strictEqual(job.state, 'completed', JSON.stringify(job.job && job.job.failedReason));
      assert.deepStrictEqual(job.job.returnvalue, {output: {v: 'job'}});
      await aliveIs(server, 1);
    });

    it('an unload during a reload cancels it: a waiting job fails MODULE_UNLOADED at once, the tools are gone', async () => {
      const reload = h.load(dir);
      await sleep(150);
      const added = await h.addJob({attempts: 3});
      assert.strictEqual(added.status, 200, JSON.stringify(added.body));
      await sleep(150);
      const started = Date.now();
      const unloaded = await post(PORT, KEY, '/unload-module', {name: NAME});
      assert.strictEqual(unloaded.status, 200, JSON.stringify(unloaded.body));
      const r = await reload;
      assert.strictEqual(codeOf(r), 'MODULE_LOAD_SUPERSEDED', `the reload: ${JSON.stringify(r.body)}`);
      const job = await h.jobSettled(added.body.id);
      assert.strictEqual(job.state, 'failed', JSON.stringify(job.job && job.job.returnvalue));
      assert.match(job.job.failedReason, /^MODULE_UNLOADED: /);
      assert.ok(Date.now() - started < 10000, 'the job waited out the reload wait instead of failing at once');
      await sleep(5000);   // long enough for the cancelled reload's worker to have come up, had it not been cancelled
      assert.strictEqual((await post(PORT, KEY, `/devices/${DEVICE}/get-job`, {id: added.body.id})).body.job.attemptsMade, 1, 'retried');
      assert.deepStrictEqual(await h.tools(), [], 'the module\'s tools are listed');
      const after = await h.call();
      assert.strictEqual(codeOf(after), 'MODULE_UNLOADED', JSON.stringify(after.body));
      await aliveIs(server, 0);
    });

    it('and the module loads again afterwards', async () => {
      const r = await h.load(dir);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      await h.ready();
      await aliveIs(server, 1);
    });

    // A restart ends the old worker first and only then spawns; while the old
    // worker is slow to acknowledge, a later action must outrank the restart.
    it('an unload during a restart\'s unload phase wins: the module stays unloaded', async () => {
      const blocked = h.call('block').catch(() => null);
      await sleep(100);
      const restart = post(PORT, KEY, '/restart-module', {name: NAME});
      await sleep(300);
      const unloaded = await post(PORT, KEY, '/unload-module', {name: NAME});
      assert.strictEqual(unloaded.status, 200, JSON.stringify(unloaded.body));
      const r = await restart;
      assert.strictEqual(codeOf(r), 'MODULE_LOAD_SUPERSEDED', `the restart: ${JSON.stringify(r.body)}`);
      await blocked;
      await sleep(5000);   // long enough for the restart's worker to have come up, had the restart gone on
      assert.deepStrictEqual(await h.tools(), [], 'the module\'s tools are listed');
      assert.strictEqual(codeOf(await h.call()), 'MODULE_UNLOADED');
      await aliveIs(server, 0);
    });

    it('a reload during a restart\'s unload phase wins: the reload\'s caller is answered, one worker', async () => {
      assert.strictEqual((await h.load(dir)).status, 200);
      await h.ready();
      const blocked = h.call('block').catch(() => null);
      await sleep(100);
      const restart = post(PORT, KEY, '/restart-module', {name: NAME});
      await sleep(300);
      const reload = h.load(dir);
      let reloadDone = false;
      reload.then(() => { reloadDone = true; });
      const {back, seen} = await h.untilBack(() => reloadDone);
      const [rr, rl] = await Promise.all([restart, reload]);
      await blocked;
      assert.ok(back, `the module never came back: ${JSON.stringify(seen)}`);
      assert.strictEqual(rl.status, 200, `the reload: ${JSON.stringify(rl.body)}`);
      assert.strictEqual(codeOf(rr), 'MODULE_LOAD_SUPERSEDED', `the restart: ${JSON.stringify(rr.body)}`);
      assert.ok(!seen.includes('MODULE_UNLOADED') && !seen.includes('DEVICE_NOT_FOUND'), `during the race: ${JSON.stringify(seen)}`);
      await aliveIs(server, 1);
    });
  });

  describe('under audit, with the supervisor', () => {
    const PORT = 9645;
    const h = helpers(PORT);
    let server = null;
    let base = null;
    let dir = null;
    before(async () => {
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-operator-order-audit-'));
      dir = slowCopy(base);
      // A block limit above the slow load, so the limit does not end the worker.
      const policy = path.join(base, 'policy.json');
      fs.writeFileSync(policy, JSON.stringify({limits: {maxBlockMs: 30000}}));
      server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--modulePolicy', policy]);
      await h.load(dir);
      await h.ready();
    });
    after(() => {
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it('a supervisor restart racing an operator reload stands down: one worker, never DEVICE_NOT_FOUND', async () => {
      await h.call('crash');
      // The first exit restarts after 1 s; 1.3 s on, the restart's worker is loading.
      await sleep(1300);
      const reload = h.load(dir);
      let reloadDone = false;
      reload.then(() => { reloadDone = true; });
      const {back, seen} = await h.untilBack(() => reloadDone);
      const r = await reload;
      assert.strictEqual(r.status, 200, `the reload: ${JSON.stringify(r.body)}`);
      assert.ok(back, `the module never came back: ${JSON.stringify(seen)}`);
      assert.ok(!seen.includes('DEVICE_NOT_FOUND'), `during the race: ${JSON.stringify(seen)}`);
      await aliveIs(server, 1);
    });
  });
});

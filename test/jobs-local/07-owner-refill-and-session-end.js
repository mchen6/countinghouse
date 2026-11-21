'use strict';
// #518's high round, at the runner (the local one; BullMQ's shares
// job-control-common's two steps):
//   M1: a miss inside the refill throttle (a refill ran moments ago) waits
//       for a refill that asks the provider, and finds an owner the
//       provider lists -- never "owner removed", which fails the job for
//       good and deletes a scheduler;
//   M2: a session that ends while the owner is being made known (the
//       provider read for a new key) gets no job, as one that ended before
//       the gateway's own check does.
// In child processes, as jobs-local 04: user-auth and lib/auth's
// identitySource stubbed, the provider's reads counted and delayed.
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');
const {identityLines} = require('../helpers/identity-scope');

const LIB = path.join(__dirname, '..', '..', 'lib');

function child(body, keys = []) {
  const script = `
    const options = require(${JSON.stringify(path.join(LIB, 'cli-options'))});
    options.workerThread = true;
    options.mcpToolCallCost = 1;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const authPath = require.resolve(${JSON.stringify(path.join(LIB, 'user-auth'))});
    require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
      exports: (a, b, deviceID, appKey, serviceID, actionName, localCB, cb) => setImmediate(() => cb(null, {}))};
    // the provider lib/auth hands the identity index (its reads counted, delayed)
    const provider = {reads: 0, delayMs: 0, list: [], entries(cb) { this.reads++; setTimeout(() => cb(null, this.list.slice()), this.delayMs); }};
    const libAuth = require.resolve(${JSON.stringify(path.join(LIB, 'auth'))});
    require.cache[libAuth] = {id: libAuth, filename: libAuth, loaded: true, exports: {identitySource: () => provider, getAuthProvider: () => provider}};
    ${identityLines(LIB, keys)}
    const identity = require(${JSON.stringify(path.join(LIB, 'identity'))});
    const {createRunner} = require(${JSON.stringify(path.join(LIB, 'job-control-local'))});
    const {INTERNAL} = require(${JSON.stringify(path.join(LIB, 'job-control-common'))});
    const runner = createRunner({jobTimeoutMs: 0});
    const billed = [];
    runner.initJobProcess({recordCall: (k, t, c, cb) => { billed.push(k); if (cb) cb(null); },
      invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback) => setImmediate(callback, null, {ok: 1})});
    const add = (ctx, opts = {name: 'n'}) => new Promise((resolve) => runner.addJob(ctx, opts, 'dev', 'svc', 'act', {}, (err, r) => resolve({err, r})));
    const stateOf = (id) => new Promise((resolve) => runner.getJob(INTERNAL, id, (e, rec) => resolve(rec)));
    (async () => { const out = await (async () => { ${body} })(); process.stdout.write('OUT ' + JSON.stringify(out) + '\\n'); process.exit(0); })()
      .catch((e) => { process.stdout.write('OUT ' + JSON.stringify({thrown: String(e && e.message)}) + '\\n'); process.exit(0); });`;
  const r = spawnSync(process.execPath, ['-e', script], {cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 40000});
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('OUT '));
  assert.ok(line != null, `no output: ${r.stdout} ${r.stderr}`);
  return JSON.parse(line.slice(4));
}

describe('jobs-local 07: the owner refill a run waits for, and a session ending during the add (#518\'s high, M1, M2)', function() {
  this.timeout(90000);

  it('M1: an owner missing from the index just after a refill is found by the next one, and the run is billed to it', () => {
    const out = child(`
      provider.list = [{apiKey: 'owner-m1', userName: 'o'}];
      const added = await add({appKey: 'owner-m1'});
      if (added.err) return {addErr: added.err.code || added.err.message};
      // a refill moments ago (another miss's, an operator lookup's), then
      // the owner gone from the index -- the provider still lists it
      await new Promise((resolve) => identity.resolve('u_nobody', provider, resolve));
      identity.stateForTests().forget();
      const t0 = Date.now();
      let rec = null;
      while (Date.now() - t0 < 20000) {
        rec = await stateOf(added.r.id);
        if (rec != null && (rec.state === 'completed' || rec.state === 'failed')) break;
        await sleep(50);
      }
      return {state: rec && rec.state, reason: rec && rec.job ? rec.job.failedReason || null : null, billed};`);
    assert.deepStrictEqual(out, {state: 'completed', reason: null, billed: ['owner-m1']}, JSON.stringify(out));
  });

  it('M2: a session that ends while its owner is being made known gets no job', () => {
    const out = child(`
      provider.list = [{apiKey: 'owner-m2', userName: 'o'}];
      provider.delayMs = 400;
      let open = true;
      setTimeout(() => { open = false; }, 100);
      const added = await add({appKey: 'owner-m2', session: 's-m2', stillOpen: () => open});
      const listed = await new Promise((resolve) => runner.listJobs(INTERNAL, (e, list) => resolve(list || [])));
      return {sessionEnded: added.err != null && added.err.sessionEnded === true, code: added.err && added.err.code, jobs: listed.length};`);
    assert.deepStrictEqual(out, {sessionEnded: true, code: 'MODULE_NOT_LISTED', jobs: 0}, JSON.stringify(out));
  });
});

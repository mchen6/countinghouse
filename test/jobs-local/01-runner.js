'use strict';

// LM1 B5, Task 8 (plan 2026-11-11-lm1-store-and-identity.md; spec section
// 1: "the same surface job-control.js exposes to the rest of the runtime
// ..., run in-process by one worker loop with the same per-job timeout;
// state in memory, results kept until read or for --jobResultTtl; not
// persisted across restarts"). Driven through the surface with a stub
// cdifInterface; the owner check before each run (authorizeRun) is stubbed
// as tests of job-control.js stub it.

const assert = require('assert');
const {createRunner} = require('../../lib/job-control-local');
const {INTERNAL} = require('../../lib/job-control-common');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await wait(20); }
  return false;
}
function call(runner, method, ...args) {
  return new Promise((resolve) => runner[method](...args, (err, r) => resolve({err, r})));
}
// A cdifInterface whose invokeJobs answers with `answer(callIndex, ...args)`.
function stubInterface(answer) {
  const calls = [];
  return {
    calls,
    recordCall: (key, tool, cost, cb) => cb && cb(null),
    invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
      calls.push({deviceID, serviceID, actionName, input, jobID, cancelled, extraArgs});
      return answer(calls.length - 1, callback, cancelled, jobID);
    }
  };
}
function runnerWith(answer, opts) {
  const ci = stubInterface(answer);
  const runner = createRunner(Object.assign({jobTimeoutMs: 0}, opts || {}));
  runner.authorizeRun = () => Promise.resolve();
  runner.initJobProcess(ci);
  return {runner, ci};
}
const state = async (runner, id, auth = INTERNAL) => (await call(runner, 'getJob', auth, id)).r;

describe('jobs-local 01: the local job runner (LM1 B5)', function() {
  this.timeout(20000);
  // the runner, as job-control.js, serves only in worker mode
  const options = require('../../lib/cli-options');
  let workerThread;
  before(() => { workerThread = options.workerThread; options.workerThread = true; });
  after(() => { options.workerThread = workerThread; });

  it('runs a job, keeps its result, and merges the completion hook\'s answer into its data', async () => {
    const {runner} = runnerWith((i, cb) => setImmediate(cb, null, {ok: 1}));
    const seen = [];
    runner.setCompletionHook((jobData, results, meta) => { seen.push({jobData, results, meta}); return {stamp: 'x'}; });
    const {r} = await call(runner, 'addJob', INTERNAL, {name: 'n'}, 'dev', 'svc', 'act', {a: 1});
    assert.ok(await until(async () => (await state(runner, r.id)).state === 'completed'));
    const rec = await state(runner, r.id);
    assert.deepStrictEqual(rec.job.returnvalue, {ok: 1});
    assert.strictEqual(rec.job.data.stamp, 'x');
    assert.deepStrictEqual(seen[0].results, {ok: 1});
    assert.ok(typeof(rec.job.finishedOn) === 'number' && typeof(rec.job.processedOn) === 'number');
    runner.close();
  });

  it('records progress', async () => {
    const ref = {};
    const {runner} = runnerWith((i, cb, c, jobID) => { ref.runner.updateJobProgress(jobID, 50); setTimeout(cb, 50, null, {}); });
    ref.runner = runner;
    const {r} = await call(runner, 'addJob', INTERNAL, {name: 'p'}, 'd', 's', 'a', {});
    assert.ok(await until(async () => (await state(runner, r.id)).job.progress === 50));
    runner.close();
  });

  it('retries a failed run up to its attempts, and a NOT_RETRIED code not at all', async () => {
    const {runner, ci} = runnerWith((i, cb) => setImmediate(cb, (i < 2) ? Object.assign(new Error('flaky'), {code: 'FLAKY'}) : null, {done: i}));
    const {r} = await call(runner, 'addJob', INTERNAL, {name: 'r', attempts: 3}, 'd', 's', 'a', {});
    assert.ok(await until(async () => (await state(runner, r.id)).state === 'completed'));
    assert.strictEqual(ci.calls.length, 3);
    const gone = runnerWith((i, cb) => setImmediate(cb, Object.assign(new Error('gone'), {code: 'MODULE_UNLOADED'})));
    const g = (await call(gone.runner, 'addJob', INTERNAL, {name: 'g', attempts: 3}, 'd', 's', 'a', {})).r;
    assert.ok(await until(async () => (await state(gone.runner, g.id)).state === 'failed'));
    assert.strictEqual(gone.ci.calls.length, 1);
    assert.strictEqual((await state(gone.runner, g.id)).job.failedReason, 'MODULE_UNLOADED: gone');
    runner.close(); gone.runner.close();
  });

  it('fails a run past its timeout, drops a late answer, and tells the completion hook of the failure', async () => {
    let late = null;
    const {runner} = runnerWith((i, cb) => { late = cb; });
    const failures = [];
    runner.setCompletionHook((jobData, results, meta) => { failures.push({results, error: meta && meta.error && meta.error.message}); });
    const {r} = await call(runner, 'addJob', INTERNAL, {name: 't', timeout: 100}, 'd', 's', 'a', {});
    assert.ok(await until(async () => (await state(runner, r.id)).state === 'failed'));
    assert.strictEqual((await state(runner, r.id)).job.failedReason, 'Promise timed out after 100 milliseconds');
    late(null, {late: true});
    await wait(50);
    assert.strictEqual((await state(runner, r.id)).state, 'failed');
    assert.deepStrictEqual(failures, [{results: null, error: 'Promise timed out after 100 milliseconds'}]);
    runner.close();
  });

  it('a job with a delay waits, then runs', async () => {
    const {runner} = runnerWith((i, cb) => setImmediate(cb, null, {}));
    const {r} = await call(runner, 'addJob', INTERNAL, {name: 'd', delay: 200}, 'd', 's', 'a', {});
    assert.strictEqual((await state(runner, r.id)).state, 'delayed');
    assert.ok(await until(async () => (await state(runner, r.id)).state === 'completed'));
    runner.close();
  });

  it('removing a job not yet started cancels it, it never runs, and it is forgotten', async () => {
    const {runner, ci} = runnerWith((i, cb) => setImmediate(cb, null, {}));
    const {r} = await call(runner, 'addJob', INTERNAL, {name: 'x', delay: 200}, 'd', 's', 'a', {});
    assert.deepStrictEqual((await call(runner, 'removeJob', INTERNAL, 'x', r.id, false)).r, {removed: true});
    assert.strictEqual((await call(runner, 'getJob', INTERNAL, r.id)).err.message, new (require('../../lib/countinghouse-error').CountinghouseError)('GET_JOB_ERROR', 'unknown job').message);
    await wait(400);
    assert.strictEqual(ci.calls.length, 0);
    runner.close();
  });

  it('a scheduler runs every interval up to its limit, a cron pattern too, and removing it stops it', async () => {
    const {runner, ci} = runnerWith((i, cb) => setImmediate(cb, null, {}));
    await call(runner, 'addJob', INTERNAL, {name: 'every', repeat: {every: 1000, limit: 2}}, 'd', 's', 'a', {});
    await wait(2600);
    assert.strictEqual(ci.calls.length, 2);
    const cron = runnerWith((i, cb) => setImmediate(cb, null, {}));
    await call(cron.runner, 'addJob', INTERNAL, {name: 'cron', repeat: {cron: '* * * * * *'}}, 'd', 's', 'a', {});
    assert.ok(await until(() => cron.ci.calls.length >= 1, 2500));
    assert.deepStrictEqual((await call(cron.runner, 'removeJob', INTERNAL, 'cron', null, true)).r, {removed: true});
    const after = cron.ci.calls.length;
    await wait(1500);
    assert.strictEqual(cron.ci.calls.length, after);
    runner.close(); cron.runner.close();
  });

  it('a job is its owner\'s: another key is refused, an admin is not, and listJobs filters', async () => {
    const {runner} = runnerWith((i, cb) => setImmediate(cb, null, {}));
    const {r} = await call(runner, 'addJob', {appKey: 'a'}, {name: 'o'}, 'd', 's', 'a', {});
    assert.strictEqual((await call(runner, 'getJob', {appKey: 'b'}, r.id)).err.code, 'JOB_ACCESS_DENIED');
    assert.strictEqual((await call(runner, 'getJob', {appKey: 'z', isAdmin: true}, r.id)).err, null);
    assert.strictEqual((await call(runner, 'listJobs', {appKey: 'a'})).r.length, 1);
    assert.strictEqual((await call(runner, 'listJobs', {appKey: 'b'})).r.length, 0);
    assert.strictEqual((await call(runner, 'getJob', null, r.id)).err.code, 'SYSTEM_ERROR_UNKNOWN_USER');
    runner.close();
  });

  it('a job from another runner (an earlier process) is not found', async () => {
    const a = runnerWith((i, cb) => setImmediate(cb, null, {}));
    const {r} = await call(a.runner, 'addJob', INTERNAL, {name: 'e'}, 'd', 's', 'a', {});
    a.runner.close();
    const b = runnerWith((i, cb) => setImmediate(cb, null, {}));
    assert.strictEqual((await call(b.runner, 'getJob', INTERNAL, r.id)).err.code, 'GET_JOB_ERROR');
    b.runner.close();
  });

  it('the start hook runs before each run; its answer is invokeJobs\'s last argument and the completion hook\'s extra', async () => {
    const {runner, ci} = runnerWith((i, cb) => setImmediate(cb, null, {}));
    const metas = [];
    runner.setStartHook((jobData) => ({usageCall: 7, name: jobData.actionName}));
    runner.setCompletionHook((jobData, results, meta) => { metas.push(meta); });
    const {r} = await call(runner, 'addJob', INTERNAL, {name: 's'}, 'd', 's', 'act', {});
    assert.ok(await until(async () => (await state(runner, r.id)).state === 'completed'));
    assert.deepStrictEqual(ci.calls[0].extraArgs, {usageCall: 7, name: 'act'});
    assert.deepStrictEqual(metas, [{extra: {usageCall: 7, name: 'act'}}]);
    runner.close();
  });

  // #141 N6: the start hook's answer cannot set the run's bookkeeping; #141
  // (item 3's edge): a job's own timeout is validated where it comes in, and
  // the token's bound is the run's real timer.
  it('the start hook\'s answer cannot name the owner or the timeout; a job\'s timeout is a whole number of milliseconds', async () => {
    const {runner, ci} = runnerWith((i, cb) => setImmediate(cb, null, {}));
    runner.setStartHook(() => ({usageCall: 8, ownerKey: 'victim', timeoutMs: 1}));
    const {r} = await call(runner, 'addJob', INTERNAL, {name: 'h', timeout: 5000}, 'd', 's', 'act', {});
    assert.ok(await until(async () => (await state(runner, r.id)).state === 'completed'));
    const got = ci.calls[0].extraArgs;
    assert.notStrictEqual(got.ownerKey, 'victim', 'the start hook named the owner');
    assert.deepStrictEqual([got.usageCall, got.timeoutMs], [8, 5000], JSON.stringify(got));
    const words = (opts) => call(runner, 'addJob', INTERNAL, Object.assign({name: 't'}, opts), 'd', 's', 'a', {}).then((x) => (x.err != null ? x.err.message : null));
    const expected = new (require('../../lib/countinghouse-error').CountinghouseError)('ADD_JOB_ERROR', 'timeout must be a whole number of milliseconds, at least 1').message;
    assert.deepStrictEqual([await words({timeout: 0}), await words({timeout: -5}), await words({timeout: 'soon'}), await words({timeout: 1.5})], [expected, expected, expected, expected]);
    runner.close();
  });

  it('refuses what job-control refuses, in the same words', async () => {
    const {runner} = runnerWith((i, cb) => setImmediate(cb, null, {}));
    assert.strictEqual((await call(runner, 'addJob', INTERNAL, {name: 'b', attempts: 11}, 'd', 's', 'a', {})).err.message,
      new (require('../../lib/countinghouse-error').CountinghouseError)('ADD_JOB_ERROR', 'attempts must be a whole number from 1 to 10').message);
    assert.strictEqual((await call(runner, 'addJob', INTERNAL, null, 'd', 's', 'a', {})).err.code, 'ADD_JOB_ERROR');
    assert.strictEqual((await call(runner, 'removeJob', INTERNAL, 'b', '1', 'yes')).err.code, 'REMOVE_JOB_ERROR');
    runner.close();
  });

  it('forgets a finished job after the result TTL', async () => {
    const {runner} = runnerWith((i, cb) => setImmediate(cb, null, {}), {resultTtlMs: 150});
    const {r} = await call(runner, 'addJob', INTERNAL, {name: 'ttl'}, 'd', 's', 'a', {});
    assert.ok(await until(async () => (await state(runner, r.id)).state === 'completed'));
    await wait(400);
    assert.strictEqual((await call(runner, 'getJob', INTERNAL, r.id)).err.code, 'GET_JOB_ERROR');
    runner.close();
  });
});

// The review of B5 (/code-review medium on 9795453).
describe('jobs-local 01: the review of B5', function() {
  this.timeout(20000);
  const options = require('../../lib/cli-options');
  let workerThread;
  before(() => { workerThread = options.workerThread; options.workerThread = true; });
  after(() => { options.workerThread = workerThread; });

  it('removing a scheduler removes its run already queued for later', async () => {
    const {runner, ci} = runnerWith((i, cb) => setImmediate(cb, null, {}));
    await call(runner, 'addJob', INTERNAL, {name: 'far', repeat: {cron: '0 0 1 1 *'}}, 'd', 's', 'a', {});
    assert.strictEqual((await call(runner, 'listJobs', INTERNAL)).r.length, 1);
    await call(runner, 'removeJob', INTERNAL, 'far', null, true);
    assert.strictEqual((await call(runner, 'listJobs', INTERNAL)).r.length, 0);
    assert.strictEqual(ci.calls.length, 0);
    runner.close();
  });

  it('a delay longer than one timer can hold waits until its time', async () => {
    const {runner, ci} = runnerWith((i, cb) => setImmediate(cb, null, {}), {maxTimerMs: 40});
    const {r} = await call(runner, 'addJob', INTERNAL, {name: 'long', delay: 300}, 'd', 's', 'a', {});
    await wait(150);
    assert.strictEqual(ci.calls.length, 0);
    assert.strictEqual((await state(runner, r.id)).state, 'delayed');
    assert.ok(await until(async () => (await state(runner, r.id)).state === 'completed'));
    runner.close();
  });

  it('listJobs answers the newest first, as job-control asks BullMQ for', async () => {
    const {runner} = runnerWith(() => {});
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await call(runner, 'addJob', INTERNAL, {name: `n${i}`, delay: 60000}, 'd', 's', 'a', {})).r.id);
    assert.deepStrictEqual((await call(runner, 'listJobs', INTERNAL)).r.map((x) => x.job.id), ids.slice().reverse());
    runner.close();
  });

  it('removing an active job is refused, as BullMQ refuses a locked one, and the run finishes and is billed', async () => {
    let answer = null;
    const billed = [];
    const {runner, ci} = runnerWith((i, cb) => { answer = cb; });
    ci.recordCall = (key) => billed.push(key);
    const {r} = await call(runner, 'addJob', {appKey: 'owner'}, {name: 'busy'}, 'd', 's', 'a', {});
    assert.ok(await until(() => answer != null));
    const refused = await call(runner, 'removeJob', {appKey: 'owner'}, 'busy', r.id, false);
    assert.strictEqual(refused.err.code, 'REMOVE_JOB_ERROR');
    assert.ok(/could not be removed because it is locked by another worker/.test(refused.err.message), refused.err.message);
    answer(null, {});
    assert.ok(await until(async () => (await state(runner, r.id, {appKey: 'owner'})).state === 'completed'));
    assert.deepStrictEqual(billed, ['owner']);
    runner.close();
  });

  it('a synchronous throw from invokeJobs fails the run', async () => {
    const {runner} = runnerWith(() => { throw new Error('module state bug'); });
    const {r} = await call(runner, 'addJob', INTERNAL, {name: 'throw'}, 'd', 's', 'a', {});
    assert.ok(await until(async () => (await state(runner, r.id)).state === 'failed'));
    assert.strictEqual((await state(runner, r.id)).job.failedReason, 'module state bug');
    runner.close();
  });

  it('a cleared timer is forgotten, so removed jobs leave nothing behind', async () => {
    const {runner} = runnerWith(() => {});
    const before = runner.pendingTimers();
    for (let i = 0; i < 20; i++) {
      const {r} = await call(runner, 'addJob', INTERNAL, {name: `c${i}`, delay: 60000}, 'd', 's', 'a', {});
      await call(runner, 'removeJob', INTERNAL, `c${i}`, r.id, false);
    }
    assert.strictEqual(runner.pendingTimers(), before);
    runner.close();
  });

  it('--jobResultTtl 0 keeps a finished job (0 means no expiry, as --jobTimeout 0 does)', async () => {
    const {runner} = runnerWith((i, cb) => setImmediate(cb, null, {}), {resultTtlMs: 0});
    const {r} = await call(runner, 'addJob', INTERNAL, {name: 'keep'}, 'd', 's', 'a', {});
    assert.ok(await until(async () => (await state(runner, r.id)).state === 'completed'));
    await wait(200);
    assert.strictEqual((await state(runner, r.id)).state, 'completed');
    runner.close();
  });

  it('the job history names its owner by fingerprint, never the key, and still finds the owner\'s runs', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const LocalKv = require('../../lib/local-kv');
    const redisAPI = require('../../lib/redis-api');
    const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-jobs-local-01-'));
    const kv = new LocalKv({storePath});
    const saved = redisAPI.client;
    redisAPI.client = kv;
    try {
      const {runner} = runnerWith((i, cb) => setImmediate(cb, null, {}));
      const {r} = await call(runner, 'addJob', {appKey: 'secret-owner-key-1'}, {name: 'hist'}, 'd', 's', 'a', {});
      assert.ok(await until(async () => (await state(runner, r.id, {appKey: 'secret-owner-key-1'})).state === 'completed'));
      const mine = (await call(runner, 'getJobHistory', {appKey: 'secret-owner-key-1'}, 'hist')).r;
      const theirs = (await call(runner, 'getJobHistory', {appKey: 'someone-else'}, 'hist')).r;
      assert.ok(mine.length >= 1);
      assert.strictEqual(theirs.length, 0);
      runner.close();
      kv.close();
      assert.ok(!fs.readFileSync(path.join(storePath, 'kv.json'), 'utf8').includes('secret-owner-key-1'));
    } finally {
      redisAPI.client = saved;
    }
  });

  it('the local runner loads no Redis client library', () => {
    const {spawnSync} = require('child_process');
    const run = spawnSync(process.execPath, ['-e', `
      require(${JSON.stringify(require.resolve('../../lib/job-control-local'))});
      require(${JSON.stringify(require.resolve('../../lib/metering/local-provider'))});
      process.stdout.write(JSON.stringify(Object.keys(require.cache).filter((f) => /node_modules[\\\\/](redis|ioredis|bullmq)[\\\\/]/.test(f)).length));
    `], {encoding: 'utf8', timeout: 20000});
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stdout, '0');
  });
});

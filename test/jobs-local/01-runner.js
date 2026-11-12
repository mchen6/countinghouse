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

  it('removing an active job cancels it and forgets it', async () => {
    let cancelled = null;
    const {runner} = runnerWith((i, cb, isCancelled) => { cancelled = isCancelled; });
    const {r} = await call(runner, 'addJob', INTERNAL, {name: 'x'}, 'd', 's', 'a', {});
    assert.ok(await until(async () => cancelled != null));
    assert.deepStrictEqual((await call(runner, 'removeJob', INTERNAL, 'x', r.id, false)).r, {removed: true});
    assert.strictEqual(cancelled(), true);
    assert.strictEqual((await call(runner, 'getJob', INTERNAL, r.id)).err.message, new (require('../../lib/countinghouse-error').CountinghouseError)('GET_JOB_ERROR', 'unknown job').message);
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

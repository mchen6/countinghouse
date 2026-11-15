'use strict';
// B1 Task 3, through the local job runner (lib/job-control-local.js) with a
// stub cdifInterface, as jobs-local 01 drives it: a job made in a session
// has its session kept in memory (lib/job-sessions.js) before its first run,
// never in its data; each run's bookkeeping (invokeJobs' extraArgs, the
// main thread's, which lib/job-args.js keeps from the worker) carries the
// session and its values; a one-off job's entry ends with its last run or
// its removal, a scheduler's with the scheduler.
const assert = require('assert');
const {createRunner} = require('../../lib/job-control-local');
const {INTERNAL} = require('../../lib/job-control-common');
const jobSessions = require('../../lib/job-sessions');
const options = require('../../lib/cli-options');

const A = 'a'.repeat(32);
async function until(check, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return false;
}
const call = (runner, method, ...args) => new Promise((resolve) => runner[method](...args, (err, r) => resolve({err, r})));
function runnerWith(answer) {
  const calls = [];
  const ci = {recordCall: (k, t, c, cb) => cb && cb(null),
    invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => { calls.push({jobID, extraArgs}); return answer(callback); }};
  const runner = createRunner({jobTimeoutMs: 0});
  runner.authorizeRun = () => Promise.resolve();
  runner.initJobProcess(ci);
  return {runner, calls};
}
const ok = (cb) => setImmediate(cb, null, {ok: 1});

describe('sessions 05: a job\'s session through the local runner (B1 Task 3)', function() {
  this.timeout(20000);
  let saved;
  beforeEach(() => {
    jobSessions.resetForTests();
    saved = {workerThread: options.workerThread, maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
    options.workerThread = true;
  });
  afterEach(() => Object.assign(options, saved));
  const IN_A = {appKey: 'k', session: A};

  it('a one-off job: its run carries the session, its data does not, and its entry ends with its last run', async () => {
    const {runner, calls} = runnerWith(ok);
    const {r} = await call(runner, 'addJob', IN_A, {name: 'n'}, 'dev', 'svc', 'act', {a: 1});
    assert.strictEqual(jobSessions.size(), 1);
    assert.ok(await until(async () => (await call(runner, 'getJob', INTERNAL, r.id)).r.state === 'completed'));
    assert.strictEqual(calls[0].extraArgs.session, A);
    const rec = (await call(runner, 'getJob', INTERNAL, r.id)).r;
    assert.deepStrictEqual(Object.keys(rec.job.data).filter((k) => /session/i.test(k)), [], 'never in its data');
    assert.ok(!JSON.stringify(rec).includes(A), 'nor anywhere in its record');
    assert.strictEqual(jobSessions.size(), 0, 'forgotten after its last run');
    runner.close();
  });

  it('a run after its session ended with a loosening runs at the defaults; one with a tightening stays tight', async () => {
    options.maxOutputBytes = 1000;
    options.requestTimeout = 5000;
    for (const [last, want] of [[{maxOutputBytes: 9000, requestTimeout: 60000}, {maxOutputBytes: 1000, requestTimeout: 5000}],
      [{maxOutputBytes: 300, requestTimeout: 60000}, {maxOutputBytes: 300, requestTimeout: 5000}]]) {
      jobSessions.resetForTests();
      const {runner, calls} = runnerWith(ok);
      const {r} = await call(runner, 'addJob', IN_A, {name: 'n', delay: 50}, 'dev', 'svc', 'act', {});
      jobSessions.sessionEnded(A, last);   // before its delayed run (A was never live here: ended)
      assert.ok(await until(async () => (await call(runner, 'getJob', INTERNAL, r.id)).r.state === 'completed'));
      assert.strictEqual(calls[0].extraArgs.session, A);
      assert.strictEqual(calls[0].extraArgs.limits.bound, 'defaults', 'bounded by the defaults at each check, never pinned');
      assert.deepStrictEqual(require('../../lib/call-limits').of({limits: calls[0].extraArgs.limits}), want);
      runner.close();
    }
  });

  it('a repeating job: every run carries the session; removing its scheduler ends the entry', async () => {
    const {runner, calls} = runnerWith(ok);
    const {MIN_REPEAT_EVERY_MS} = require('../../lib/job-control-common');
    const added = await call(runner, 'addJob', IN_A, {name: 'rep', repeat: {every: MIN_REPEAT_EVERY_MS, limit: 3}}, 'dev', 'svc', 'act', {});
    assert.ifError(added.err);
    assert.ok(await until(() => calls.length >= 2, MIN_REPEAT_EVERY_MS * 3));
    assert.deepStrictEqual(calls.map((c) => c.extraArgs.session), calls.map(() => A));
    assert.strictEqual(jobSessions.size(), 1);
    const removed = await call(runner, 'removeJob', IN_A, 'rep', null, true);
    assert.ifError(removed.err);
    assert.strictEqual(jobSessions.size(), 0);
    runner.close();
  });

  it('a scheduler that has run its repeat limit ends its entry; close() ends every entry it held', async () => {
    const {MIN_REPEAT_EVERY_MS} = require('../../lib/job-control-common');
    const {runner, calls} = runnerWith(ok);
    assert.ifError((await call(runner, 'addJob', IN_A, {name: 'once', repeat: {every: MIN_REPEAT_EVERY_MS, limit: 1}}, 'dev', 'svc', 'act', {})).err);
    assert.ok(await until(() => calls.length >= 1));
    assert.ok(await until(() => jobSessions.size() === 0), 'forgotten after its last run');
    assert.ifError((await call(runner, 'addJob', IN_A, {name: 'later', delay: 5000}, 'dev', 'svc', 'act', {})).err);
    assert.ifError((await call(runner, 'addJob', IN_A, {name: 'rep', repeat: {every: 60000}}, 'dev', 'svc', 'act', {})).err);
    assert.strictEqual(jobSessions.size(), 2);
    runner.close();
    assert.strictEqual(jobSessions.size(), 0);
  });

  it('removing a limited scheduler\'s last pending run ends its entry; a re-upsert from no session keeps an ended tightening', async () => {
    const {MIN_REPEAT_EVERY_MS} = require('../../lib/job-control-common');
    const {runner, calls} = runnerWith(ok);
    // limit 1, at a cron time ahead: its one (and last) run is pending now
    assert.ifError((await call(runner, 'addJob', IN_A, {name: 'two', repeat: {cron: '0 0 1 1 *', limit: 1}}, 'dev', 'svc', 'act', {})).err);
    const last = (await call(runner, 'listJobs', INTERNAL)).r.find((e) => e.state === 'delayed' || e.state === 'waiting');
    assert.ok(last != null, 'the second run is pending');
    assert.strictEqual(jobSessions.size(), 1);
    assert.ifError((await call(runner, 'removeJob', IN_A, 'two', last.job.id, false)).err);
    assert.strictEqual(jobSessions.size(), 0, 'its last pending run gone: the scheduler is done');
    // re-upsert from no session of an ended session's scheduler
    jobSessions.resetForTests();
    options.maxOutputBytes = 1000;
    options.requestTimeout = 5000;
    assert.ifError((await call(runner, 'addJob', IN_A, {name: 'rep', repeat: {every: MIN_REPEAT_EVERY_MS * 60}}, 'dev', 'svc', 'act', {})).err);
    jobSessions.sessionEnded(A, {maxOutputBytes: 300, requestTimeout: 60000});
    assert.ifError((await call(runner, 'addJob', {appKey: 'k'}, {name: 'rep', repeat: {every: MIN_REPEAT_EVERY_MS * 60}}, 'dev', 'svc', 'act', {})).err);
    const {schedulerId} = require('../../lib/job-control-common');
    assert.strictEqual(require('../../lib/call-limits').of({limits: jobSessions.forRun(schedulerId({appKey: 'k'}, 'rep')).limits}).maxOutputBytes, 300, 'never looser than it was');
    runner.close();
  });

  it('a delayed job removed before it runs ends its entry; a job from no session has none', async () => {
    const {runner, calls} = runnerWith(ok);
    const {r} = await call(runner, 'addJob', IN_A, {name: 'n', delay: 5000}, 'dev', 'svc', 'act', {});
    assert.strictEqual(jobSessions.size(), 1);
    assert.ifError((await call(runner, 'removeJob', IN_A, 'n', r.id, false)).err);
    assert.strictEqual(jobSessions.size(), 0);
    const plain = await call(runner, 'addJob', {appKey: 'k'}, {name: 'p'}, 'dev', 'svc', 'act', {});
    assert.ok(await until(async () => (await call(runner, 'getJob', INTERNAL, plain.r.id)).r.state === 'completed'));
    assert.ok(!('session' in calls[0].extraArgs) && !('limits' in calls[0].extraArgs));
    assert.strictEqual(jobSessions.size(), 0);
    runner.close();
  });
});

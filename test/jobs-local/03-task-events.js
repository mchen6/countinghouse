'use strict';
// MCP completeness M16, Task 1: the local runner tells lib/task-events.js a
// 2026-07-28 task's changes (its run started, its progress, completed,
// failed for good, removed), and nothing for any other job. Server-free,
// as jobs-local 01: the runner's surface with a stub cdifInterface and the
// owner check stubbed.
const assert = require('assert');
const {createRunner} = require('../../lib/job-control-local');
const {INTERNAL} = require('../../lib/job-control-common');
const taskEvents = require('../../lib/task-events');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await wait(20); }
  return false;
}
const add = (runner, opts) => new Promise((resolve) => runner.addJob(INTERNAL, opts, 'dev', 'svc', 'act', {}, (err, r) => resolve({err, r})));
const remove = (runner, id) => new Promise((resolve) => runner.removeJob(INTERNAL, 'n', id, false, (err, r) => resolve({err, r})));
const tid = (c) => `t-${c.repeat(32)}`;
function runnerWith(answer) {
  const ref = {};
  const runner = createRunner({jobTimeoutMs: 0});
  runner.authorizeRun = () => Promise.resolve();
  let n = 0;
  runner.initJobProcess({recordCall: (k, t, c, cb) => cb && cb(null),
    invokeJobs: (d, s, a, input, jobID, callback) => answer(n++, callback, jobID, ref.runner)});
  ref.runner = runner;
  return runner;
}

describe('jobs-local 03: the local runner tells a 2026-07-28 task\'s changes (M16 Task 1)', function() {
  this.timeout(20000);
  const options = require('../../lib/cli-options');
  let workerThread;
  let seen;
  let off;
  before(() => { workerThread = options.workerThread; options.workerThread = true; });
  after(() => { options.workerThread = workerThread; });
  beforeEach(() => { seen = []; off = taskEvents.on((id, kind) => seen.push(`${id.slice(0, 3)} ${kind}`)); });
  afterEach(() => off());

  it('a task\'s run: active, each progress, completed', async () => {
    const runner = runnerWith((i, cb, jobID, r) => { r.updateJobProgress(jobID, 10); r.updateJobProgress(jobID, 90); setTimeout(cb, 20, null, {}); });
    const {err, r} = await add(runner, {name: 'n', taskId: tid('a'), era: 'modern'});
    assert.strictEqual(err, null);
    assert.strictEqual(r.id, tid('a'));
    assert.ok(await until(() => seen.includes('t-a completed')), JSON.stringify(seen));
    assert.deepStrictEqual(seen, ['t-a active', 't-a progress', 't-a progress', 't-a completed']);
    runner.close();
  });

  it('a task whose run fails is told failed once, for good: a retried attempt is still working', async () => {
    const runner = runnerWith((i, cb) => setImmediate(cb, Object.assign(new Error('no'), {code: 'X'})));
    await add(runner, {name: 'n', taskId: tid('b'), era: 'modern', attempts: 2});
    assert.ok(await until(() => seen.includes('t-b failed')), JSON.stringify(seen));
    await wait(100);
    assert.deepStrictEqual(seen, ['t-b active', 't-b active', 't-b failed']);
    runner.close();
  });

  it('a task removed before its run (its owner\'s cancel) is told removed, and never runs', async () => {
    const runner = runnerWith(() => assert.fail('it never runs'));
    await add(runner, {name: 'n', taskId: tid('c'), era: 'modern', delay: 5000});
    const {err} = await remove(runner, tid('c'));
    assert.strictEqual(err, null);
    assert.deepStrictEqual(seen, ['t-c removed']);
    runner.close();
  });

  it('any other job is never told: the runner\'s own id, its progress, its end', async () => {
    const runner = runnerWith((i, cb, jobID, r) => { r.updateJobProgress(jobID, 50); setImmediate(cb, i === 0 ? null : new Error('no'), {}); });
    const one = (await add(runner, {name: 'n'})).r;
    const two = (await add(runner, {name: 'n'})).r;
    const state = (id) => new Promise((resolve) => runner.getJob(INTERNAL, id, (e, rec) => resolve(rec && rec.state)));
    assert.ok(await until(async () => (await state(one.id)) === 'completed' && (await state(two.id)) === 'failed'));
    assert.deepStrictEqual(seen, []);
    runner.close();
  });

  it('a listener that throws is logged; the runner and the other listeners go on', async () => {
    const LOG = require('../../lib/logger');
    const realE = LOG.E;
    const logged = [];
    LOG.E = (e) => logged.push(e);
    const offBad = taskEvents.on(() => { throw new Error('a bad listener'); });
    try {
      const runner = runnerWith((i, cb) => setImmediate(cb, null, {}));
      await add(runner, {name: 'n', taskId: tid('d'), era: 'modern'});
      assert.ok(await until(() => seen.includes('t-d completed')), JSON.stringify(seen));
      assert.ok(logged.length >= 2 && logged.every((e) => /a bad listener/.test(e.message)), String(logged));
      runner.close();
    } finally {
      offBad();
      LOG.E = realE;
    }
  });

  it('an unknown kind is a programming error, thrown at once', () => {
    assert.throws(() => taskEvents.emit(tid('e'), 'finished'), /unknown kind finished/);
  });
});

'use strict';
// MCP completeness M16, Task 1: the local runner tells lib/task-events.js a
// 2026-07-28 task's changes (its run started, its progress, completed,
// failed for good, waiting on its question), and nothing for any other job.
// A removal is not one: the gateway tells a cancel. A question's wait that
// ends is told by task-events itself. Server-free,
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

  // a removal is the gateway's to tell, as cancelled, once the task's
  // tombstone is written: told here, a listener's lookup could find neither
  it('a task removed before its run (its owner\'s cancel) is told nothing by the runner, and never runs', async () => {
    const runner = runnerWith(() => assert.fail('it never runs'));
    await add(runner, {name: 'n', taskId: tid('c'), era: 'modern', delay: 5000});
    const {err} = await remove(runner, tid('c'));
    assert.strictEqual(err, null);
    await wait(50);
    assert.deepStrictEqual(seen, []);
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

  // M22's question (lib/task-asks.js), its hooks stood in for: a pass that
  // ends ASK_PENDING with a question pending waits; an answer runs it again
  describe('a task that asks its user (M22)', () => {
    const taskAsks = require('../../lib/task-asks');
    const records = new Map();
    before(() => taskAsks.configure({kv: () => ({get: (k, cb) => setImmediate(cb, null, records.has(k) ? JSON.stringify(records.get(k)) : null)})}));
    after(() => taskAsks.configure({kv: () => require('../../lib/store').getStore().kv}));
    afterEach(() => records.clear());
    const pending = {state: {pending: {qKey: 'q'}}};
    function asking(passes) {
      const runner = runnerWith((i, cb) => setImmediate(cb, i === 0 ? Object.assign(new Error('asked'), {code: 'ASK_PENDING'}) : null, {}));
      let n = 0;
      runner.setAskHooks({before: () => Promise.resolve(passes[n++] || null), asked: () => Promise.resolve({asked: {}}),
        settled: () => Promise.resolve(), holdMs: () => 60000});
      return runner;
    }

    it('its pass that asked is told input_required (never completed); answered, it runs again: active, completed', async () => {
      const runner = asking([pending, {state: {pending: null}}]);
      await add(runner, {name: 'n', taskId: tid('f'), era: 'modern', asks: true});
      assert.ok(await until(() => seen.includes('t-f input_required')), JSON.stringify(seen));
      await wait(50);
      assert.deepStrictEqual(seen, ['t-f active', 't-f input_required']);
      assert.strictEqual(await runner.rerunTask(tid('f')), true);
      assert.ok(await until(() => seen.includes('t-f completed')), JSON.stringify(seen));
      assert.deepStrictEqual(seen, ['t-f active', 't-f input_required', 't-f active', 't-f completed']);
      assert.strictEqual(taskEvents.pendingWaits(), 0, 'no record: no wait timed; and done, none left');
      runner.close();
    });

    it('run again with its question unanswered (skip): back to input_required, nothing run', async () => {
      const runner = asking([pending, {skip: true}]);
      await add(runner, {name: 'n', taskId: tid('1'), era: 'modern', asks: true});
      assert.ok(await until(() => seen.includes('t-1 input_required')), JSON.stringify(seen));
      await runner.rerunTask(tid('1'));
      assert.ok(await until(() => seen.length === 4), JSON.stringify(seen));
      await wait(50);
      assert.deepStrictEqual(seen, ['t-1 active', 't-1 input_required', 't-1 active', 't-1 input_required']);
      runner.close();
    });

    it('its question\'s wait ends unseen (ASK_EXPIRED is read, never written): told failed at the record\'s expiresAt, once', async () => {
      records.set(`task-ask:${tid('2')}`, {owner: 'o', expiresAt: Date.now() + 80});
      taskEvents.emit(tid('2'), 'input_required');
      assert.ok(await until(() => taskEvents.pendingWaits() === 1));
      await wait(30);
      assert.deepStrictEqual(seen, ['t-2 input_required'], 'not before its wait ends');
      assert.ok(await until(() => seen.includes('t-2 failed')), JSON.stringify(seen));
      await wait(100);
      assert.deepStrictEqual(seen, ['t-2 input_required', 't-2 failed']);
      assert.strictEqual(taskEvents.pendingWaits(), 0);
    });

    it('any later kind clears the wait: answered (active), cancelled; a gone record times nothing', async () => {
      for (const [c, later] of [['3', 'active'], ['4', 'cancelled']]) {
        records.set(`task-ask:${tid(c)}`, {owner: 'o', expiresAt: Date.now() + 80});
        taskEvents.emit(tid(c), 'input_required');
        assert.ok(await until(() => taskEvents.pendingWaits() === 1));
        taskEvents.emit(tid(c), later);
        assert.strictEqual(taskEvents.pendingWaits(), 0);
      }
      // cleared before its record was read: the read that lands after times nothing
      records.set(`task-ask:${tid('5')}`, {owner: 'o', expiresAt: Date.now() + 80});
      taskEvents.emit(tid('5'), 'input_required');
      taskEvents.emit(tid('5'), 'active');
      taskEvents.emit(tid('6'), 'input_required');   // no record
      await wait(200);
      assert.deepStrictEqual(seen, ['t-3 input_required', 't-3 active', 't-4 input_required', 't-4 cancelled',
        't-5 input_required', 't-5 active', 't-6 input_required']);
      assert.strictEqual(taskEvents.pendingWaits(), 0);
    });
  });

  it('an unknown kind is a programming error, thrown at once', () => {
    assert.throws(() => taskEvents.emit(tid('e'), 'finished'), /unknown kind finished/);
  });
});

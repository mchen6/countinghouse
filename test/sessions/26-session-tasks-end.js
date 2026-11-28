'use strict';
// Shared runtime B5, Task 4 (docs/superpowers/plans/2026-11-16-shared-runtime-b5-session-views.md):
// an ended session's tasks are cancelled (the reviewer's ruling, 2026-11-15:
// nothing runs that no one can read). At the session's end (its bye, or its
// reconnect window running out; lib/sessions.js close) the local runner's
// cancelSession takes every job of that session:
//   - waiting or delayed: removed, as removeJob removes one; it never runs and costs nothing;
//   - active: it runs to its end (cooperative, as tasks/cancel), is billed and
//     recorded under the session's id, is not retried, and its record goes when it finishes;
//   - finished: its record and result go now.
// It fires only at a session's real end, as R1 removes its partitions: its
// shim's bye, or its reconnect window running out. The runtime stopping
// ('closed'), a connection that never settled ('unsettled') and a detach
// cancel nothing. A job of no session, or another session's, is untouched. Server-free: the local runner with a stub interface, real shared sessions.
const assert = require('assert');
const EventEmitter = require('events');
const options = require('../../lib/cli-options');
const {createRunner} = require('../../lib/job-control-local');
const {INTERNAL} = require('../../lib/job-control-common');
const jobSessions = require('../../lib/job-sessions');
const sessions = require('../../lib/sessions');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const call = (runner, method, ...args) => new Promise((resolve) => runner[method](...args, (err, r) => resolve({err, r})));
async function until(check, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return false;
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('sessions 26: an ended session\'s tasks are cancelled (shared runtime B5, Task 4)', function() {
  // (its jobs' owners known to the identity index, as a server's: B-meter-keys (2))
  require('../helpers/identity-scope').useIdentity(['k']);
  this.timeout(20000);
  let saved;
  let runner;
  let invoked;     // input.tag of every run sent to a worker
  let charged;     // the charges made (recordCall)
  let recorded;    // the completion hook's calls: {tag, session, error}
  let gates;       // tag -> {open(err?)}: a run whose input says wait waits for its gate
  let reg;
  let sources;
  const IN = (session, over = {}) => Object.assign({appKey: 'k', isAdmin: false, session}, over);
  const open = (id) => { const s = new EventEmitter(); s.id = id; s.client = {status: 'ok', conditions: 'yes', repo: null}; s.notify = () => {}; s.record = () => {}; s.forget = () => {}; sources[id] = s; reg.emit('session', s); return s; };
  const gate = (tag) => {
    let release;
    const p = new Promise((r) => { release = r; });
    gates[tag] = {p, open: (err = null) => release(err)};
    return gates[tag];
  };
  const stubCi = () => ({
    recordCall: (k, t, c, cb) => { charged.push(t); if (cb) cb(null); },
    invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback) => {
      invoked.push(input.tag);
      const g = gates[input.tag];
      if (g == null) return setImmediate(callback, null, {output: {ok: input.tag}});
      return g.p.then((err) => setImmediate(callback, err, err == null ? {output: {ok: input.tag}} : null));
    }
  });
  const newRunner = () => {
    const r = createRunner({jobTimeoutMs: 0});
    r.authorizeRun = require('../helpers/identity-scope').authorizedRun;
    r.initJobProcess(stubCi());
    // the session a run's usage is recorded under: the start hook's (as lib/mcp/gateway.js jobHooks: usage.start)
    r.setStartHook((data, session) => ({session}));
    r.setCompletionHook((data, results, run = {}) => { recorded.push({tag: data.input.tag, session: run.extra != null ? run.extra.session : null, error: run.error != null}); return null; });
    return r;
  };
  beforeEach(() => {
    saved = {workerThread: options.workerThread};
    options.workerThread = true;
    jobSessions.resetForTests();
    sessions.resetForTests();
    invoked = [];
    charged = [];
    recorded = [];
    gates = {};
    reg = new EventEmitter();
    sessions.attach(reg);
    sources = {};
    for (const id of [A, B]) open(id);
    runner = newRunner();
  });
  afterEach(() => {
    for (const g of Object.values(gates)) g.open();
    runner.close();
    Object.assign(options, saved);
    sessions.resetForTests();
    jobSessions.resetForTests();
  });
  const add = async(ctx, tag, opts = {}) => (await call(runner, 'addJob', ctx, Object.assign({name: 'n'}, opts), 'dev', 'svc', 'act', {tag})).r.id;
  const ids = async(ctx) => (await call(runner, 'listJobs', ctx)).r.map((x) => x.job.id).sort();
  const stateOf = async(id) => { const g = await call(runner, 'getJob', INTERNAL, id); return g.err != null ? 'gone' : g.r.state; };
  // A: one delayed, one active (waiting at its gate), one completed
  const three = async() => {
    const completed = await add(IN(A), 'done');
    assert.ok(await until(async() => (await stateOf(completed)) === 'completed'));
    gate('active');
    const active = await add(IN(A), 'active', {attempts: 3});
    assert.ok(await until(async() => invoked.includes('active')));
    const delayed = await add(IN(A), 'later', {delay: 60 * 60 * 1000});
    assert.strictEqual(await stateOf(delayed), 'delayed');
    return {completed, active, delayed};
  };

  describe('the runner\'s cancelSession', () => {
    it('A\'s delayed task is removed and never runs; its finished one goes now; its active one runs to its end, billed once under A, then goes', async() => {
      const {completed, active, delayed} = await three();
      const chargedBefore = charged.length;
      assert.deepStrictEqual(runner.cancelSession(A), {removed: 2, finishing: 1});
      assert.strictEqual(await stateOf(delayed), 'gone');
      assert.strictEqual(await stateOf(completed), 'gone', 'its record and result, now');
      assert.strictEqual(await stateOf(active), 'active', 'not interrupted');
      gates.active.open();
      assert.ok(await until(async() => (await stateOf(active)) === 'gone'), 'gone once it finishes');
      assert.deepStrictEqual(charged.length - chargedBefore, 1, 'billed once');
      assert.deepStrictEqual(recorded.filter((x) => x.tag === 'active'), [{tag: 'active', session: A, error: false}], 'recorded under A');
      assert.deepStrictEqual(invoked.filter((t) => t === 'later'), [], 'the delayed one never ran');
      assert.deepStrictEqual(await ids(INTERNAL), []);
      assert.strictEqual(jobSessions.entryOf(active), null, 'no job-sessions entry of A\'s');
      assert.strictEqual(jobSessions.entryOf(delayed), null);
    });

    it('an active task that fails after its session\'s end is not retried, and goes', async() => {
      gate('active');
      const active = await add(IN(A), 'active', {attempts: 3});
      assert.ok(await until(async() => invoked.includes('active')));
      runner.cancelSession(A);
      gates.active.open(new Error('it failed'));
      assert.ok(await until(async() => (await stateOf(active)) === 'gone'));
      await tick();
      assert.deepStrictEqual(invoked.filter((t) => t === 'active'), ['active'], 'one run, no retry');
      assert.deepStrictEqual(recorded.filter((x) => x.tag === 'active'), [{tag: 'active', session: A, error: true}]);
    });

    it('an active task its session ended under before it reached a worker never starts', async() => {
      let authorize;
      runner.authorizeRun = (job) => new Promise((r) => { authorize = r; }).then(() => require('../helpers/identity-scope').authorizedRun(job));
      const held = await add(IN(A), 'held');
      assert.ok(await until(async() => authorize != null));
      assert.strictEqual(await stateOf(held), 'active');
      assert.deepStrictEqual(runner.cancelSession(A), {removed: 0, finishing: 1});
      authorize();
      assert.ok(await until(async() => (await stateOf(held)) === 'gone'));
      assert.deepStrictEqual(invoked, [], 'never sent');
      assert.strictEqual(jobSessions.entryOf(held), null);
    });

    it('B\'s tasks and a task of no session are untouched; a scheduler of A\'s is stopped', async() => {
      await three();
      const ofB = await add(IN(B), 'b');
      const none = await add(INTERNAL, 'internal', {delay: 60 * 60 * 1000});
      const sched = await add(IN(A), 'tick', {repeat: {every: 60 * 60 * 1000}, delay: 0});
      assert.ok(await until(async() => (await stateOf(ofB)) === 'completed'));
      runner.cancelSession(A);
      gates.active.open();
      assert.ok(await until(async() => (await ids(INTERNAL)).length === 2));
      assert.deepStrictEqual(await ids(INTERNAL), [ofB, none].sort());
      assert.strictEqual(await stateOf(sched), 'gone');
      // the scheduler too: its next run is never made
      assert.strictEqual((await call(runner, 'removeJob', IN(A), 'n', null, true)).err.code, 'JOB_NOT_FOUND');
    });
  });

  describe('at the session\'s end (lib/sessions.js close)', () => {
    let savedStore;
    let local;
    beforeEach(() => {
      savedStore = options.store;
      options.store = 'local';
      // the store's runner (lib/store.js jobs, local): the module's own
      local = require('../../lib/job-control-local');
      local.authorizeRun = require('../helpers/identity-scope').authorizedRun;
      local.initJobProcess(stubCi());
      local.setStartHook((data, session) => ({session}));
      local.setCompletionHook(() => null);
      runner.close();
      runner = local;
    });
    afterEach(async() => {
      for (const g of Object.values(gates)) g.open();
      await until(async() => { for (const id of await ids(INTERNAL)) if ((await stateOf(id)) === 'active') return false; return true; });
      for (const id of await ids(INTERNAL)) await call(local, 'removeJob', INTERNAL, 'n', id, false);
      options.store = savedStore;
      runner = newRunner();   // the outer afterEach closes this one, never the module's
    });

    it('A ends (bye): its tasks are cancelled; B\'s are not', async() => {
      const {completed, delayed, active} = await three();
      const ofB = await add(IN(B), 'b', {delay: 60 * 60 * 1000});
      sources[A].emit('end', 'bye');
      assert.strictEqual(await stateOf(delayed), 'gone');
      assert.strictEqual(await stateOf(completed), 'gone');
      assert.strictEqual(await stateOf(ofB), 'delayed', 'B\'s');
      gates.active.open();
      assert.ok(await until(async() => (await stateOf(active)) === 'gone'));
      // a session that comes later gets unknown for each of A's ids
      open(C);
      for (const id of [completed, delayed, active]) assert.strictEqual((await call(runner, 'getJob', IN(C), id)).err.code, 'JOB_NOT_FOUND');
    });

    it('its reconnect window running out (\'window\') is an end too', async() => {
      const delayed = await add(IN(A), 'later', {delay: 60 * 60 * 1000});
      sources[A].emit('end', 'window');
      assert.strictEqual(await stateOf(delayed), 'gone');
    });

    for (const reason of ['closed', 'unsettled']) {
      it(`a '${reason}' end cancels nothing: A's delayed task still runs once A resumes, and A reads it`, async() => {
        const delayed = await add(IN(A), 'soon', {delay: 300});
        sources[A].emit('end', reason);
        assert.strictEqual(await stateOf(delayed), 'delayed', 'kept');
        open(A);   // resumed (a runtime restart's restore keeps its id)
        assert.ok(await until(async() => (await stateOf(delayed)) === 'completed'), 'it ran');
        assert.deepStrictEqual(invoked.filter((x) => x === 'soon'), ['soon']);
        const got = await call(runner, 'getJob', IN(A), delayed);
        assert.ifError(got.err);
        assert.deepStrictEqual(got.r.job.returnvalue, {output: {ok: 'soon'}});
      });
    }

    it('a detach cancels nothing: A resumes with all three and reads its completed one\'s result', async() => {
      const {completed, delayed, active} = await three();
      sources[A].emit('detach');
      sources[A].emit('attach');
      for (const id of [completed, delayed, active]) assert.notStrictEqual(await stateOf(id), 'gone');
      const got = await call(runner, 'getJob', IN(A), completed);
      assert.ifError(got.err);
      assert.deepStrictEqual(got.r.job.returnvalue, {output: {ok: 'done'}});
    });
  });
});

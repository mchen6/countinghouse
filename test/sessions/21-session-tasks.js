'use strict';
// Shared runtime B5, Task 2 (docs/superpowers/plans/2026-11-16-shared-runtime-b5-session-views.md):
// tasks by key and session. In a shared runtime every session has the user's
// one key, so the owner-key check alone let one session read, list and
// cancel another's tasks. A job remembers its owner session (in memory,
// never in its data or its record); getJob, removeJob and listJobs ask the
// scope rule (lib/session-scope.js, through job-control-common seesJob)
// before the owner check, and a job the caller's session doesn't see is
// answered as an id never issued. A job made in a session has an id of its
// own kind ('s-' and 32 hex), or M15's minted 't-' id. Server-free: the
// local runner with a stub interface, real shared sessions.
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

describe('sessions 21: tasks by key and session (shared runtime B5, Task 2)', function() {
  this.timeout(20000);
  let saved;
  let runner;
  let release;      // the stub module's run waits for this
  const IN = (session, over = {}) => Object.assign({appKey: 'k', isAdmin: false, session}, over);
  const shared = () => {
    const reg = new EventEmitter();
    sessions.attach(reg);
    for (const id of [A, B, C]) { const s = new EventEmitter(); s.id = id; s.client = {status: 'ok', conditions: 'yes', repo: null}; s.notify = () => {}; reg.emit('session', s); }
  };
  beforeEach(() => {
    saved = {workerThread: options.workerThread};
    options.workerThread = true;
    jobSessions.resetForTests();
    sessions.resetForTests();
    let open;
    release = new Promise((r) => { open = r; });
    release.open = open;
    const ci = {recordCall: (k, t, c, cb) => cb && cb(null),
      invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback) => { release.then(() => setImmediate(callback, null, {output: {ok: 1}})); }};
    runner = createRunner({jobTimeoutMs: 0});
    runner.authorizeRun = () => Promise.resolve();
    runner.initJobProcess(ci);
  });
  afterEach(() => { runner.close(); Object.assign(options, saved); sessions.resetForTests(); jobSessions.resetForTests(); });
  const add = async(ctx, opts = {}) => (await call(runner, 'addJob', ctx, Object.assign({name: 'n'}, opts), 'dev', 'svc', 'act', {}));

  describe('the id', () => {
    it('in a shared runtime\'s session: s- and 32 hex, each its own; outside shared mode the runner\'s counting id, as before', async() => {
      shared();
      const one = (await add(IN(A))).r.id;
      const two = (await add(IN(A))).r.id;
      assert.match(one, /^s-[0-9a-f]{32}$/);
      assert.notStrictEqual(one, two);
      sessions.resetForTests();
      runner.close();
      runner = createRunner({jobTimeoutMs: 0});
      runner.authorizeRun = () => Promise.resolve();
      runner.initJobProcess({recordCall: (k, t, c, cb) => cb && cb(null), invokeJobs: () => {}});
      assert.strictEqual((await add({appKey: 'k'})).r.id, '1');
    });

    it('M15\'s minted t- id is the job\'s, in shared mode too; one a job already has is refused, the first unchanged', async() => {
      shared();
      const id = `t-${'1'.repeat(32)}`;
      assert.strictEqual((await add(IN(A), {taskId: id, era: 'modern'})).r.id, id);
      const again = await add(IN(B), {taskId: id, era: 'modern'});
      assert.strictEqual(again.err != null && again.err.code, 'ADD_JOB_ERROR');
      // the first, unchanged: still A's, never B's
      assert.ifError((await call(runner, 'getJob', IN(A), id)).err);
      assert.strictEqual((await call(runner, 'getJob', IN(B), id)).err.code, 'JOB_NOT_FOUND');
    });
  });

  describe('the scope: a job another session made is an id never issued', () => {
    const NEVER = `s-${'f'.repeat(32)}`;
    const shape = (e) => JSON.stringify({code: e.code, message: e.message});

    it('B\'s getJob and removeJob of A\'s job answer as a never-issued id\'s, admin or not; A\'s job stays, uncancelled', async() => {
      shared();
      const id = (await add(IN(A))).r.id;
      for (const ctx of [IN(B), IN(B, {isAdmin: true})]) {
        const got = await call(runner, 'getJob', ctx, id);
        const never = await call(runner, 'getJob', ctx, NEVER);
        assert.strictEqual(shape(got.err), shape(never.err), JSON.stringify(got));
        assert.strictEqual(got.err.code, 'JOB_NOT_FOUND');
        const removed = await call(runner, 'removeJob', ctx, 'n', id, false);
        const neverRemoved = await call(runner, 'removeJob', ctx, 'n', NEVER, false);
        assert.strictEqual(shape(removed.err), shape(neverRemoved.err), JSON.stringify(removed));
      }
      const mine = await call(runner, 'getJob', IN(A), id);
      assert.ifError(mine.err);
      assert.ok(mine.r.state !== 'removed' && mine.r.job.data != null);
      // and once it has completed: still unknown to B
      release.open();
      assert.ok(await until(async() => (await call(runner, 'getJob', IN(A), id)).r.state === 'completed'));
      assert.strictEqual((await call(runner, 'getJob', IN(B), id)).err.code, 'JOB_NOT_FOUND');
    });

    it('listJobs: B\'s is empty while A\'s has its job; INTERNAL\'s job is in no session\'s list, and INTERNAL lists every job', async() => {
      shared();
      const id = (await add(IN(A))).r.id;
      const internal = (await add(INTERNAL)).r.id;
      const ids = async(ctx) => (await call(runner, 'listJobs', ctx)).r.map((x) => x.job.id).sort();
      assert.deepStrictEqual(await ids(IN(B)), []);
      assert.deepStrictEqual(await ids(IN(A)), [id]);
      assert.deepStrictEqual(await ids(INTERNAL), [id, internal].sort());
    });

    it('a session that comes after A\'s end gets unknown for A\'s id', async() => {
      shared();
      const id = (await add(IN(A))).r.id;
      assert.strictEqual((await call(runner, 'getJob', IN(C), id)).err.code, 'JOB_NOT_FOUND');
    });

    it('no record or error carries a session id', async() => {
      shared();
      const id = (await add(IN(A))).r.id;
      const rec = (await call(runner, 'getJob', IN(A), id)).r;
      assert.ok(!JSON.stringify(rec).includes(A), 'not in its record');
      assert.ok(!('session' in rec.job), 'the record has no session key');
      assert.ok(!JSON.stringify((await call(runner, 'getJob', IN(B), id)).err).includes(A));
    });

    it('outside shared mode another key\'s job is JOB_NOT_FOUND, as one never issued (post-rel caller 400)', async() => {
      const id = (await add({appKey: 'k'})).r.id;
      assert.strictEqual((await call(runner, 'getJob', {appKey: 'other'}, id)).err.code, 'JOB_NOT_FOUND');
    });
  });

  // the review of #366, L1 and L2: a cancelled 2026-07-28 task's tombstone
  // keeps the canceller's session only as its SHA-256, and findModernTask
  // (exported for M16) matches it by the scope rule, as seesJob judges a job
  describe('the tombstone (M15) and findModernTask', () => {
    const store = require('../../lib/store');
    const tombstones = require('../../lib/task-tombstones');
    const gateway = require('../../lib/mcp/gateway');
    const NO_LIVE = '(no live session)';
    const T = `t-${'2'.repeat(32)}`;
    let kv;
    let savedGetStore;
    let savedStore;
    beforeEach(() => {
      kv = new Map();
      // a tombstone not seen falls through to the runner: the local store's
      // (a shared runtime's), which has no such job
      savedStore = options.store;
      options.store = 'local';
      const real = store.getStore();
      savedGetStore = store.getStore;
      const fakeKv = {set: (key, value, ...rest) => { kv.set(key, value); rest[rest.length - 1](null); }, get: (key, cb) => cb(null, kv.has(key) ? kv.get(key) : null)};
      // the tombstones' kv (lib/task-tombstones.js reads store.getStore().kv)
      store.getStore = () => new Proxy(real, {get: (target, k) => (k === 'kv' ? fakeKv : target[k])});
    });
    afterEach(() => { store.getStore = savedGetStore; options.store = savedStore; });
    const put = (session) => tombstones.put(T, {owner: require('../../lib/key-fingerprint').meterId('k'), session, createdAt: '2026-11-17T00:00:00.000Z'}, 60000);
    const find = (session) => gateway.findModernTask({appKey: 'k', isAdmin: false, session}, T);

    it('L1: the stored tombstone has the session\'s SHA-256, never its id', async() => {
      shared();
      await put(A);
      const raw = kv.get(`task-tombstone:${T}`);
      assert.ok(!raw.includes(A), raw);
      assert.strictEqual(JSON.parse(raw).session, require('crypto').createHash('sha256').update(A).digest('hex'));
    });

    it('L2: in shared mode A finds its own; B, an unset session and NO_LIVE_SESSION find nothing', async() => {
      shared();
      await put(A);
      const found = await find(A);
      assert.ok(found != null && found.tombstone != null, 'A\'s');
      for (const other of [B, undefined, null, NO_LIVE, '']) assert.strictEqual(await find(other), null, `${other}`);
    });

    it('L2: a tombstone written with no session is no shared session\'s', async() => {
      shared();
      await put(null);
      for (const s of [A, NO_LIVE, null]) assert.strictEqual(await find(s), null, `${s}`);
    });

    it('outside shared mode the owner key decides, as before (the --stdio session\'s id may differ after a restart)', async() => {
      await put('local-session-before-restart');
      assert.ok((await find('local-session-after-restart')) != null);
      assert.ok((await find(null)) != null);
    });
  });
});

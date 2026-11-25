'use strict';
// B1 Task 3 (docs/superpowers/plans/2026-11-15-shared-runtime-b1-sessions.md):
// a job and a usage record carry the session that made them, on the main
// thread only. A usage record gets `session` (the opaque id) beside
// `caller`, and nothing else about the session; a call from no session's
// record is as before (no field), so every reader reads both; and it is
// written in shared mode only. A job's session is never in its data
// (lib/job-sessions.js keeps it in memory, sessions 04): a run's bookkeeping
// takes it and its values (the start hook cannot name them), its usage call
// does, and its worker never sees any of it.
const assert = require('assert');
const {createUsage} = require('../../lib/usage');
const {taskHooks} = require('../../lib/usage/task');
const {normalise} = require('../../lib/usage/read');
const common = require('../../lib/job-control-common');
const jobArgs = require('../../lib/job-args');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

describe('usage 20: the session on usage records and jobs (shared runtime B1, Task 3)', () => {
  it('records of calls from two sessions carry their own ids; one from no session has no field; nothing else about the session', () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1});
    const ca = u.beginCall({scenario: null, module: 'm', tool: 't', caller: 'c1', session: A});
    const cb = u.beginCall({scenario: null, module: 'm', tool: 't', caller: 'c1', session: B});
    const cn = u.beginCall({scenario: null, module: 'm', tool: 't', caller: 'c1'});
    u.recordIn(ca, {server: 's', tool: 'x', bytes: 1, ms: 1, outcome: 'ok', credential: null});
    for (const c of [ca, cb, cn]) u.recordOut(c, {tool: 't', bytes: 1, ms: 1, outcome: 'ok'});
    const recs = u.records();
    assert.deepStrictEqual(recs.filter((r) => r.call === ca).map((r) => r.session), [A, A], 'its In and Out');
    assert.deepStrictEqual(recs.filter((r) => r.call === cb).map((r) => r.session), [B]);
    const none = recs.find((r) => r.call === cn);
    assert.ok(!('session' in none), 'no session: no field, the record as before');
    for (const r of recs) assert.deepStrictEqual(Object.keys(r).filter((k) => /session/i.test(k)), r.call === cn ? [] : ['session']);
    assert.throws(() => u.beginCall({tool: 't', session: 42}), /a session is its id/);
  });

  it('the reader reads a record with the field and one without, as before', () => {
    const base = {t: '2026-11-15T00:00:00.000Z', call: 1, pack: null, tool: 't', bytesOut: 1, ms: 1, outcome: 'ok', caller: 'c1'};
    assert.strictEqual(normalise(Object.assign({session: A}, base)).session, A);
    assert.ok(!('session' in normalise(base)));
  });

  describe('in shared mode', () => {
    const sessions = require('../../lib/sessions');
    afterEach(() => sessions.resetForTests());

    it('a task run\'s usage call takes its run\'s session (shared mode only)', () => {
      const u = createUsage({usageDir: null, pid: 1, startMs: 1});
      const hooks = taskHooks({usage: () => u, targetFor: () => ({name: 't', role: 'module', module: 'm'}), buildResult: () => null});
      const out = (session) => { const s = hooks.start({ownerId: 'c1'}, session); u.recordOut(s.usageCall, {tool: 't', bytes: 1, ms: 1, outcome: 'ok'}); return u.records().find((r) => r.call === s.usageCall); };
      assert.ok(!('session' in out(A)), 'not shared: no field (--stdio\'s records as before)');
      sessions.attach(new (require('events'))());
      assert.strictEqual(out(A).session, A);
      assert.ok(!('session' in out(null)), 'a job from no session: no field');
      assert.ok(!('session' in out(undefined)));
    });

    it('forUsage: the id in shared mode only', () => {
      assert.strictEqual(sessions.forUsage(A), null);
      sessions.attach(new (require('events'))());
      assert.strictEqual(sessions.forUsage(A), A);
      assert.strictEqual(sessions.forUsage(null), null);
    });
  });

  it('a job\'s data never holds a session: ownerData ignores one', () => {
    assert.deepStrictEqual(Object.keys(common.ownerData({appKey: 'k', session: A})).filter((k) => /session/i.test(k)), []);
  });

  it('a run\'s bookkeeping takes the run\'s session and values over the start hook\'s answer; its worker gets none', () => {
    const {withRunBookkeeping} = common;
    const limits = {maxOutputBytes: 5, requestTimeout: 6};
    const out = withRunBookkeeping({usageCall: 3, session: B, limits: {maxOutputBytes: 1e9, requestTimeout: 1e9}}, 'k', 1000, {session: A, limits});
    assert.strictEqual(out.session, A, 'the run\'s, never the hook\'s');
    assert.deepStrictEqual(out.limits, limits);
    const none = withRunBookkeeping({session: B, limits}, 'k', 1000, null);
    assert.ok(!('session' in none) && !('limits' in none), 'none: not the hook\'s either');
    assert.deepStrictEqual(Object.keys(jobArgs({x: 1}, 'j1', out)).sort(), ['input', 'jobID', 'usageCall']);
  });
});

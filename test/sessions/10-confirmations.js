'use strict';
// B2 Task 5 (docs/superpowers/plans/2026-11-15-shared-runtime-b2-session-settings.md),
// server-free: in a shared runtime the confirmation state is each
// session's own -- the staged change, its nonce, the decline lock per kind
// and the forms shown -- under one key for the runtime, with the session in
// the MAC. Across a user's sessions there is one window per kind: three
// declines or expiries within 30 minutes stop that kind's forms for the
// next 30, in every session, and a form pending anywhere counts toward the
// three, so a prompt injection cannot fan forms out over sessions. One
// "conditions: no" from a session's client locks that session for its life
// (N1). --stdio keeps the one store it had.
const assert = require('assert');
const confirm = require('../../lib/settings-confirm');

const MiB = 1024 * 1024;
const MIN = 60 * 1000;

describe('sessions 10: confirmations per session, a window per user (shared runtime B2, Task 5)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const C = 'c'.repeat(32);
  const D = 'd'.repeat(32);
  let clock;
  let timers;
  let told;
  const WALL0 = 1800000000000;   // the wall clock at the test's start: it moves with the test's own
  // the clock moves, and every timer due by then fires, in order
  const advance = (ms) => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => !t.cleared && t.at <= until).sort((x, y) => x.at - y.at)[0];
      if (due == null) break;
      clock = due.at;
      due.cleared = true;
      due.fn();
    }
    clock = until;
  };
  const change = (session, over = {}) => Object.assign({name: 'maxOutputBytes', old: 8 * MiB, next: 16 * MiB, client: {name: 'claude-code', version: '2.1.323'}, session}, over);
  const retry = (session, over = {}) => Object.assign({name: 'maxOutputBytes', next: 16 * MiB, session}, over);
  beforeEach(() => {
    clock = 1000000;
    timers = [];
    told = [];
    confirm.resetForTests();
    confirm.configure({
      now: () => clock,
      wall: () => WALL0 + (clock - 1000000),
      timer: (fn, ms) => { const t = {fn, at: clock + ms, cleared: false}; timers.push(t); return t; },
      clearTimer: (t) => { if (t != null) t.cleared = true; },
      tell: (m) => told.push(m)
    });
  });
  afterEach(() => confirm.resetForTests());

  describe('each session\'s own store', () => {
    it('a session has one store for its life; the --stdio session\'s is the process\'s, as before', () => {
      const a = confirm.confirmations(A);
      assert.strictEqual(confirm.confirmations(A), a);
      assert.notStrictEqual(confirm.confirmations(B), a);
      const local = confirm.confirmations();
      assert.strictEqual(confirm.confirmations(), local);
      assert.notStrictEqual(local, a);
    });

    it('a form staged in A is A\'s to answer: from B its state fails, and it does not replace B\'s form', () => {
      const a = confirm.confirmations(A);
      const b = confirm.confirmations(B);
      const inB = b.stage(change(B));
      const inA = a.stage(change(A));
      assert.strictEqual(inA.replaced, null, 'B\'s form is not replaced by A\'s');
      // B retries with A's state: as itself, and naming A
      assert.deepStrictEqual(b.verify(inA.requestState, retry(B)), {ok: false, code: 'SETTING_CONFIRMATION_INVALID'});
      assert.deepStrictEqual(b.verify(inA.requestState, retry(A)), {ok: false, code: 'SETTING_CONFIRMATION_INVALID'});
      // the session is the connection's, so A's store is only asked for A
      assert.deepStrictEqual(a.verify(inA.requestState, retry(B)), {ok: false, code: 'SETTING_CONFIRMATION_INVALID'});
      assert.strictEqual(a.verify(inA.requestState, retry(A)).ok, true);
      assert.strictEqual(b.verify(inB.requestState, retry(B)).ok, true, 'B\'s own is still good');
    });

    it('one key for the runtime, the session in the MAC', () => {
      const nonce = 'N'.repeat(22);
      // one key: any session's store makes the same MAC of the same nonce and change
      assert.strictEqual(confirm.confirmations(A).macOf(nonce, retry(A)), confirm.confirmations(B).macOf(nonce, retry(A)));
      // the session is in it: the same nonce and change, in another session, is another MAC
      assert.notStrictEqual(confirm.confirmations(A).macOf(nonce, retry(A)), confirm.confirmations(A).macOf(nonce, retry(B)));
      // --stdio's store has a key of its own
      assert.notStrictEqual(confirm.confirmations().macOf(nonce, retry(A)), confirm.confirmations(A).macOf(nonce, retry(A)));
      // B's nonce with A's MAC, in either store
      const inA = confirm.confirmations(A).stage(change(A));
      const inB = confirm.confirmations(B).stage(change(B));
      const mixed = `${inB.requestState.split('.')[0]}.${inA.requestState.split('.')[1]}`;
      assert.strictEqual(confirm.confirmations(B).verify(mixed, retry(B)).ok, false);
    });

    it('a decline locks its kind in its session only; three forms a session', () => {
      const a = confirm.confirmations(A);
      a.decline('maxOutputBytes');
      assert.strictEqual(a.declined('maxOutputBytes'), true);
      assert.strictEqual(a.stage(change(A)), null);
      const b = confirm.confirmations(B);
      assert.strictEqual(b.declined('maxOutputBytes'), false);
      // B's own three, of a kind the window has room for
      for (let i = 0; i < 3; i++) { const s = b.stage(change(B, {name: 'requestTimeout', old: 30000, next: 40000 + i})); assert.ok(s != null, `form ${i + 1}`); b.verify(s.requestState, retry(B, {name: 'requestTimeout', next: 40000 + i})); }
      assert.strictEqual(b.formsLeft(), 0);
      assert.strictEqual(b.stage(change(B, {name: 'requestTimeout', old: 30000, next: 50000})), null);
      assert.strictEqual(confirm.confirmations(C).formsLeft(), 3);
    });
  });

  describe('the window, per kind, across the user\'s sessions', () => {
    it('three declines within 30 minutes stop that kind\'s forms in every session for the next 30; another kind goes on', () => {
      const w = confirm.userWindow();
      for (const s of [A, B]) { confirm.confirmations(s).decline('maxOutputBytes'); advance(MIN); }
      assert.strictEqual(w.locked('maxOutputBytes'), false, 'two');
      const third = confirm.confirmations(C).stage(change(C));
      assert.ok(third != null, 'a third session still gets a form');
      // declined, as the tool does it: the answer takes the form, then the decline is counted
      assert.strictEqual(confirm.confirmations(C).verify(third.requestState, retry(C)).ok, true);
      confirm.confirmations(C).decline('maxOutputBytes');
      assert.strictEqual(w.locked('maxOutputBytes'), true, 'three');
      assert.strictEqual(confirm.confirmations(D).stage(change(D)), null, 'a session that never declined gets none');
      assert.ok(confirm.confirmations(D).stage(change(D, {name: 'requestTimeout', old: 30000, next: 60000})) != null, 'another kind');
      assert.strictEqual(w.locked('pack'), false);
      advance(29 * MIN);
      assert.strictEqual(w.locked('maxOutputBytes'), true);
      advance(2 * MIN);
      assert.strictEqual(w.locked('maxOutputBytes'), false, 'the 30 minutes passed');
      assert.ok(confirm.confirmations(D).stage(change(D)) != null);
    });

    it('declines more than 30 minutes apart never add up', () => {
      for (const s of [A, B, C]) { confirm.confirmations(s).decline('requestTimeout'); advance(16 * MIN); }
      assert.strictEqual(confirm.userWindow().locked('requestTimeout'), false);
    });

    // Task 6's restore brings the daemon's list: what was declined or left
    // unanswered before a runtime restart still counts
    it('the daemon\'s list loads into the window by kind and age: what is older than 30 minutes is dropped, three recent of a kind lock it from the third', () => {
      const w = confirm.userWindow();
      const wall = WALL0;
      assert.strictEqual(w.load([{kind: 'maxOutputBytes', at: wall - 5 * MIN}, {kind: 'maxOutputBytes', at: wall - 40 * MIN}, {kind: 'requestTimeout', at: wall - MIN},
        {kind: 'pack', at: wall - 20 * MIN}, {kind: 'pack', at: wall - 10 * MIN}, {kind: 'pack', at: wall - 4 * MIN}]), true);
      assert.strictEqual(w.count('maxOutputBytes'), 1, 'the one inside the 30 minutes');
      assert.strictEqual(w.count('requestTimeout'), 1);
      assert.strictEqual(w.locked('maxOutputBytes'), false);
      assert.strictEqual(w.locked('pack'), true);
      assert.deepStrictEqual(told, [], 'the daemon has them already');
      // one more decline of the first kind, here, and one in B: three within the window
      confirm.confirmations(A).decline('maxOutputBytes');
      confirm.confirmations(B).decline('maxOutputBytes');
      assert.strictEqual(w.locked('maxOutputBytes'), true);
      // the pack lock runs 30 minutes from its third, which was 4 minutes ago
      advance(25 * MIN);
      assert.strictEqual(w.locked('pack'), true);
      advance(2 * MIN);
      assert.strictEqual(w.locked('pack'), false);
    });

    it('a lock still running is rebuilt: it runs 30 minutes from its third event, so events up to 60 minutes old count for it', () => {
      const w = confirm.userWindow();
      // declined 35, 25 and 10 minutes ago: locked since the third, for 20 minutes more
      assert.strictEqual(w.load([{kind: 'maxOutputBytes', at: WALL0 - 35 * MIN}, {kind: 'maxOutputBytes', at: WALL0 - 25 * MIN}, {kind: 'maxOutputBytes', at: WALL0 - 10 * MIN},
        // three, but never within one 30 minutes: no lock
        {kind: 'requestTimeout', at: WALL0 - 50 * MIN}, {kind: 'requestTimeout', at: WALL0 - 19 * MIN}, {kind: 'requestTimeout', at: WALL0 - 2 * MIN},
        // locked 61 minutes ago: over
        {kind: 'pack', at: WALL0 - 65 * MIN}, {kind: 'pack', at: WALL0 - 63 * MIN}, {kind: 'pack', at: WALL0 - 61 * MIN}]), true);
      assert.strictEqual(w.locked('maxOutputBytes'), true);
      assert.strictEqual(w.count('maxOutputBytes'), 2, 'the two still inside the 30 minutes');
      assert.strictEqual(confirm.confirmations(A).stage(change(A)), null);
      assert.strictEqual(w.locked('requestTimeout'), false);
      assert.strictEqual(w.count('requestTimeout'), 2);
      assert.strictEqual(w.locked('pack'), false);
      advance(19 * MIN);
      assert.strictEqual(w.locked('maxOutputBytes'), true);
      advance(2 * MIN);
      assert.strictEqual(w.locked('maxOutputBytes'), false);
      assert.strictEqual(confirm.LOAD_KEEP_MS, 60 * MIN, 'what the daemon must keep each decline for');
    });

    it('a list that is not exactly kinds and past times is dropped whole, and every kind is locked for 30 minutes (as when no list came: lockAll)', () => {
      const wall = WALL0;
      const good = {kind: 'pack', at: wall - MIN};
      const bad = [null, 'x', {}, [good, {kind: 'locale', at: wall}], [good, {kind: 'pack', at: wall + 1}], [good, {kind: 'pack', at: 1.5}], [good, {kind: 'pack', at: -1}],
        [good, {kind: 'pack', at: wall, session: A}], [good, null], Array.from({length: 65}, () => good)];
      for (const list of bad) {
        confirm.resetForTests();
        confirm.configure({now: () => clock, wall: () => WALL0 + (clock - 1000000), timer: () => null, clearTimer: () => {}, tell: (m) => told.push(m)});
        const w = confirm.userWindow();
        assert.strictEqual(w.load(list), false, JSON.stringify(list).slice(0, 80));
        for (const kind of ['maxOutputBytes', 'requestTimeout', 'pack']) {
          assert.strictEqual(w.locked(kind), true, kind);
          assert.strictEqual(w.count(kind), 0, 'nothing of the list is kept');
        }
        assert.strictEqual(confirm.confirmations(A).stage(change(A)), null);
        assert.deepStrictEqual(told, []);
      }
      // 64 is the most a list holds, and an empty one is a fresh start
      confirm.resetForTests();
      confirm.configure({now: () => clock, wall: () => WALL0 + (clock - 1000000), timer: () => null, clearTimer: () => {}, tell: (m) => told.push(m)});
      assert.strictEqual(confirm.userWindow().load(Array.from({length: 64}, () => ({kind: 'pack', at: wall - 31 * MIN}))), true);
      assert.strictEqual(confirm.userWindow().load([]), true);
      assert.strictEqual(confirm.userWindow().locked('pack'), false);
      // the safety net's own call (Task 6: no restore within 3 s)
      confirm.userWindow().lockAll();
      assert.strictEqual(confirm.userWindow().locked('requestTimeout'), true);
      advance(30 * MIN + 1);
      assert.strictEqual(confirm.userWindow().locked('requestTimeout'), false);
    });

    it('every pack is one kind', () => {
      confirm.confirmations(A).decline('pack.one');
      confirm.confirmations(B).decline('pack.two');
      confirm.confirmations(C).decline('pack.three');
      assert.strictEqual(confirm.userWindow().locked('pack'), true);
      assert.strictEqual(confirm.confirmations(D).stage(change(D, {name: 'pack.four', old: false, next: true, version: '1.0.0'})), null);
    });

    it('a form pending anywhere counts toward the three: with two declines and a form up in B, a third session gets none (review focus 3)', () => {
      confirm.confirmations(A).decline('maxOutputBytes');
      confirm.confirmations(D).decline('maxOutputBytes');
      const inB = confirm.confirmations(B).stage(change(B));
      assert.ok(inB != null, 'the third of the kind');
      assert.strictEqual(confirm.confirmations(C).stage(change(C)), null, 'no fourth while it is pending');
      assert.strictEqual(confirm.confirmations(C).formsLeft(), 3, 'and it spent none of C\'s');
      // answered (accepted): it no longer counts, and the window has room again
      assert.strictEqual(confirm.confirmations(B).verify(inB.requestState, retry(B)).ok, true);
      assert.ok(confirm.confirmations(C).stage(change(C)) != null);
    });

    it('a form past its deadline is an expiry when the deadline passes, not at a later ask', () => {
      const w = confirm.userWindow();
      confirm.confirmations(A).decline('maxOutputBytes');
      confirm.confirmations(D).decline('maxOutputBytes');
      const inB = confirm.confirmations(B).stage(change(B));
      advance(confirm.TTL_MS + 5);
      // nobody asked again: the timer counted it, and the kind is locked
      assert.strictEqual(w.locked('maxOutputBytes'), true);
      assert.deepStrictEqual(confirm.confirmations(B).verify(inB.requestState, retry(B)).ok, false, 'and its state is no longer good');
      // the expired form, for the history (taken once)
      assert.deepStrictEqual(confirm.confirmations(B).takeExpired().map((s) => [s.name, s.next]), [['maxOutputBytes', 16 * MiB]]);
      assert.deepStrictEqual(confirm.confirmations(B).takeExpired(), []);
    });

    it('a session that ends with a form staged: the form counts as an expiry, and its state is good nowhere (review focus 2)', () => {
      confirm.confirmations(B).decline('maxOutputBytes');
      confirm.confirmations(C).decline('maxOutputBytes');
      const inA = confirm.confirmations(A).stage(change(A));
      confirm.forget(A);
      assert.strictEqual(confirm.userWindow().locked('maxOutputBytes'), true, 'two declines and the ended session\'s form');
      // its store is gone: none is held for it, and one made for the same id
      // (it cannot be: the id ended) is new, with its three forms
      assert.strictEqual(confirm.held(), 2, 'B\'s and C\'s');
      assert.strictEqual(confirm.confirmations(A).formsLeft(), 3);
      assert.strictEqual(confirm.confirmations(A).verify(inA.requestState, retry(A)).ok, false);
      assert.strictEqual(confirm.confirmations(B).verify(inA.requestState, retry(A)).ok, false);
      // a session that ends with nothing staged counts nothing
      confirm.resetForTests();
      confirm.configure({now: () => clock, timer: () => null, clearTimer: () => {}, tell: () => {}});
      confirm.confirmations(A);
      confirm.forget(A);
      assert.strictEqual(confirm.userWindow().count('maxOutputBytes'), 0);
    });

    it('a form a session replaces with another of its own counts as an expiry (F7)', () => {
      const a = confirm.confirmations(A);
      a.stage(change(A));
      const second = a.stage(change(A, {next: 32 * MiB}));
      assert.deepStrictEqual([second.replaced.name, second.replaced.next], ['maxOutputBytes', 16 * MiB]);
      assert.strictEqual(confirm.userWindow().count('maxOutputBytes'), 1);
      // of another kind: the expiry is the replaced form's kind's
      a.stage(change(A, {name: 'requestTimeout', old: 30000, next: 60000}));
      assert.strictEqual(confirm.userWindow().count('maxOutputBytes'), 2);
      assert.strictEqual(confirm.userWindow().count('requestTimeout'), 0);
    });

    it('the form that locks the kind is the last: a second form left for another gets no third (review: the count comes before the next form)', () => {
      const a = confirm.confirmations(A);
      assert.ok(a.stage(change(A, {next: 16 * MiB})) != null);
      const second = a.stage(change(A, {next: 32 * MiB}));
      assert.ok(second != null, 'one form left unanswered is not a lock');
      assert.deepStrictEqual(a.takeExpired(), [], 'a replaced form is said by the stage that replaced it');
      // the second, left for a third: two unanswered, so the kind is locked, and no form is staged that could never be accepted
      assert.strictEqual(a.stage(change(A, {next: 64 * MiB})), null);
      assert.strictEqual(a.declined('maxOutputBytes'), true);
      assert.strictEqual(a.formsLeft(), 1, 'no form was spent on it');
      assert.strictEqual(a.verify(second.requestState, retry(A, {next: 32 * MiB})).ok, false, 'the second is gone');
      // the form it dropped, for the history
      assert.deepStrictEqual(a.takeExpired().map((s) => [s.next, s.ended]), [[32 * MiB, 'replaced']]);
      assert.strictEqual(confirm.userWindow().count('maxOutputBytes'), 2);
    });

    it('an answer that comes after the form\'s time is told it expired, not that it is no state of ours', () => {
      const a = confirm.confirmations(A);
      const inA = a.stage(change(A));
      advance(confirm.TTL_MS + 1000);   // the timer has swept it
      assert.deepStrictEqual(a.verify(inA.requestState, retry(A)), {ok: false, code: 'SETTING_CONFIRMATION_EXPIRED'});
      assert.deepStrictEqual(a.check(inA.requestState, retry(A)), {ok: false, code: 'SETTING_CONFIRMATION_EXPIRED'});
      assert.strictEqual(confirm.userWindow().count('maxOutputBytes'), 1, 'counted once');
      assert.deepStrictEqual(a.takeExpired().map((s) => [s.next, s.ended]), [[16 * MiB, 'expired']], 'and said once');
      // a state that never was is still no state
      assert.strictEqual(a.verify(`${'x'.repeat(22)}.${inA.requestState.split('.')[1]}`, retry(A)).code, 'SETTING_CONFIRMATION_INVALID');
    });

    it('a session\'s end hands back the forms nobody was told of: the one pending, and any its timer expired', () => {
      const a = confirm.confirmations(A);
      a.stage(change(A, {next: 16 * MiB}));
      advance(confirm.TTL_MS + 5);
      a.stage(change(A, {name: 'requestTimeout', old: 30000, next: 60000}));
      assert.deepStrictEqual(confirm.forget(A).map((s) => [s.name, s.next]), [['maxOutputBytes', 16 * MiB], ['requestTimeout', 60000]]);
      assert.deepStrictEqual(confirm.forget(A), [], 'nothing of it is left');
      assert.deepStrictEqual(confirm.forget('z'.repeat(32)), [], 'nor of a session that had no store');
    });

    it('each decline and each expiry is told to the daemon, with its kind and a time (Task 6\'s message)', () => {
      confirm.confirmations(A).decline('pack.one');
      confirm.confirmations(B).stage(change(B));
      advance(confirm.TTL_MS + 5);
      assert.deepStrictEqual(told.map((m) => [m.type, m.kind, Number.isInteger(m.at) && m.at > 0]), [['decline', 'pack', true], ['decline', 'maxOutputBytes', true]]);
      assert.ok(told.every((m) => Object.keys(m).sort().join() === 'at,kind,type'), 'nothing else: no session, no value');
    });

    it('the --stdio store is outside the window: its declines lock its own kinds and count nowhere', () => {
      const local = confirm.confirmations();
      local.decline('maxOutputBytes');
      assert.strictEqual(confirm.userWindow().count('maxOutputBytes'), 0);
      assert.deepStrictEqual(told, []);
    });
  });

  describe('the latch (N1)', () => {
    it('locks all three kinds for the session\'s life, as ordinary decline locks; no other session, and nothing in the window', () => {
      confirm.latch(A);
      const a = confirm.confirmations(A);
      for (const name of ['maxOutputBytes', 'requestTimeout', 'pack.any']) assert.strictEqual(a.declined(name), true, name);
      assert.strictEqual(a.stage(change(A)), null);
      assert.strictEqual(confirm.confirmations(B).declined('maxOutputBytes'), false);
      for (const kind of ['maxOutputBytes', 'requestTimeout', 'pack']) assert.strictEqual(confirm.userWindow().count(kind), 0, kind);
      assert.deepStrictEqual(told, [], 'it is not a decline of the user\'s');
      // the locks, as a session's export carries them (Task 6)
      assert.deepStrictEqual(a.locks(), ['maxOutputBytes', 'pack', 'requestTimeout']);
    });

    it('a form pending when the latch falls is gone, uncounted', () => {
      const inA = confirm.confirmations(A).stage(change(A));
      confirm.latch(A);
      assert.strictEqual(confirm.confirmations(A).verify(inA.requestState, retry(A)).ok, false);
      assert.strictEqual(confirm.userWindow().count('maxOutputBytes'), 0);
    });
  });

  // The settings tool, for a shared runtime's sessions: a loosening of a cap
  // asked for in a session is confirmed by that session's user, in that
  // session's form, and becomes that session's override.
  describe('the form and its retry, in a session (lib/settings-tool.js)', () => {
    const EventEmitter = require('events');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const options = require('../../lib/cli-options');
    const notices = require('../../lib/notices');
    const sessions = require('../../lib/sessions');
    const settings = require('../../lib/session-settings');
    const jobSessions = require('../../lib/job-sessions');
    const settingsTool = require('../../lib/settings-tool');
    const CLIENT = {name: 'claude-code', version: '2.1.323'};
    const ACCEPT = {approve: {action: 'accept', content: {approve: true}}};
    const DECLINE = {approve: {action: 'decline'}};
    let reg;
    let sources;
    let home;
    let file;
    let saved;
    let grown;
    let asked;
    // conditions: what the session's client answers a conditions? with (C1's askConditions)
    const openSession = (id, conditions = {status: 'ok', conditions: 'yes', repo: null}) => {
      const s = new EventEmitter();
      s.id = id;
      s.client = Object.assign({}, conditions);
      s.connected = true;
      s.answer = conditions;
      s.notify = () => {};
      s.record = () => {};
      s.forget = () => {};
      s.askConditions = async () => { asked.push(id); if (s.answer != null) Object.assign(s.client, s.answer); return s.answer == null ? null : Object.assign({}, s.answer); };
      sources[id] = s;
      reg.emit('session', s);
      return s;
    };
    const ctx = (id) => ({shared: true, session: id, clientInfo: CLIENT, capabilities: {elicitation: {form: {}}}});
    const tool = (o = {}) => settingsTool.create(Object.assign({file, lockWaitMs: 200, ceiling: () => ({state: 'none'}),
      // the tested-client list is the tool's own concern (stdio 18, 20): any client here
      sessionClient: (c) => ({ok: true, client: c.clientInfo}),
      growValidators: async (bytes) => { grown.push(bytes); }}, o));
    const history = () => (fs.existsSync(path.join(home, 'history.jsonl'))
      ? fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const refused = async (p, code) => {
      let err = null;
      try { await p; } catch (e) { err = e; }
      assert.ok(err != null, `refused ${code}`);
      assert.strictEqual(err.code, code, err.message);
      return err;
    };
    const reset = () => { sessions.resetForTests(); settings.resetForTests(); jobSessions.resetForTests(); notices.resetForTests(); settingsTool.resetForTests(); };
    beforeEach(() => {
      saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout, locale: options.locale};
      Object.assign(options, {maxOutputBytes: 8 * MiB, requestTimeout: 30000, locale: 'en-US'});
      reset();
      settings.configure({ceiling: () => ({state: 'none'})});
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s10-'));
      file = path.join(home, 'settings.json');
      reg = new EventEmitter();
      sessions.attach(reg);
      sources = {};
      grown = [];
      asked = [];
      openSession(A);
      openSession(B);
    });
    afterEach(() => { Object.assign(options, saved); reset(); fs.rmSync(home, {recursive: true, force: true}); });

    it('A, at 2 MiB, asks for 4 MiB: a form that says "this session"; accepted, A runs at 4 MiB and nothing else changes', async () => {
      const t0 = tool();
      await t0.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A));
      const before = {live: settingsTool.liveOptions()};
      const r = await t0.set('maxOutputBytes', '4MiB', 'settings tool', ctx(A));
      const form = r.inputRequired.inputRequests.approve;
      assert.strictEqual(form.params.message, 'Allow countinghouse tools to return up to 4MiB per call in this session (now 2MiB)? This applies to this session only, until it ends.');
      assert.deepStrictEqual(form.params.requestedSchema, {type: 'object', properties: {approve: {type: 'boolean', title: 'Approve'}}, required: ['approve']});
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 2 * MiB, 'nothing yet');
      const done = await t0.confirm('maxOutputBytes', '4MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A));
      assert.deepStrictEqual(done, {name: 'maxOutputBytes', old: 2 * MiB, new: 4 * MiB, applies: 'this session'});
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 4 * MiB);
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 8 * MiB);
      assert.strictEqual(settings.limitsOf(B), null);
      assert.strictEqual(options.maxOutputBytes, 8 * MiB, 'the shared option');
      assert.deepStrictEqual(settingsTool.liveOptions(), before.live);
      assert.ok(!fs.existsSync(file), 'settings.json never written');
      const line = history().pop();
      assert.deepStrictEqual((({at, ...rest}) => rest)(line), {by: 'settings tool', setting: 'maxOutputBytes', old: 2 * MiB, new: 4 * MiB, change: 'this session',
        confirmed: 'elicitation (claude-code 2.1.323)', session: A});
    });

    it('above the default: the validators are grown first, and the override is a loosening over the default in force; a growth that fails applies nothing', async () => {
      const t0 = tool();
      const r = await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A));
      assert.match(r.inputRequired.inputRequests.approve.params.message, /up to 16MiB per call in this session \(now 8MiB\)/);
      await t0.confirm('maxOutputBytes', '16MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A));
      assert.deepStrictEqual(grown, [16 * MiB]);
      assert.deepStrictEqual(settings.overridesOf(A), [{name: 'maxOutputBytes', value: 16 * MiB, loosening: true, over: 8 * MiB, version: null}]);
      // B asks the same; the validators cannot be grown
      const failing = tool({growValidators: async () => { throw Object.assign(new Error('no'), {code: 'RESIZE_FAILED'}); }});
      const rb = await failing.set('maxOutputBytes', '16MiB', 'settings tool', ctx(B));
      await refused(failing.confirm('maxOutputBytes', '16MiB', {requestState: rb.inputRequired.requestState, inputResponses: ACCEPT}, ctx(B)), 'SETTING_NOT_APPLIED_THIS_SESSION');
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 8 * MiB);
      assert.deepStrictEqual(history().filter((h) => h.session === B).map((h) => h.change), ['this session', 'not applied']);
    });

    it('the form\'s text says "this session" in both languages', async () => {
      const en = await tool().set('requestTimeout', '60s', 'settings tool', ctx(A));
      assert.strictEqual(en.inputRequired.inputRequests.approve.params.message,
        'Allow countinghouse tool calls to run for up to 60s in this session (now 30s)? This applies to this session only, until it ends.');
      options.locale = 'zh-CN';
      const zh = await tool().set('maxOutputBytes', '16MiB', 'settings tool', ctx(B));
      assert.strictEqual(zh.inputRequired.inputRequests.approve.params.message, '允许 countinghouse 工具在本会话中每次调用最多返回 16MiB（当前为 8MiB）吗？此设置仅对本会话有效，会话结束即失效。');
    });

    it('a form staged in A answers only in A: retried from B with A\'s state it fails; A\'s form does not replace B\'s; A\'s end counts its form as an expiry (review focus 2)', async () => {
      const t0 = tool();
      const inB = await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(B));
      const inA = await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A));
      await refused(t0.confirm('maxOutputBytes', '16MiB', {requestState: inA.inputRequired.requestState, inputResponses: ACCEPT}, ctx(B)), 'SETTING_CONFIRMATION_INVALID');
      assert.strictEqual(settings.limitsOf(B), null);
      // B's own form is still good
      assert.strictEqual((await t0.confirm('maxOutputBytes', '16MiB', {requestState: inB.inputRequired.requestState, inputResponses: ACCEPT}, ctx(B))).new, 16 * MiB);
      sources[A].emit('end');
      assert.strictEqual(confirm.userWindow().count('maxOutputBytes'), 1, 'A\'s pending form, at its end');
    });

    it('declined: nothing changes, the kind is locked for that session, and the decline is the user\'s window\'s', async () => {
      const t0 = tool();
      const r = await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A));
      assert.deepStrictEqual(await t0.confirm('maxOutputBytes', '16MiB', {requestState: r.inputRequired.requestState, inputResponses: DECLINE}, ctx(A)),
        {name: 'maxOutputBytes', old: 8 * MiB, new: 8 * MiB, applies: 'declined'});
      assert.strictEqual(settings.limitsOf(A), null);
      // the session's lock, in its own words: for the session, not "until countinghouse restarts"
      const locked = await refused(t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A)), 'SETTING_DECLINED_THIS_SESSION');
      assert.strictEqual(locked.message, 'Loosening maxOutputBytes is not asked again in this session (it was declined or left unanswered here, or this client\'s configuration could answer for you); '
        + 'nothing was changed. To allow it, run `ch-local settings set maxOutputBytes 16MiB` in a terminal yourself.');
      assert.ok((await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(B))).inputRequired != null, 'B is not locked by A\'s decline');
      assert.strictEqual(confirm.userWindow().count('maxOutputBytes'), 1);
      assert.ok(history().some((h) => h.session === A && h.change === 'declined'));
    });

    it('with two declines in the window and a form up in B, a third session gets none; B\'s accept once the kind has locked is refused (review focus 3)', async () => {
      const t0 = tool();
      const C2 = 'c'.repeat(32);
      const D2 = 'd'.repeat(32);
      const E2 = 'e'.repeat(32);
      for (const id of [C2, D2, E2]) openSession(id);
      for (const id of [C2, D2]) {
        const r = await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(id));
        await t0.confirm('maxOutputBytes', '16MiB', {requestState: r.inputRequired.requestState, inputResponses: DECLINE}, ctx(id));
      }
      const inB = await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(B));
      assert.ok(inB.inputRequired != null, 'the third of the kind');
      await refused(t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(E2)), 'SETTING_NEEDS_CONFIRMATION');
      // a third decline elsewhere locks the kind while B's form is up: B's yes comes too late
      confirm.userWindow().note('maxOutputBytes');
      assert.strictEqual(confirm.userWindow().locked('maxOutputBytes'), true);
      await refused(t0.confirm('maxOutputBytes', '16MiB', {requestState: inB.inputRequired.requestState, inputResponses: ACCEPT}, ctx(B)), 'SETTING_NEEDS_CONFIRMATION');
      assert.strictEqual(settings.limitsOf(B), null);
    });

    it('a session whose client does not answer "ok, yes" gets no form, at the form and again at the confirmation (F1)', async () => {
      const t0 = tool();
      for (const answer of [null, {status: 'failed', conditions: null, repo: null}, {status: 'ok', conditions: null, repo: null}]) {
        sources[B].answer = answer;
        await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(B)), 'SETTING_NEEDS_CONFIRMATION');
      }
      assert.ok(asked.filter((id) => id === B).length >= 3, 'asked each time, of this session');
      // yes at the form, no answer at the confirmation: a hook written while the dialog was up
      const r = await t0.set('requestTimeout', '60s', 'settings tool', ctx(A));
      sources[A].answer = null;
      await refused(t0.confirm('requestTimeout', '60s', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_NEEDS_CONFIRMATION');
      assert.strictEqual(settings.limitsOf(A), null);
    });

    it('one "conditions: no" from a session\'s client latches it: no form of any kind for its life, though a later answer says yes (N1)', async () => {
      const t0 = tool();
      sources[A].answer = {status: 'ok', conditions: 'no', repo: null};
      await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(A)), 'SETTING_DECLINED_THIS_SESSION');
      sources[A].answer = {status: 'ok', conditions: 'yes', repo: null};
      await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(A)), 'SETTING_DECLINED_THIS_SESSION');
      await refused(t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A)), 'SETTING_DECLINED_THIS_SESSION');
      assert.strictEqual(confirm.confirmations(A).formsLeft(), 3, 'no form was ever shown');
      assert.deepStrictEqual(history().filter((h) => h.session === A).map((h) => h.change), ['not confirmed (locked in this session)', 'not confirmed (locked in this session)']);
      assert.deepStrictEqual(confirm.confirmations(A).locks(), ['maxOutputBytes', 'pack', 'requestTimeout']);
      // a client frame that says no at the session's start, or at a reattach, latches too
      const s = openSession('f'.repeat(32), {status: 'ok', conditions: 'no', repo: null});
      assert.strictEqual(confirm.confirmations(s.id).declined('maxOutputBytes'), true);
      sources[B].client.conditions = 'no';
      sources[B].emit('attach');
      assert.strictEqual(confirm.confirmations(B).declined('requestTimeout'), true);
    });

    it('every client frame is seen as it comes: a "no" that a later frame overwrites has latched all the same (a late answer to an ask that timed out, then a yes)', async () => {
      const t0 = tool();
      // as C1's registry announces each frame; the session's own copy is then overwritten
      sources[A].emit('client', {status: 'ok', conditions: 'no', repo: null});
      sources[A].emit('client', {status: 'ok', conditions: 'yes', repo: null});
      assert.deepStrictEqual(confirm.confirmations(A).locks(), ['maxOutputBytes', 'pack', 'requestTimeout']);
      const before = asked.length;
      await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(A)), 'SETTING_DECLINED_THIS_SESSION');
      assert.strictEqual(asked.length, before, 'a latched session\'s shim is not asked');
      // a frame that is not "ok, no" latches nothing
      sources[B].emit('client', {status: 'failed', conditions: 'no', repo: null});
      sources[B].emit('client', {status: 'ok', conditions: 'yes', repo: null});
      assert.strictEqual(confirm.held(), 1, 'no store for B');
    });

    it('a client frame that said no since the last ask latches at the next one, before the shim is asked again', async () => {
      const t0 = tool();
      // C1 updates s.client in place at each frame; this one came unasked
      sources[A].client.conditions = 'no';
      const before = asked.length;
      await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(A)), 'SETTING_DECLINED_THIS_SESSION');
      assert.strictEqual(asked.length, before, 'the latest frame said it: nothing more is asked');
      sources[A].client.conditions = 'yes';
      await refused(t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A)), 'SETTING_DECLINED_THIS_SESSION');
      // a frame whose status is not ok is no "no": no form now, no latch
      sources[B].client.status = 'failed';
      sources[B].client.conditions = 'no';
      sources[B].answer = {status: 'failed', conditions: 'no', repo: null};
      await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(B)), 'SETTING_NEEDS_CONFIRMATION');
      assert.deepStrictEqual(confirm.confirmations(B).locks(), []);
    });

    it('a session that ends while its client is asked gets no form, and nothing of it is kept', async () => {
      const t0 = tool();
      sources[A].askConditions = async () => { sources[A].emit('end'); return {status: 'ok', conditions: 'yes', repo: null}; };
      await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(A)), 'MODULE_NOT_LISTED');
      assert.strictEqual(timers.filter((x) => !x.cleared).length, 0, 'no form was staged for it');
      assert.strictEqual(confirm.userWindow().count('requestTimeout'), 0);
      assert.strictEqual(confirm.held(), 0, 'no store was made again for A (B never asked, and has none)');
    });

    it('a session that ends while its client is asked at the confirmation: nothing is applied, and nothing of it is recorded or kept', async () => {
      const t0 = tool();
      const r = await t0.set('requestTimeout', '60s', 'settings tool', ctx(A));
      const lines = history().length;
      sources[A].askConditions = async () => { sources[A].emit('end'); return null; };
      await refused(t0.confirm('requestTimeout', '60s', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'MODULE_NOT_LISTED');
      assert.strictEqual(history().length, lines, 'no line for a session that is gone');
      // its end left nothing to count later either
      t0.writeCounts();
      assert.strictEqual(history().length, lines);
    });

    // my /code-review: the validators' growth is awaited, and can take
    // seconds. What was checked before it is checked again after it, with
    // no wait between the checks and the override.
    describe('after the validators have grown, everything is checked again', () => {
      const confirming = async (during, code) => {
        const t0 = tool({growValidators: async (bytes) => { grown.push(bytes); await during(t0); }});
        const r = await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A));
        const e = await refused(t0.confirm('maxOutputBytes', '16MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), code);
        assert.deepStrictEqual(grown, [16 * MiB], 'the growth ran');
        assert.ok(!settings.overridesOf(A).some((o) => o.loosening === true), 'no loosening was stored');
        return e;
      };

      it('the default tightened meanwhile (a terminal change): not applied, changed meanwhile', async () => {
        await confirming(async () => { options.maxOutputBytes = 4 * MiB; }, 'SETTING_CHANGED_MEANWHILE');
        assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 4 * MiB, 'the terminal\'s tightening binds A');
        assert.deepStrictEqual(history().filter((h) => h.session === A).map((h) => h.change), ['this session', 'not applied (changed meanwhile)']);
      });

      it('the session\'s own tightening meanwhile is not overwritten', async () => {
        await confirming(async (t0) => { await t0.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A)); }, 'SETTING_CHANGED_MEANWHILE');
        assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 2 * MiB);
      });

      it('the session latched meanwhile (its client reattached saying no): not applied', async () => {
        await confirming(async () => { sources[A].client.conditions = 'no'; sources[A].emit('attach'); }, 'SETTING_DECLINED_THIS_SESSION');
        assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 8 * MiB);
      });

      it('the session ended meanwhile: nothing is set for it', async () => {
        await confirming(async () => { sources[A].emit('end'); }, 'MODULE_NOT_LISTED');
      });

      it('the ceiling changed meanwhile: not applied, and the user may ask again', async () => {
        let c = {state: 'none'};
        const t0 = tool({ceiling: () => c, growValidators: async () => { c = {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 12 * MiB, forbid: [], conversation: true}}; }});
        const r = await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A));
        await refused(t0.confirm('maxOutputBytes', '16MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_CEILING_CHANGED_MEANWHILE');
        assert.strictEqual(settings.limitsOf(A), null);
      });
    });

    it('two forms left unanswered for another: the third ask gets no form, and is told the session is locked (not handed a form it could never accept)', async () => {
      const t0 = tool();
      await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A));
      const second = await t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A));
      assert.ok(second.inputRequired != null);
      await refused(t0.set('maxOutputBytes', '64MiB', 'settings tool', ctx(A)), 'SETTING_DECLINED_THIS_SESSION');
      assert.deepStrictEqual(history().filter((h) => h.session === A).map((h) => [h.asked, h.change]),
        [[16 * MiB, 'replaced'], [32 * MiB, 'replaced'], [64 * MiB, 'not confirmed (locked in this session)']]);
      // the second form's answer comes too late: it was left for another request
      await refused(t0.confirm('maxOutputBytes', '32MiB', {requestState: second.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_CONFIRMATION_INVALID');
      assert.strictEqual(settings.limitsOf(A), null);
    });

    it('an answer after the form\'s 120 s: told it expired, with one history line; a form pending at its session\'s end has its line too', async () => {
      const was = options.settingsFile;
      options.settingsFile = file;
      try {
        const t0 = tool();
        const r = await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A));
        advance(121 * 1000);
        await refused(t0.confirm('maxOutputBytes', '16MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_CONFIRMATION_EXPIRED');
        await refused(t0.confirm('maxOutputBytes', '16MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_CONFIRMATION_EXPIRED');
        assert.deepStrictEqual(history().filter((h) => h.session === A).map((h) => [h.asked, h.change]), [[16 * MiB, 'expired']]);
        // B ends with a form up, and with one its timer expired that nobody asked about since
        await t0.set('requestTimeout', '60s', 'settings tool', ctx(B));
        advance(121 * 1000);
        await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(B));
        const before = history().filter((h) => h.session === B).length;
        sources[B].emit('end');
        assert.deepStrictEqual(history().filter((h) => h.session === B).slice(before).map((h) => [h.setting, h.asked, h.change]), [['maxOutputBytes', 16 * MiB, 'expired']]);
        assert.deepStrictEqual(history().filter((h) => h.session === B && h.change === 'expired').map((h) => h.setting), ['requestTimeout', 'maxOutputBytes']);
      } finally {
        options.settingsFile = was;
      }
    });

    it('a confirmed loosening is one of a session\'s 32 recorded changes: with 32 made while its form was up, it is not applied', async () => {
      const t0 = tool();
      for (let i = 0; i < 31; i++) await t0.set('requestTimeout', String(30000 - 1 - i), 'settings tool', ctx(A));
      const r = await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A));
      await t0.set('requestTimeout', '20s', 'settings tool', ctx(A));   // the 32nd
      await refused(t0.confirm('maxOutputBytes', '16MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_TERMINAL_ONLY_SHARED');
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 8 * MiB);
      assert.strictEqual(history().filter((h) => h.session === A && h.new !== undefined && String(h.change).startsWith('this session')).length, 32);
    });

    it('a session\'s confirmed change that cannot be applied is said as the session\'s, not "this start"', async () => {
      const failing = tool({growValidators: async () => { throw Object.assign(new Error('no'), {code: 'RESIZE_FAILED'}); }});
      const r = await failing.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A));
      const e = await refused(failing.confirm('maxOutputBytes', '16MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_NOT_APPLIED_THIS_SESSION');
      assert.strictEqual(e.message, 'The change to maxOutputBytes for this session could not be applied (RESIZE_FAILED); nothing was changed.');
    });

    // the reviewer's two notes on #292
    it('with the user\'s window closed for the kind, the session\'s shim is not asked at all (its conditions cost a child process)', async () => {
      const t0 = tool();
      for (let i = 0; i < 3; i++) confirm.userWindow().note('maxOutputBytes');
      const before = asked.length;
      await refused(t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A)), 'SETTING_NEEDS_CONFIRMATION');
      assert.strictEqual(asked.length, before, 'no conditions? for a form that cannot be shown');
      assert.ok(history().some((h) => h.session === A && /too many declined or unanswered forms/.test(h.change)), JSON.stringify(history()));
      // another kind is asked as before
      assert.ok((await t0.set('requestTimeout', '60s', 'settings tool', ctx(A))).inputRequired != null);
      assert.strictEqual(asked.length, before + 1);
    });

    it('a client frame for a session that has ended latches nothing: no store is made for it', () => {
      const s = sources[A];
      s.emit('end');
      s.emit('client', {status: 'ok', conditions: 'no', repo: null});
      assert.strictEqual(confirm.held(), 0);
    });

    it('the ceiling binds a session\'s loosening: above it, refused with no form; conversation off, no form', async () => {
      const above = tool({ceiling: () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 12 * MiB, forbid: [], conversation: true}})});
      await refused(above.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A)), 'SETTING_ABOVE_CEILING');
      const off = tool({ceiling: () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], conversation: false}})});
      await refused(off.set('requestTimeout', '60s', 'settings tool', ctx(A)), 'SETTING_NEEDS_CONFIRMATION');
      assert.strictEqual(confirm.confirmations(A).formsLeft(), 3, 'no form was spent');
    });
  });
});

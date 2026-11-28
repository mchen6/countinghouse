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

// a list with a tested client (production's has none yet): the latch's own
// refusal, and a restored lock that may be a decline's
const TESTED = require('../../lib/elicitation-clients').listFrom({clients: [{name: 'claude-code', conditions: 'claude-code', tested: [{from: '2.1.323', before: '2.1.324'}]}]});
// and one with none, as production's is now
const NONE = require('../../lib/elicitation-clients').listFrom({clients: [{name: 'claude-code', conditions: 'claude-code', tested: []}]});

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
      assert.strictEqual(w.locked('enabled'), false);
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
        {kind: 'enabled', at: wall - 20 * MIN}, {kind: 'enabled', at: wall - 10 * MIN}, {kind: 'enabled', at: wall - 4 * MIN}]), true);
      assert.strictEqual(w.count('maxOutputBytes'), 1, 'the one inside the 30 minutes');
      assert.strictEqual(w.count('requestTimeout'), 1);
      assert.strictEqual(w.locked('maxOutputBytes'), false);
      assert.strictEqual(w.locked('enabled'), true);
      assert.deepStrictEqual(told, [], 'the daemon has them already');
      // one more decline of the first kind, here, and one in B: three within the window
      confirm.confirmations(A).decline('maxOutputBytes');
      confirm.confirmations(B).decline('maxOutputBytes');
      assert.strictEqual(w.locked('maxOutputBytes'), true);
      // the enabled lock runs 30 minutes from its third, which was 4 minutes ago
      advance(25 * MIN);
      assert.strictEqual(w.locked('enabled'), true);
      advance(2 * MIN);
      assert.strictEqual(w.locked('enabled'), false);
    });

    it('a lock still running is rebuilt: it runs 30 minutes from its third event, so events up to 60 minutes old count for it', () => {
      const w = confirm.userWindow();
      // declined 35, 25 and 10 minutes ago: locked since the third, for 20 minutes more
      assert.strictEqual(w.load([{kind: 'maxOutputBytes', at: WALL0 - 35 * MIN}, {kind: 'maxOutputBytes', at: WALL0 - 25 * MIN}, {kind: 'maxOutputBytes', at: WALL0 - 10 * MIN},
        // three, but never within one 30 minutes: no lock
        {kind: 'requestTimeout', at: WALL0 - 50 * MIN}, {kind: 'requestTimeout', at: WALL0 - 19 * MIN}, {kind: 'requestTimeout', at: WALL0 - 2 * MIN},
        // locked 61 minutes ago: over
        {kind: 'enabled', at: WALL0 - 65 * MIN}, {kind: 'enabled', at: WALL0 - 63 * MIN}, {kind: 'enabled', at: WALL0 - 61 * MIN}]), true);
      assert.strictEqual(w.locked('maxOutputBytes'), true);
      assert.strictEqual(w.count('maxOutputBytes'), 2, 'the two still inside the 30 minutes');
      assert.strictEqual(confirm.confirmations(A).stage(change(A)), null);
      assert.strictEqual(w.locked('requestTimeout'), false);
      assert.strictEqual(w.count('requestTimeout'), 2);
      assert.strictEqual(w.locked('enabled'), false);
      advance(19 * MIN);
      assert.strictEqual(w.locked('maxOutputBytes'), true);
      advance(2 * MIN);
      assert.strictEqual(w.locked('maxOutputBytes'), false);
      assert.strictEqual(confirm.LOAD_KEEP_MS, 60 * MIN, 'what the daemon must keep each decline for');
    });

    it('a list that is not exactly kinds and past times is dropped whole, and every kind is locked for 30 minutes (as when no list came: lockAll)', () => {
      const wall = WALL0;
      const good = {kind: 'enabled', at: wall - MIN};
      const bad = [null, 'x', {}, [good, {kind: 'locale', at: wall}], [good, {kind: 'enabled', at: wall + 61 * 1000}], [good, {kind: 'enabled', at: 1.5}], [good, {kind: 'enabled', at: -1}],
        [good, {kind: 'enabled', at: wall, session: A}], [good, null], Array.from({length: 65}, () => good)];
      for (const list of bad) {
        confirm.resetForTests();
        confirm.configure({now: () => clock, wall: () => WALL0 + (clock - 1000000), timer: () => null, clearTimer: () => {}, tell: (m) => told.push(m)});
        const w = confirm.userWindow();
        assert.strictEqual(w.load(list), false, JSON.stringify(list).slice(0, 80));
        for (const kind of ['maxOutputBytes', 'requestTimeout', 'enabled']) {
          assert.strictEqual(w.locked(kind), true, kind);
          assert.strictEqual(w.count(kind), 0, 'nothing of the list is kept');
        }
        assert.strictEqual(confirm.confirmations(A).stage(change(A)), null);
        assert.deepStrictEqual(told, []);
      }
      // a time up to a minute ahead of this clock is taken, as the daemon's restore allows it, and counts as now
      confirm.resetForTests();
      confirm.configure({now: () => clock, wall: () => WALL0 + (clock - 1000000), timer: () => null, clearTimer: () => {}, tell: (m) => told.push(m)});
      assert.strictEqual(confirm.userWindow().load([good, {kind: 'enabled', at: wall + 59 * 1000}]), true);
      assert.strictEqual(confirm.userWindow().count('enabled'), 2);
      // 64 is the most a list holds, and an empty one is a fresh start
      confirm.resetForTests();
      confirm.configure({now: () => clock, wall: () => WALL0 + (clock - 1000000), timer: () => null, clearTimer: () => {}, tell: (m) => told.push(m)});
      assert.strictEqual(confirm.userWindow().load(Array.from({length: 64}, () => ({kind: 'enabled', at: wall - 31 * MIN}))), true);
      assert.strictEqual(confirm.userWindow().load([]), true);
      assert.strictEqual(confirm.userWindow().locked('enabled'), false);
      // the safety net's own call (Task 6: no restore within 3 s)
      confirm.userWindow().lockAll();
      assert.strictEqual(confirm.userWindow().locked('requestTimeout'), true);
      advance(30 * MIN + 1);
      assert.strictEqual(confirm.userWindow().locked('requestTimeout'), false);
    });

    it('every module\'s on/off is one kind', () => {
      confirm.confirmations(A).decline('enabled.one');
      confirm.confirmations(B).decline('enabled.two');
      confirm.confirmations(C).decline('enabled.three');
      assert.strictEqual(confirm.userWindow().locked('enabled'), true);
      assert.strictEqual(confirm.confirmations(D).stage(change(D, {name: 'enabled.four', old: false, next: true, version: '1.0.0'})), null);
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
      confirm.confirmations(A).decline('enabled.one');
      confirm.confirmations(B).stage(change(B));
      advance(confirm.TTL_MS + 5);
      assert.deepStrictEqual(told.map((m) => [m.type, m.kind, Number.isInteger(m.at) && m.at > 0]), [['decline', 'enabled', true], ['decline', 'maxOutputBytes', true]]);
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
      for (const name of ['maxOutputBytes', 'requestTimeout', 'enabled.any']) assert.strictEqual(a.declined(name), true, name);
      assert.strictEqual(a.stage(change(A)), null);
      assert.strictEqual(confirm.confirmations(B).declined('maxOutputBytes'), false);
      for (const kind of ['maxOutputBytes', 'requestTimeout', 'enabled']) assert.strictEqual(confirm.userWindow().count(kind), 0, kind);
      assert.deepStrictEqual(told, [], 'it is not a decline of the user\'s');
      // the locks, as a session's export carries them (Task 6)
      assert.deepStrictEqual(a.locks(), ['enabled', 'maxOutputBytes', 'module', 'requestTimeout']);
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
      allowlist: TESTED,
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
      saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
      Object.assign(options, {maxOutputBytes: 8 * MiB, requestTimeout: 30000});
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

    // (the dry run, walk step 15a: a session that had lowered requestTimeout
    // to 10 s could not raise it back, and its composite tool timed out) a
    // session raises its own lowered value back in conversation, with no
    // form, up to and never above the value a session with no value of its
    // own runs at (the value for all sessions, under the ceiling). Above it,
    // a confirmed loosening as before; a kind locked in the session stays
    // locked; only the asking session changes; each undo is said and written
    describe('a session\'s own lowering, undone in conversation', () => {
      const noForm = () => tool({sessionClient: () => ({ok: false, why: 'not on the tested-client list'})});
      const at = (id) => ({shared: true, session: id, clientInfo: CLIENT, capabilities: {}});

      it('back to the value for all sessions: applied with no form, said and written; the other session untouched', async () => {
        const t0 = noForm();
        await t0.set('requestTimeout', '10s', 'settings tool', at(A));
        await t0.set('requestTimeout', '20s', 'settings tool', at(B));
        notices.take(null, A);
        notices.take(null, B);
        const done = await t0.set('requestTimeout', '30s', 'settings tool', at(A));
        assert.deepStrictEqual(done, {name: 'requestTimeout', old: 10000, new: 30000, applies: 'this session'});
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 30000);
        assert.deepStrictEqual(settings.overridesOf(A), [], 'its own value gone: it runs at the value for all sessions');
        assert.strictEqual(settings.effective(B, 'requestTimeout'), 20000, 'the other session untouched');
        assert.strictEqual(options.requestTimeout, 30000, 'the value for all sessions untouched');
        assert.ok(!fs.existsSync(file), 'settings.json never written');
        assert.deepStrictEqual(notices.take(null, A), ['requestTimeout back to 30s for this session: the value for all sessions (it had been lowered to 10s in this session)']);
        assert.deepStrictEqual(notices.take(null, B), [], 'told to the asking session alone');
        const line = history().pop();
        assert.deepStrictEqual((({at: t, ...rest}) => rest)(line), {by: 'settings tool', setting: 'requestTimeout', old: 10000, new: 30000, change: 'this session: its own lowering undone', session: A});
      });

      it('part of the way back: applied, still its own value', async () => {
        const t0 = noForm();
        await t0.set('requestTimeout', '10s', 'settings tool', at(A));
        notices.take(null, A);
        assert.deepStrictEqual(await t0.set('requestTimeout', '20s', 'settings tool', at(A)), {name: 'requestTimeout', old: 10000, new: 20000, applies: 'this session'});
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 20000);
        assert.deepStrictEqual(notices.take(null, A), ['requestTimeout raised to 20s for this session, toward the value for all sessions (30s); it had been lowered to 10s in this session']);
      });

      it('above the value for all sessions: a loosening, confirmed as before; nothing changed', async () => {
        const t0 = noForm();
        await t0.set('requestTimeout', '10s', 'settings tool', at(A));
        await refused(t0.set('requestTimeout', '45s', 'settings tool', at(A)), 'SETTING_NEEDS_CONFIRMATION');
        // (one millisecond past the bound is past it: #537's high, L6)
        await refused(t0.set('requestTimeout', '30001', 'settings tool', at(A)), 'SETTING_NEEDS_CONFIRMATION');
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000);
      });

      // (#537's high, M1) the user's window, as the loosening path reads it:
      // three declines across sessions, or a start with no restore table
      // (lockAll, fail closed), hold the undo too -- a session replayed after
      // that restart has lost its own lock, and the window is what remains
      it('the user\'s window locked: no undo here, said with its own reason', async () => {
        const t0 = noForm();
        await t0.set('requestTimeout', '10s', 'settings tool', at(A));
        require('../../lib/settings-confirm').userWindow().lockAll();
        const held = await refused(t0.set('requestTimeout', '30s', 'settings tool', at(A)), 'SETTING_SESSION_OWN_VALUE_HELD');
        assert.match(held.message, /\(changes to it in conversation are paused across your sessions, for up to 30 minutes\)/);
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000);
      });

      // (#537's high, L1) the ceiling read before the lock's wait, read again
      // under it: one the operator changed meanwhile applies nothing
      it('a ceiling changed during the lock\'s wait: nothing applied, said', async () => {
        let reads = 0;
        const t0 = tool({sessionClient: () => ({ok: false, why: 'x'}), ceiling: (o) => {
          if (o != null && o.cacheOnly === true) { reads += 1; return reads === 1 ? {state: 'trusted', ceiling: {conversation: false, forbid: []}} : {state: 'none'}; }
          return {state: 'none'};
        }});
        await t0.set('requestTimeout', '10s', 'settings tool', at(A));
        reads = 0;
        await refused(t0.set('requestTimeout', '30s', 'settings tool', at(A)), 'SETTING_CEILING_CHANGED_MEANWHILE');
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000);
        assert.deepStrictEqual((({setting, asked, change}) => [setting, asked, change])(history().pop()), ['requestTimeout', 30000, 'not applied (ceiling changed meanwhile)']);
      });

      it('a ceiling that cannot be trusted: the undo refused, as a loosening is', async () => {
        const t0 = tool({sessionClient: () => ({ok: false, why: 'x'}), ceiling: () => ({state: 'untrusted', file: 'ceiling.json', problem: 'x'})});
        await t0.set('requestTimeout', '10s', 'settings tool', at(A));
        await refused(t0.set('requestTimeout', '30s', 'settings tool', at(A)), 'SETTING_CEILING_UNTRUSTED');
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000);
      });

      it('a kind locked in the session stays locked: no undo in conversation', async () => {
        const t0 = tool();
        await t0.set('requestTimeout', '10s', 'settings tool', ctx(A));
        // a form for a loosening of the kind, declined: the kind is locked in A
        const r = await t0.set('requestTimeout', '45s', 'settings tool', ctx(A));
        assert.strictEqual((await t0.confirm('requestTimeout', '45s', {requestState: r.inputRequired.requestState, inputResponses: DECLINE}, ctx(A))).applies, 'declined');
        const held = await refused(t0.set('requestTimeout', '30s', 'settings tool', ctx(A)), 'SETTING_SESSION_OWN_VALUE_HELD');
        assert.strictEqual(held.message, 'This session set requestTimeout to 10s itself, and it cannot be raised back in conversation now (a change to it was declined or left unanswered in this session); nothing was changed. A change in a terminal would not move it: it sets the value for all sessions (30s), and this session keeps its own lower value. It ends with this session: restart your client, and its new session runs at 30s.');
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000);
      });

      // R-undo-latched (walk finding 6): a client whose conditions say "no" at
      // connect (any hook, or settings it can't read) latches every kind, and
      // the undo shows no form, so the latch has no bearing on it. A lock
      // that is, or might be, the user's own still holds it.
      describe('in a session its client has latched', () => {
        const NO = {status: 'ok', conditions: 'no', repo: null, why: {reason: 'client hook present', at: '~/.claude/settings.json'}};
        const L = '1'.repeat(32);
        const lower = async (t0, id = L) => { await t0.set('requestTimeout', '10s', 'settings tool', at(id)); notices.take(null, id); };
        const held = async (t0, why, id = L) => {
          const e = await refused(t0.set('requestTimeout', '30s', 'settings tool', at(id)), 'SETTING_SESSION_OWN_VALUE_HELD');
          assert.ok(e.message.includes(`(${why})`), e.message);
          assert.strictEqual(settings.effective(id, 'requestTimeout'), 10000);
        };
        const DECLINED = 'a change to it was declined or left unanswered in this session';
        const RESTORED = 'it may have been locked before the runtime restarted';

        it('at connect: its own lowering undone, back to the value for all sessions and part of the way, said and written', async () => {
          openSession(L, NO);
          assert.strictEqual(confirm.confirmations(L).latched(), true);
          const t0 = noForm();
          await lower(t0);
          assert.deepStrictEqual(await t0.set('requestTimeout', '20s', 'settings tool', at(L)), {name: 'requestTimeout', old: 10000, new: 20000, applies: 'this session'});
          assert.deepStrictEqual(await t0.set('requestTimeout', '30s', 'settings tool', at(L)), {name: 'requestTimeout', old: 20000, new: 30000, applies: 'this session'});
          assert.deepStrictEqual(settings.overridesOf(L), []);
          assert.deepStrictEqual(notices.take(null, L).length, 2, 'each said to it');
          assert.deepStrictEqual(history().filter((h) => h.change === 'this session: its own lowering undone').map((h) => [h.old, h.new, h.session]), [[10000, 20000, L], [20000, 30000, L]]);
          await t0.set('maxOutputBytes', '2MiB', 'settings tool', at(L));
          assert.strictEqual((await t0.set('maxOutputBytes', '8MiB', 'settings tool', at(L))).new, 8 * MiB);
        });

        it('latched after it lowered: undone too; still latched, its locks as they were', async () => {
          const t0 = noForm();
          await lower(t0, A);
          sources[A].emit('client', NO);
          assert.strictEqual((await t0.set('requestTimeout', '30s', 'settings tool', at(A))).new, 30000);
          assert.deepStrictEqual(confirm.confirmations(A).locks(), ['enabled', 'maxOutputBytes', 'module', 'requestTimeout']);
          assert.strictEqual(confirm.confirmations(A).latchedFor('requestTimeout'), true);
        });

        it('a loosening above the value for all sessions: refused with the latch\'s text, as before', async () => {
          openSession(L, NO);
          const t0 = tool();
          await lower(t0);
          const above = await refused(t0.set('requestTimeout', '45s', 'settings tool', ctx(L)), 'SETTING_CLIENT_NOT_CONFIRMED');
          assert.match(above.message, /client hook present: ~\/\.claude\/settings\.json/);
          await refused(t0.set('requestTimeout', '30001', 'settings tool', ctx(L)), 'SETTING_CLIENT_NOT_CONFIRMED');
          assert.strictEqual(settings.effective(L, 'requestTimeout'), 10000);
          assert.deepStrictEqual(asked, [], 'its client is not asked');
        });

        it('held by the user\'s decline before the latch', async () => {
          const t0 = tool();
          await lower(t0, A);
          const r = await t0.set('requestTimeout', '45s', 'settings tool', ctx(A));
          assert.strictEqual((await t0.confirm('requestTimeout', '45s', {requestState: r.inputRequired.requestState, inputResponses: DECLINE}, ctx(A))).applies, 'declined');
          sources[A].emit('client', NO);
          await held(t0, DECLINED, A);
          // (its other kinds are the latch's alone)
          await t0.set('maxOutputBytes', '2MiB', 'settings tool', at(A));
          assert.strictEqual((await t0.set('maxOutputBytes', '8MiB', 'settings tool', at(A))).new, 8 * MiB);
        });

        it('held by two forms left unanswered before the latch', async () => {
          const t0 = tool();
          await lower(t0, A);
          for (const v of ['45s', '50s', '55s']) { try { await t0.set('requestTimeout', v, 'settings tool', ctx(A)); } catch (e) { /* the third gets no form */ } }
          assert.strictEqual(confirm.confirmations(A).declined('requestTimeout'), true);
          sources[A].emit('client', NO);
          await held(t0, DECLINED, A);
        });

        // (its answer, a decline too, would come to a form that is gone)
        it('held by a form that was up when the latch fell, its answer lost; the window counts nothing', async () => {
          const t0 = tool();
          await lower(t0, A);
          const r = await t0.set('requestTimeout', '45s', 'settings tool', ctx(A));
          sources[A].emit('client', NO);
          await refused(t0.confirm('requestTimeout', '45s', {requestState: r.inputRequired.requestState, inputResponses: DECLINE}, ctx(A)), 'SETTING_CONFIRMATION_INVALID');
          await held(t0, DECLINED, A);
          assert.strictEqual(confirm.userWindow().count('requestTimeout'), 0);
          // the form's kind alone
          await t0.set('maxOutputBytes', '2MiB', 'settings tool', at(A));
          assert.strictEqual((await t0.set('maxOutputBytes', '8MiB', 'settings tool', at(A))).new, 8 * MiB);
        });

        it('held by a decline that comes after the latch', async () => {
          openSession(L, NO);
          const t0 = noForm();
          await lower(t0);
          confirm.confirmations(L).decline('requestTimeout');
          await held(t0, DECLINED);
        });

        // the limit: which of the two a lock across a restart was is not known
        it('held by a lock restored across a restart, before or after a fresh "no"', async () => {
          const t0 = noForm();
          confirm.confirmations(A).restore({locks: ['requestTimeout'], formsLeft: 3});
          await lower(t0, A);
          await held(t0, RESTORED, A);
          sources[A].emit('client', NO);
          assert.deepStrictEqual([confirm.confirmations(A).restoredFor('requestTimeout'), confirm.confirmations(A).latchedFor('requestTimeout')], [false, true], 'the latch\'s now');
          await held(t0, RESTORED, A);
          // restored after its latch: held too
          openSession(L, NO);
          confirm.confirmations(L).restore({locks: ['requestTimeout'], formsLeft: 3});
          await lower(t0);
          await held(t0, RESTORED);
        });

        it('a decline after a restored lock is said as the decline it is', async () => {
          const t0 = noForm();
          confirm.confirmations(A).restore({locks: ['requestTimeout'], formsLeft: 3});
          await lower(t0, A);
          confirm.confirmations(A).decline('requestTimeout');
          await held(t0, DECLINED, A);
        });

        it('a second "no" changes nothing of it', async () => {
          openSession(L, NO);
          const t0 = noForm();
          await lower(t0);
          sources[L].emit('client', NO);
          assert.strictEqual((await t0.set('requestTimeout', '30s', 'settings tool', at(L))).new, 30000);
        });

        for (const [what, lock] of [['three declines elsewhere', () => { for (let i = 0; i < 3; i++) confirm.userWindow().note('requestTimeout'); }],
          ['a start with no restore table', () => confirm.userWindow().lockAll()]]) {
          it(`held by the user's window (${what})`, async () => {
            openSession(L, NO);
            const t0 = noForm();
            await lower(t0);
            lock();
            await held(t0, 'changes to it in conversation are paused across your sessions, for up to 30 minutes');
          });
        }

        it('held by the ceiling\'s rules, and bounded by its value', async () => {
          openSession(L, NO);
          const withCeiling = (c) => tool({sessionClient: () => ({ok: false, why: 'x'}), ceiling: () => c});
          const off = withCeiling({state: 'trusted', ceiling: {conversation: false, forbid: []}});
          await lower(off);
          await held(off, 'the operator\'s ceiling turns changes in conversation off');
          await refused(withCeiling({state: 'trusted', ceiling: {conversation: true, forbid: ['requestTimeout']}}).set('requestTimeout', '30s', 'settings tool', at(L)), 'SETTING_FORBIDDEN_BY_CEILING');
          await refused(withCeiling({state: 'untrusted', file: 'ceiling.json', problem: 'x'}).set('requestTimeout', '30s', 'settings tool', at(L)), 'SETTING_CEILING_UNTRUSTED');
          const below = {state: 'trusted', ceiling: {conversation: true, forbid: [], requestTimeout: 20000}};
          settings.configure({ceiling: () => below});
          await refused(withCeiling(below).set('requestTimeout', '30s', 'settings tool', at(L)), 'SETTING_ABOVE_CEILING');
          assert.strictEqual((await withCeiling(below).set('requestTimeout', '20s', 'settings tool', at(L))).new, 20000);
        });

        it('a value marked as a confirmed loosening stays on the form\'s route: refused with the latch\'s text', async () => {
          openSession(L, NO);
          const t0 = tool();
          settings.set(L, 'requestTimeout', 40000, {loosening: true, over: 30000});
          assert.strictEqual(settings.overridesOf(L)[0].loosening, true);
          options.requestTimeout = 50000;
          settings.configure({ceiling: () => ({state: 'none'})});
          await refused(t0.set('requestTimeout', '45s', 'settings tool', ctx(L)), 'SETTING_CLIENT_NOT_CONFIRMED');
          assert.strictEqual(settings.effective(L, 'requestTimeout'), 40000);
        });
      });

      // (the medium on the undo) the operator's ceiling as for a loosening
      it('a ceiling that turns conversation off: no undo here, said honestly', async () => {
        const off = tool({sessionClient: () => ({ok: false, why: 'x'}), ceiling: () => ({state: 'trusted', ceiling: {conversation: false, forbid: []}})});
        await off.set('requestTimeout', '10s', 'settings tool', at(A));
        const held = await refused(off.set('requestTimeout', '30s', 'settings tool', at(A)), 'SETTING_SESSION_OWN_VALUE_HELD');
        assert.match(held.message, /\(the operator's ceiling turns changes in conversation off\)/);
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000);
      });

      it('a ceiling that forbids the setting in conversation: the undo refused as a loosening is, by the ceiling', async () => {
        const forbids = tool({sessionClient: () => ({ok: false, why: 'x'}), ceiling: () => ({state: 'trusted', ceiling: {conversation: true, forbid: ['requestTimeout']}})});
        await forbids.set('requestTimeout', '10s', 'settings tool', at(A));
        await refused(forbids.set('requestTimeout', '30s', 'settings tool', at(A)), 'SETTING_FORBIDDEN_BY_CEILING');
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000);
      });

      it('a ceiling below the value for all sessions bounds the undo: back to the ceiling\'s, never above', async () => {
        const below = {state: 'trusted', ceiling: {conversation: true, forbid: [], requestTimeout: 20000}};
        settings.configure({ceiling: () => below});
        const t0 = tool({sessionClient: () => ({ok: false, why: 'x'}), ceiling: () => below});
        await t0.set('requestTimeout', '10s', 'settings tool', at(A));
        notices.take(null, A);
        await refused(t0.set('requestTimeout', '30s', 'settings tool', at(A)), 'SETTING_ABOVE_CEILING');
        assert.deepStrictEqual(await t0.set('requestTimeout', '20s', 'settings tool', at(A)), {name: 'requestTimeout', old: 10000, new: 20000, applies: 'this session'});
        assert.deepStrictEqual(notices.take(null, A), ['requestTimeout back to 20s for this session: the value for all sessions (it had been lowered to 10s in this session)']);
      });

      it('a part-way undo the store refuses: its own value back, said as not made', async () => {
        const t0 = noForm();
        await t0.set('requestTimeout', '10s', 'settings tool', at(A));
        const realSet = settings.set;
        let once = true;
        settings.set = (...a) => {
          if (once) { once = false; throw Object.assign(new Error('the store refused it'), {code: 'SETTING_OUT_OF_BOUNDS'}); }
          return realSet(...a);
        };
        try {
          await refused(t0.set('requestTimeout', '20s', 'settings tool', at(A)), 'SETTING_OUT_OF_BOUNDS');
        } finally {
          settings.set = realSet;
        }
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000, 'never left at the value for all sessions');
        const last = history().pop();
        assert.deepStrictEqual([last.setting, last.change, last.problem], ['requestTimeout', 'not made', 'SETTING_OUT_OF_BOUNDS']);
      });

      it('maxOutputBytes, and past the session\'s budget: applied, its own line', async () => {
        const t0 = noForm();
        await t0.set('maxOutputBytes', '2MiB', 'settings tool', at(A));
        notices.take(null, A);
        assert.deepStrictEqual(await t0.set('maxOutputBytes', '8MiB', 'settings tool', at(A)), {name: 'maxOutputBytes', old: 2 * MiB, new: 8 * MiB, applies: 'this session'});
        assert.deepStrictEqual(notices.take(null, A), ['maxOutputBytes back to 8MiB for this session: the value for all sessions (it had been lowered to 2MiB in this session)']);
        // (the budget spent exactly, by tightenings alone: 2 changes above, 30 here)
        for (let i = 0; i < 30; i++) await t0.set('requestTimeout', String(29000 - i), 'settings tool', at(A));
        await t0.set('requestTimeout', '10s', 'settings tool', at(A));
        notices.take(null, A);
        assert.strictEqual((await t0.set('requestTimeout', '30s', 'settings tool', at(A))).new, 30000);
        // (#537's high, L6; L2) said every time, written as applied (`new`,
        // never `asked`), and the next one counted
        assert.deepStrictEqual(notices.take(null, A), ['requestTimeout back to 30s for this session: the value for all sessions (it had been lowered to 10s in this session)']);
        const past = () => history().filter((h) => h.session === A && /its own lowering undone, past this session's 32/.test(String(h.change)));
        assert.deepStrictEqual(past().map((h) => [h.new, h.asked]), [[30000, undefined]], JSON.stringify(history().slice(-3)));
        await t0.set('requestTimeout', '10s', 'settings tool', at(A));
        notices.take(null, A);
        assert.strictEqual((await t0.set('requestTimeout', '20s', 'settings tool', at(A))).new, 20000);
        assert.strictEqual(notices.take(null, A).length, 1, 'said again');
        t0.writeCounts();
        const counted = past().filter((h) => h.count != null);
        assert.deepStrictEqual(counted.map((h) => [h.count, h.latest]), [[1, 20000]], JSON.stringify(past()));
      });
    });

    // (up to 8 MiB, the value for all sessions, its own lowering is undone with
    // no form: the case below, 'a session\'s own lowering, undone')
    it('A, at 2 MiB, asks for 12 MiB (above the value for all sessions): a form that says "this session"; accepted, A runs at 12 MiB and nothing else changes', async () => {
      const t0 = tool();
      await t0.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A));
      const before = {live: settingsTool.liveOptions()};
      const r = await t0.set('maxOutputBytes', '12MiB', 'settings tool', ctx(A));
      const form = r.inputRequired.inputRequests.approve;
      assert.strictEqual(form.params.message, 'Allow countinghouse tools to return up to 12MiB per call in this session (now 2MiB)? This applies to this session only, until it ends.');
      assert.deepStrictEqual(form.params.requestedSchema, {type: 'object', properties: {approve: {type: 'boolean', title: 'Approve'}}, required: ['approve']});
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 2 * MiB, 'nothing yet');
      const done = await t0.confirm('maxOutputBytes', '12MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A));
      assert.deepStrictEqual(done, {name: 'maxOutputBytes', old: 2 * MiB, new: 12 * MiB, applies: 'this session'});
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 12 * MiB);
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 8 * MiB);
      assert.strictEqual(settings.limitsOf(B), null);
      assert.strictEqual(options.maxOutputBytes, 8 * MiB, 'the shared option');
      assert.deepStrictEqual(settingsTool.liveOptions(), before.live);
      assert.ok(!fs.existsSync(file), 'settings.json never written');
      const line = history().pop();
      assert.deepStrictEqual((({at, ...rest}) => rest)(line), {by: 'settings tool', setting: 'maxOutputBytes', old: 2 * MiB, new: 12 * MiB, change: 'this session',
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

    it('the form\'s text says "this session", for both caps', async () => {
      const en = await tool().set('requestTimeout', '60s', 'settings tool', ctx(A));
      assert.strictEqual(en.inputRequired.inputRequests.approve.params.message,
        'Allow countinghouse tool calls to run for up to 60s in this session (now 30s)? This applies to this session only, until it ends.');
      const caps = await tool().set('maxOutputBytes', '16MiB', 'settings tool', ctx(B));
      assert.strictEqual(caps.inputRequired.inputRequests.approve.params.message, 'Allow countinghouse tools to return up to 16MiB per call in this session (now 8MiB)? This applies to this session only, until it ends.');
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
      assert.strictEqual(locked.message, 'Loosening maxOutputBytes is not asked again in this session (it was declined or left unanswered here); '
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

    // The latch's own refusal (after A's M17 run): it says why, never that the user declined
    it('a latched session is refused SETTING_CLIENT_NOT_CONFIRMED, naming why; a real decline keeps its own code and text', async () => {
      const t0 = tool();
      sources[A].answer = {status: 'ok', conditions: 'no', repo: null, why: {reason: 'project plugin or marketplace', at: '~/.claude/settings.json'}};
      const e = await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(A)), 'SETTING_CLIENT_NOT_CONFIRMED');
      assert.match(e.message, /this client's configuration could answer forms by itself \(project plugin or marketplace: ~\/\.claude\/settings\.json\)/);
      assert.doesNotMatch(e.message, /declined/);
      assert.match(e.message, /ch-local settings set requestTimeout 60s/);
      // later asks too, and of every kind, with the same why: one "no" is final
      sources[A].answer = {status: 'ok', conditions: 'yes', repo: null};
      const again = await refused(t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A)), 'SETTING_CLIENT_NOT_CONFIRMED');
      assert.match(again.message, /project plugin or marketplace/);
      // no why given, or one the rule refuses: it could not be confirmed, and no path is said
      sources[B].answer = {status: 'ok', conditions: 'no', repo: null, why: {reason: 'client hook present', at: '/home/x/.claude/settings.json'}};
      const none = await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(B)), 'SETTING_CLIENT_NOT_CONFIRMED');
      assert.match(none.message, /this client could not be confirmed/);
      assert.doesNotMatch(none.message, /\/home\/x/);
    });

    // R-latched-refusal-text: with no tested client no session can be shown a
    // form, so that one could be answered for the user is no reason: a
    // latched session gets exactly the answer an unlatched one gets
    // A no-form answer to a session that lowered a cap itself and asks above the value for all sessions names a terminal
    // command that sets the value for all sessions, which this session's own lower value then still holds below: the
    // answer says so, and the real next step, read from the same function that decides the way back (the undo above).
    describe('a no-form answer, when the session\'s own lower value is why its command would not move it', () => {
      const {CountinghouseError} = require('../../lib/countinghouse-error');
      const NO = {status: 'ok', conditions: 'no', repo: null, why: {reason: 'client hook present', at: '~/.claude/settings.json'}};
      const L = '5'.repeat(32);
      const at = (id) => ({shared: true, session: id, clientInfo: CLIENT, capabilities: {}});
      const noForm = (o = {}) => tool(Object.assign({sessionClient: () => ({ok: false, why: 'not on the tested-client list'})}, o));
      const lower = async (t0, id = A) => { await t0.set('requestTimeout', '10s', 'settings tool', at(id)); notices.take(null, id); };
      const base = (code, fields) => CountinghouseError.withFields(code, Object.assign({name: 'requestTimeout', command: settingsTool.commandFor('requestTimeout', 45000)}, fields)).message;
      const LEAD = 'This session keeps its own lower value (10s), so that command alone won\'t change requestTimeout here: ';
      const RESTART = 'after it, restart your client to get a session with the new value.';
      const ASK = 'after it, ask again here to raise this session\'s value too.';
      const PAUSED = 'after it, ask again here once the pause on new questions ends (at most 30 minutes), or restart your client.';
      const LATER = ' A value above what this runtime started with takes effect when it next starts.';
      // (the runtime started above the value for all sessions, which the terminal lowered since: 45s is under its start)
      const startedHigher = () => { options.requestTimeout = 60000; settingsTool.captureAtStart(); options.requestTimeout = 30000; };
      const asked = async (t0, code, id = A, c = ctx) => refused(t0.set('requestTimeout', '45s', 'settings tool', c(id)), code);
      const says = (e, code, fields, tail) => assert.strictEqual(e.message, `${base(code, fields)}${tail == null ? '' : ` ${tail}`}`);
      // the way back, once the terminal command has raised the value for all sessions to 45s: held, or made
      const wayBack = async (t0, open, id = A) => {
        options.requestTimeout = 45000;
        if (open) assert.strictEqual((await t0.set('requestTimeout', '45s', 'settings tool', at(id))).new, 45000);
        else await refused(t0.set('requestTimeout', '45s', 'settings tool', at(id)), 'SETTING_SESSION_OWN_VALUE_HELD');
      };

      it('the words, as business gave them (validation 04 pins the table)', () => {
        assert.deepStrictEqual(settingsTool.OWN_LOWER, {lead: 'This session keeps its own lower value ({current}), so that command alone won\'t change {name} here: ', restart: RESTART, ask: ASK, paused: PAUSED, later: LATER});
        assert.ok(base('SETTING_DECLINED_THIS_SESSION', {}).includes('settings set requestTimeout 45s`'), 'the command, by cliValue, is in the base text');
      });

      describe('restart (the way back is held)', () => {
        for (const later of [true, false]) {
          it(`declined here: DECLINED, restart${later ? ', with the start value\'s wait' : ''}; the undo then held`, async () => {
            if (!later) startedHigher();
            const t0 = tool();
            await lower(t0);
            const r = await t0.set('requestTimeout', '45s', 'settings tool', ctx(A));
            await t0.confirm('requestTimeout', '45s', {requestState: r.inputRequired.requestState, inputResponses: DECLINE}, ctx(A));
            says(await asked(t0, 'SETTING_DECLINED_THIS_SESSION'), 'SETTING_DECLINED_THIS_SESSION', {}, LEAD + RESTART + (later ? LATER : ''));
            await wayBack(t0, false);
          });

          it(`a lock back after a restart, where forms can be shown: LOCKED, restart${later ? ', with the wait' : ''}; the undo then held`, async () => {
            if (!later) startedHigher();
            const t0 = tool();
            await lower(t0);
            confirm.confirmations(A).restore({locks: ['requestTimeout'], formsLeft: 3});
            says(await asked(t0, 'SETTING_LOCKED_THIS_SESSION'), 'SETTING_LOCKED_THIS_SESSION', {}, LEAD + RESTART + (later ? LATER : ''));
            await wayBack(t0, false);
          });
        }

        it('conversation off by the ceiling: NEEDS_CONFIRMATION, restart, never the wait (its text says it); the undo then held', async () => {
          const off = {state: 'trusted', ceiling: {conversation: false, forbid: []}};
          const t0 = noForm({ceiling: () => off});
          await lower(t0);
          says(await asked(t0, 'SETTING_NEEDS_CONFIRMATION'), 'SETTING_NEEDS_CONFIRMATION', {value: '45s'}, LEAD + RESTART);
          await wayBack(t0, false);
        });
      });

      describe('ask again (the way back is open), and the pause', () => {
        for (const later of [true, false]) {
          it(`the latch: CLIENT_NOT_CONFIRMED, ask again${later ? ', with the wait' : ''}; the undo then made`, async () => {
            if (!later) startedHigher();
            openSession(L, NO);
            const t0 = tool();
            await lower(t0, L);
            const e = await asked(t0, 'SETTING_CLIENT_NOT_CONFIRMED', L);
            assert.ok(e.message.endsWith(` ${LEAD}${ASK}${later ? LATER : ''}`), e.message);
            await wayBack(t0, true, L);
          });

          it(`past the session's 32 recorded changes: TERMINAL_ONLY_SHARED, ask again${later ? ', with the wait' : ''}; the undo then made`, async () => {
            if (!later) startedHigher();
            const t0 = noForm();
            for (let i = 0; i < 32; i++) await t0.set('requestTimeout', String(10000 + (i % 2)), 'settings tool', at(A));
            await t0.set('requestTimeout', '10s', 'settings tool', at(A)).catch(() => {});
            assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000);
            says(await asked(t0, 'SETTING_TERMINAL_ONLY_SHARED'), 'SETTING_TERMINAL_ONLY_SHARED', {}, LEAD + ASK + (later ? LATER : ''));
            await wayBack(t0, true);
          });
        }

        it('a lock back after a restart with no tested client: LOCKED, ask again (it does not hold the undo there); the undo then made', async () => {
          const t0 = tool({allowlist: NONE});
          await lower(t0);
          confirm.confirmations(A).restore({locks: ['requestTimeout'], formsLeft: 3});
          says(await asked(t0, 'SETTING_LOCKED_THIS_SESSION'), 'SETTING_LOCKED_THIS_SESSION', {}, LEAD + ASK + LATER);
          await wayBack(t0, true);
        });

        it('the latch with no tested client: NEEDS_CONFIRMATION, ask again', async () => {
          openSession(L, NO);
          const t0 = tool({allowlist: NONE});
          await lower(t0, L);
          says(await asked(t0, 'SETTING_NEEDS_CONFIRMATION', L), 'SETTING_NEEDS_CONFIRMATION', {value: '45s'}, LEAD + ASK);
          await wayBack(t0, true, L);
        });

        it('no forms left in this session: NEEDS_CONFIRMATION, ask again', async () => {
          const t0 = tool();
          await lower(t0);
          confirm.confirmations(A).restore({locks: [], formsLeft: 0});
          says(await asked(t0, 'SETTING_NEEDS_CONFIRMATION'), 'SETTING_NEEDS_CONFIRMATION', {value: '45s'}, LEAD + ASK);
          await wayBack(t0, true);
        });

        it('a client that cannot show a form: NEEDS_CONFIRMATION, ask again', async () => {
          const t0 = noForm();
          await lower(t0);
          says(await asked(t0, 'SETTING_NEEDS_CONFIRMATION'), 'SETTING_NEEDS_CONFIRMATION', {value: '45s'}, LEAD + ASK);
          await wayBack(t0, true);
        });

        it('the user\'s window paused: NEEDS_CONFIRMATION (no forms left) and the client that cannot show one, the pause; the undo then held', async () => {
          const t0 = noForm();
          await lower(t0);
          confirm.userWindow().lockAll();
          says(await asked(t0, 'SETTING_NEEDS_CONFIRMATION'), 'SETTING_NEEDS_CONFIRMATION', {value: '45s'}, LEAD + PAUSED);
          confirm.confirmations(A).restore({locks: [], formsLeft: 0});
          says(await asked(t0, 'SETTING_NEEDS_CONFIRMATION'), 'SETTING_NEEDS_CONFIRMATION', {value: '45s'}, LEAD + PAUSED);
          await wayBack(t0, false);
        });

        for (const later of [true, false]) {
          it(`the latch, the window paused: CLIENT_NOT_CONFIRMED, the pause${later ? ', with the wait' : ''}`, async () => {
            if (!later) startedHigher();
            openSession(L, NO);
            const t0 = tool();
            await lower(t0, L);
            confirm.userWindow().lockAll();
            const e = await asked(t0, 'SETTING_CLIENT_NOT_CONFIRMED', L);
            assert.ok(e.message.endsWith(` ${LEAD}${PAUSED}${later ? LATER : ''}`), e.message);
          });

          it(`past 32 changes, the window paused: TERMINAL_ONLY_SHARED, the pause${later ? ', with the wait' : ''}`, async () => {
            if (!later) startedHigher();
            const t0 = noForm();
            for (let i = 0; i < 32; i++) await t0.set('requestTimeout', String(10000 + (i % 2)), 'settings tool', at(A));
            await t0.set('requestTimeout', '10s', 'settings tool', at(A)).catch(() => {});
            confirm.userWindow().lockAll();
            says(await asked(t0, 'SETTING_TERMINAL_ONLY_SHARED'), 'SETTING_TERMINAL_ONLY_SHARED', {}, LEAD + PAUSED + (later ? LATER : ''));
          });
        }
      });

      describe('nothing appended otherwise', () => {
        it('a session with no value of its own: each answer as today, word for word', async () => {
          const t0 = noForm();
          says(await asked(t0, 'SETTING_NEEDS_CONFIRMATION', B), 'SETTING_NEEDS_CONFIRMATION', {value: '45s'}, null);
          const t1 = tool();
          const r = await t1.set('requestTimeout', '45s', 'settings tool', ctx(B));
          await t1.confirm('requestTimeout', '45s', {requestState: r.inputRequired.requestState, inputResponses: DECLINE}, ctx(B));
          says(await asked(t1, 'SETTING_DECLINED_THIS_SESSION', B), 'SETTING_DECLINED_THIS_SESSION', {}, null);
          confirm.confirmations(B).restore({locks: ['requestTimeout'], formsLeft: 3});
          says(await asked(t1, 'SETTING_DECLINED_THIS_SESSION', B), 'SETTING_DECLINED_THIS_SESSION', {}, null);
        });

        it('a session whose own value is not lower than the value for all sessions (a confirmed loosening): as today', async () => {
          const t0 = noForm();
          settings.set(B, 'requestTimeout', 40000, {loosening: true, over: 30000});
          options.requestTimeout = 50000;
          says(await refused(t0.set('requestTimeout', '45s', 'settings tool', ctx(B)), 'SETTING_NEEDS_CONFIRMATION'), 'SETTING_NEEDS_CONFIRMATION', {value: '45s'}, null);
        });

        it('a change asked for all sessions: as today (that change is the one the command makes)', async () => {
          const t0 = noForm();
          await lower(t0);
          const all = (id) => Object.assign(ctx(id), {scope: 'all-sessions'});
          const e = await refused(t0.set('requestTimeout', '45s', 'settings tool', all(A)), 'SETTING_NEEDS_CONFIRMATION');
          assert.ok(!e.message.includes('This session keeps its own lower value'), e.message);
        });
      });
    });

    describe('with no tested client (production\'s list), a latched session\'s refusals', () => {
      const {ALLOWLIST, noClientTested, listFrom} = require('../../lib/elicitation-clients');
      const NO = {status: 'ok', conditions: 'no', repo: null, why: {reason: 'client settings unreadable'}};
      const production = (o = {}) => tool(Object.assign({allowlist: NONE, sessionClient: undefined}, o));
      const said = async (p) => { try { await p; } catch (e) { return {code: e.code, message: e.message}; } return assert.fail('not refused'); };
      const L = '3'.repeat(32);
      beforeEach(() => { openSession(L, NO); assert.strictEqual(confirm.confirmations(L).latched(), true); });

      it('the condition: a list read whole, with no tested range; what could not be read is not "none"', () => {
        assert.strictEqual(noClientTested(ALLOWLIST), true, 'a tested range listed: move this line, and sessions 09\'s and session-runtime 16\'s pins with it');
        assert.strictEqual(noClientTested(NONE), true);
        assert.strictEqual(noClientTested(TESTED), false);
        const entry = (tested) => ({name: 'claude-code', conditions: 'claude-code', tested});
        for (const data of [null, undefined, {}, {clients: 'x'}, {clients: [null]}, {clients: [{name: 1, conditions: 'x', tested: []}]}, {clients: [{name: 'claude-code', conditions: 'x'}]},
          {clients: [entry('x')]}, {clients: [entry([{from: '2.1.3', before: '2.1.1'}])]}, {clients: [entry([null])]}, {clients: [entry([{from: '2.1.1', before: '2.1.2', to: 1}])]},
          {clients: [entry([]), null]}]) {
          assert.strictEqual(noClientTested(listFrom(data)), false, JSON.stringify(data));
        }
        // (a list not made here says nothing of how it was read)
        assert.strictEqual(noClientTested([]), false);
      });

      it('a list that could not be read: the latch\'s own refusal, and a restored lock holds the undo, as with a tested client', async () => {
        const unread = {allowlist: listFrom(null), sessionClient: undefined};
        assert.strictEqual((await said(tool(unread).set('requestTimeout', '60s', 'settings tool', ctx(L)))).code, 'SETTING_CLIENT_NOT_CONFIRMED');
        confirm.confirmations(A).restore({locks: ['requestTimeout'], formsLeft: 3});
        await tool(unread).set('requestTimeout', '10s', 'settings tool', ctx(A));
        assert.strictEqual((await said(tool(unread).set('requestTimeout', '30s', 'settings tool', ctx(A)))).code, 'SETTING_SESSION_OWN_VALUE_HELD');
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000);
      });

      for (const [name, value] of [['requestTimeout', '60s'], ['requestTimeout', '30001'], ['maxOutputBytes', '16MiB'], ['maxOutputBytes', '8388609']]) {
        for (const scope of [undefined, 'all-sessions']) {
          it(`${name} ${value}${scope != null ? ', for all sessions' : ''}: the unlatched session's answer, word for word; its client not asked`, async () => {
            const at = (id) => Object.assign(ctx(id), scope != null ? {scope} : {});
            const latched = await said(production().set(name, value, 'settings tool', at(L)));
            assert.deepStrictEqual(latched, await said(production().set(name, value, 'settings tool', at(A))));
            assert.strictEqual(latched.code, 'SETTING_NEEDS_CONFIRMATION');
            assert.match(latched.message, new RegExp(`^Changing ${name} to ${value === '30001' ? '30001ms' : value === '8388609' ? '8388609B' : value} loosens`));
            assert.deepStrictEqual(asked, []);
            // what is kept: the latch, its locks, and the history's own line
            assert.strictEqual(confirm.confirmations(L).latchedFor(name), true);
            assert.deepStrictEqual(confirm.confirmations(L).locks(), ['enabled', 'maxOutputBytes', 'module', 'requestTimeout']);
            assert.strictEqual(history().find((h) => h.session === L).change, 'not confirmed (locked in this session)');
          });
        }
      }

      // (the kinds module and enabled answer a locked session with their own
      // terminal text: the same before and after, whatever the list)
      it('a module turned on, and a module setting that needs confirmation: the unlatched session\'s answer too', async () => {
        const ms = require('../../lib/module-settings');
        const pkg = {name: '@acme/weather-tool', version: '1.2.0', countinghouse: {settings: {shareStats: {type: 'boolean', default: false, confirm: true}}}};
        fs.writeFileSync(path.join(home, 'modules.json'), JSON.stringify({modules: {'@acme/weather-tool': {version: '1.2.0', role: 'scenario'}}, packs: {p: {modules: {'@acme/weather-tool': '1.2.0'}}}}));
        fs.writeFileSync(file, JSON.stringify({version: 1, values: {'enabled.@acme/weather-tool': false}}));
        const stub = {loadedTops: () => [], loadingTops: () => [], startingUp: () => false,
          moduleStates: () => [{name: pkg.name, version: pkg.version, pkg, part: false, state: ms.stateFor(pkg.name, pkg, {operator: false, net: []})}]};
        for (const [name, value, code] of [['enabled.@acme/weather-tool', 'on', 'SETTING_NEEDS_CONFIRMATION'], ['module.@acme/weather-tool.shareStats', true, 'SETTING_MODULE_NEEDS_CONFIRMATION']]) {
          const latched = await said(production(stub).set(name, value, 'settings tool', ctx(L)));
          assert.deepStrictEqual(latched, await said(production(stub).set(name, value, 'settings tool', ctx(A))), name);
          assert.strictEqual(latched.code, code);
        }
      });

      it('a value of its own above the default is judged the same, latched after it', async () => {
        settings.set(B, 'requestTimeout', 40000, {loosening: true, over: 30000});
        settings.set(L, 'requestTimeout', 40000, {loosening: true, over: 30000});
        assert.deepStrictEqual(await said(production().set('requestTimeout', '45s', 'settings tool', ctx(L))), await said(production().set('requestTimeout', '45s', 'settings tool', ctx(B))));
      });

      it('a tested client listed: the latch\'s own refusal, as before', async () => {
        assert.strictEqual((await said(tool().set('requestTimeout', '60s', 'settings tool', ctx(L)))).code, 'SETTING_CLIENT_NOT_CONFIRMED');
        assert.strictEqual((await said(tool().set('requestTimeout', '60s', 'settings tool', Object.assign(ctx(L), {scope: 'all-sessions'})))).code, 'SETTING_CLIENT_NOT_CONFIRMED');
      });

      it('a decline keeps its answer, and a restored lock its own; a fresh "no" on that one is the latch\'s', async () => {
        confirm.confirmations(A).decline('requestTimeout');
        assert.strictEqual((await said(production().set('requestTimeout', '60s', 'settings tool', ctx(A)))).code, 'SETTING_DECLINED_THIS_SESSION');
        sources[A].emit('client', NO);
        assert.strictEqual((await said(production().set('requestTimeout', '60s', 'settings tool', ctx(A)))).code, 'SETTING_DECLINED_THIS_SESSION', 'a kind declined before the latch stays the user\'s');
        confirm.confirmations(B).restore({locks: ['requestTimeout'], formsLeft: 3});
        assert.strictEqual((await said(production().set('requestTimeout', '60s', 'settings tool', ctx(B)))).code, 'SETTING_LOCKED_THIS_SESSION');
        sources[B].emit('client', NO);
        assert.strictEqual((await said(production().set('requestTimeout', '60s', 'settings tool', ctx(B)))).code, 'SETTING_NEEDS_CONFIRMATION');
      });

      it('the ceiling first, as before', async () => {
        const off = {ceiling: () => ({state: 'trusted', ceiling: {conversation: true, forbid: ['requestTimeout']}})};
        assert.strictEqual((await said(production(off).set('requestTimeout', '60s', 'settings tool', ctx(L)))).code, 'SETTING_FORBIDDEN_BY_CEILING');
      });
    });

    // R-undo-after-restart: a restored lock may be a decline's only where a
    // form could have been shown; with no tested client none is, so it
    // doesn't hold the undo of the session's own lowering
    describe('with no tested client, a lock restored across a restart and the undo of a session\'s own lowering', () => {
      const NO = {status: 'ok', conditions: 'no', repo: null, why: {reason: 'client settings unreadable'}};
      const production = (o = {}) => tool(Object.assign({allowlist: NONE, sessionClient: undefined}, o));
      const lower = async (t0, id) => { await t0.set('requestTimeout', '10s', 'settings tool', ctx(id)); notices.take(null, id); };
      const ALL_KINDS = ['enabled', 'maxOutputBytes', 'module', 'requestTimeout'];

      for (const fresh of [false, true]) {
        it(`a latched session resumed after a restart${fresh ? ', its client saying "no" again' : ''}: undone with no tested client, held with one`, async () => {
          // as the restart leaves it: the locks and its own value, replayed
          confirm.confirmations(A).restore({locks: ALL_KINDS, formsLeft: 3});
          if (fresh) sources[A].emit('client', NO);
          await lower(production(), A);
          const held = await refused(tool().set('requestTimeout', '30s', 'settings tool', ctx(A)), 'SETTING_SESSION_OWN_VALUE_HELD');
          assert.match(held.message, /\(it may have been locked before the runtime restarted\)/);
          assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000);
          assert.strictEqual((await production().set('requestTimeout', '20s', 'settings tool', ctx(A))).new, 20000);
          assert.strictEqual((await production().set('requestTimeout', '30s', 'settings tool', ctx(A))).new, 30000);
          assert.deepStrictEqual(settings.overridesOf(A), []);
          // the lock itself is as it was
          assert.deepStrictEqual(confirm.confirmations(A).locks(), ALL_KINDS);
          assert.strictEqual(confirm.confirmations(A).userLockOf('requestTimeout'), 'restored');
        });
      }

      // the other order of a resume: its client's frame latches it before the
      // daemon's row is applied
      it('latched first, then its locks restored: the latch\'s refusal, and the undo as a restored lock\'s', async () => {
        sources[A].emit('client', NO);
        confirm.confirmations(A).restore({locks: ALL_KINDS, formsLeft: 3});
        assert.strictEqual(confirm.confirmations(A).latchedFor('requestTimeout'), true);
        assert.strictEqual(confirm.confirmations(A).userLockOf('requestTimeout'), 'restored');
        await refused(production().set('requestTimeout', '45s', 'settings tool', ctx(A)), 'SETTING_NEEDS_CONFIRMATION');
        await refused(tool().set('requestTimeout', '45s', 'settings tool', ctx(A)), 'SETTING_CLIENT_NOT_CONFIRMED');
        await lower(production(), A);
        await refused(tool().set('requestTimeout', '30s', 'settings tool', ctx(A)), 'SETTING_SESSION_OWN_VALUE_HELD');
        assert.strictEqual((await production().set('requestTimeout', '30s', 'settings tool', ctx(A))).new, 30000);
        // (a decline after it all is the user's)
        confirm.confirmations(A).decline('requestTimeout');
        assert.strictEqual(confirm.confirmations(A).userLockOf('requestTimeout'), 'user');
      });

      it('a loosening above the value for all sessions is refused all the same, changing nothing', async () => {
        confirm.confirmations(A).restore({locks: ALL_KINDS, formsLeft: 3});
        await lower(production(), A);
        await refused(production().set('requestTimeout', '45s', 'settings tool', ctx(A)), 'SETTING_LOCKED_THIS_SESSION');
        await refused(production().set('requestTimeout', '30001', 'settings tool', ctx(A)), 'SETTING_LOCKED_THIS_SESSION');
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000);
      });

      it('the user\'s own lock in this runtime holds it: a decline, also after a restored lock; a form up when the latch fell', async () => {
        confirm.confirmations(A).restore({locks: ['requestTimeout'], formsLeft: 3});
        confirm.confirmations(A).decline('requestTimeout');
        await lower(production(), A);
        const e = await refused(production().set('requestTimeout', '30s', 'settings tool', ctx(A)), 'SETTING_SESSION_OWN_VALUE_HELD');
        assert.match(e.message, /declined or left unanswered in this session/);
        await lower(production(), B);
        const t0 = tool();
        await t0.set('requestTimeout', '45s', 'settings tool', ctx(B));
        sources[B].emit('client', NO);
        await refused(production().set('requestTimeout', '30s', 'settings tool', ctx(B)), 'SETTING_SESSION_OWN_VALUE_HELD');
      });

      it('the user\'s window and the ceiling hold it', async () => {
        confirm.confirmations(A).restore({locks: ALL_KINDS, formsLeft: 3});
        await lower(production(), A);
        const off = {ceiling: () => ({state: 'trusted', ceiling: {conversation: false, forbid: []}})};
        assert.match((await refused(production(off).set('requestTimeout', '30s', 'settings tool', ctx(A)), 'SETTING_SESSION_OWN_VALUE_HELD')).message, /ceiling turns changes in conversation off/);
        confirm.userWindow().lockAll();
        assert.match((await refused(production().set('requestTimeout', '30s', 'settings tool', ctx(A)), 'SETTING_SESSION_OWN_VALUE_HELD')).message, /paused across your sessions/);
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000);
      });
    });

    // The reviewer's ruling (c) on #337: a lock restored from the daemon's row has an unknown origin (a
    // decline or a latch before the restart), so its refusal claims neither. A fresh "no" re-latches with its why.
    it('a lock restored across a restart is told neutrally, never "declined"; a fresh "no" then gives the latch\'s text with its why', async () => {
      const t0 = tool();
      confirm.confirmations(A).restore({locks: ['maxOutputBytes', 'enabled', 'requestTimeout'], formsLeft: 3});
      const restored = await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(A)), 'SETTING_LOCKED_THIS_SESSION');
      assert.doesNotMatch(restored.message, /declined|configuration/);
      assert.match(restored.message, /ch-local settings set requestTimeout 60s/);
      sources[A].emit('client', {status: 'ok', conditions: 'no', repo: null, why: {reason: 'client hook present', at: '~/.claude/settings.json'}});
      const latched = await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(A)), 'SETTING_CLIENT_NOT_CONFIRMED');
      assert.match(latched.message, /client hook present: ~\/\.claude\/settings\.json/);
      // a lock made in this runtime's life keeps its own text: a decline in B is a decline
      const r = await t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(B));
      await t0.confirm('maxOutputBytes', '16MiB', {requestState: r.inputRequired.requestState, inputResponses: DECLINE}, ctx(B));
      await refused(t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(B)), 'SETTING_DECLINED_THIS_SESSION');
    });

    it('one "conditions: no" from a session\'s client latches it: no form of any kind for its life, though a later answer says yes (N1)', async () => {
      const t0 = tool();
      sources[A].answer = {status: 'ok', conditions: 'no', repo: null};
      await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(A)), 'SETTING_CLIENT_NOT_CONFIRMED');
      sources[A].answer = {status: 'ok', conditions: 'yes', repo: null};
      await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(A)), 'SETTING_CLIENT_NOT_CONFIRMED');
      await refused(t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A)), 'SETTING_CLIENT_NOT_CONFIRMED');
      assert.strictEqual(confirm.confirmations(A).formsLeft(), 3, 'no form was ever shown');
      assert.deepStrictEqual(history().filter((h) => h.session === A).map((h) => h.change), ['not confirmed (locked in this session)', 'not confirmed (locked in this session)']);
      assert.deepStrictEqual(confirm.confirmations(A).locks(), ['enabled', 'maxOutputBytes', 'module', 'requestTimeout']);
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
      assert.deepStrictEqual(confirm.confirmations(A).locks(), ['enabled', 'maxOutputBytes', 'module', 'requestTimeout']);
      const before = asked.length;
      await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(A)), 'SETTING_CLIENT_NOT_CONFIRMED');
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
      await refused(t0.set('requestTimeout', '60s', 'settings tool', ctx(A)), 'SETTING_CLIENT_NOT_CONFIRMED');
      assert.strictEqual(asked.length, before, 'the latest frame said it: nothing more is asked');
      sources[A].client.conditions = 'yes';
      await refused(t0.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A)), 'SETTING_CLIENT_NOT_CONFIRMED');
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
        await confirming(async () => { sources[A].client.conditions = 'no'; sources[A].emit('attach'); }, 'SETTING_CLIENT_NOT_CONFIRMED');
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

    // /code-review of #308, 4: an answer whose change is not applied still ends its form: said once, after
    it('an answered form that applied nothing is announced as answered: no form of the session is open after it', async () => {
      const failing = tool({growValidators: async () => { throw Object.assign(new Error('no'), {code: 'RESIZE_FAILED'}); }});
      const r = await failing.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A));
      assert.deepStrictEqual(confirm.exportedOf(A).unanswered, ['maxOutputBytes'], 'open');
      const seen = [];
      confirm.onChange((id) => { if (id === A) seen.push(confirm.exportedOf(A).unanswered.join()); });
      await refused(failing.confirm('maxOutputBytes', '16MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_NOT_APPLIED_THIS_SESSION');
      assert.deepStrictEqual(seen, [''], 'announced once, with no form open');
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

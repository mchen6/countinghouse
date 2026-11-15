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

    it('one key for the runtime, the session in the MAC: the same change staged in two sessions gives two states', () => {
      const inA = confirm.confirmations(A).stage(change(A));
      const inB = confirm.confirmations(B).stage(change(B));
      assert.notStrictEqual(inA.requestState.split('.')[1], inB.requestState.split('.')[1]);
      // B's nonce with A's MAC, in either store
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
      // a new store for the same id (it cannot be: the id ended) knows nothing of it
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
});

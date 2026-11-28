'use strict';
// B2 Task 6 (docs/superpowers/plans/2026-11-15-shared-runtime-b2-session-settings.md),
// server-free: a session's state across a runtime restart, the runtime's
// side. The runtime tells ch-local's daemon a full snapshot of a session's
// state after every change ({type: 'session-state', session, state}) and
// its end ({type: 'session-gone', session}); the daemon hands the table back
// in its 'restore' when the runtime starts again. The state is exactly
// {overrides, locks, formsLeft}: nothing in it is a key, a user's name, a
// nonce or the MAC key.
const assert = require('assert');
const EventEmitter = require('events');
const options = require('../../lib/cli-options');
const confirm = require('../../lib/settings-confirm');
const notices = require('../../lib/notices');
const sessions = require('../../lib/sessions');
const settings = require('../../lib/session-settings');
const jobSessions = require('../../lib/job-sessions');
const settingsTool = require('../../lib/settings-tool');
const sessionState = require('../../lib/session-state');

const MiB = 1024 * 1024;

describe('sessions 11: a session\'s state across a runtime restart (shared runtime B2, Task 6)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const CLIENT = {name: 'claude-code', version: '2.1.323'};
  let reg;
  let sources;
  let saved;
  let told;
  const openSession = (id, conditions = {status: 'ok', conditions: 'yes', repo: null}) => {
    const s = new EventEmitter();
    s.id = id;
    s.client = Object.assign({}, conditions);
    s.connected = true;
    s.notify = () => {};
    s.record = () => {};
    s.forget = () => {};
    s.tightenings = (kept, after) => { (s.answers = s.answers || []).push([kept, after]); };
    s.askConditions = async () => Object.assign({}, s.client);
    sources[id] = s;
    reg.emit('session', s);
    return s;
  };
  const change = (session, over = {}) => Object.assign({name: 'maxOutputBytes', old: 16 * MiB, next: 32 * MiB, client: CLIENT, session}, over);
  const statesOf = (id) => told.filter((m) => m.type === 'session-state' && m.session === id).map((m) => m.state);
  const reset = () => { sessions.resetForTests(); settings.resetForTests(); jobSessions.resetForTests(); notices.resetForTests(); settingsTool.resetForTests(); confirm.resetForTests(); sessionState.resetForTests(); };
  beforeEach(() => {
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
    Object.assign(options, {maxOutputBytes: 16 * MiB, requestTimeout: 30000});
    reset();
    settings.configure({ceiling: () => ({state: 'none'})});
    told = [];
    sessionState.configure({tell: (m) => { told.push(JSON.parse(JSON.stringify(m))); return true; }});
    confirm.configure({tell: () => {}});
    reg = new EventEmitter();
    sessions.attach(reg);
    sources = {};
    openSession(A);
    openSession(B);
    told.length = 0;
  });
  afterEach(() => { Object.assign(options, saved); reset(); });

  describe('the export', () => {
    it('a session that changed nothing: no overrides, no locks, its three forms', () => {
      assert.deepStrictEqual(sessionState.exportOf(A), {overrides: [], locks: [], formsLeft: 3});
      assert.strictEqual(confirm.held(), 0, 'reading a state makes no store');
    });

    it('holds its overrides, its decline locks and its forms left, and nothing else', () => {
      settings.set(A, 'requestTimeout', 20000);
      settings.set(A, 'maxOutputBytes', 32 * MiB, {loosening: true, over: 16 * MiB});
      const a = confirm.confirmations(A);
      a.stage(change(A, {name: 'requestTimeout', old: 20000, next: 60000}));
      a.decline('requestTimeout');
      const state = sessionState.exportOf(A);
      assert.deepStrictEqual(state, {
        overrides: [{name: 'requestTimeout', value: 20000, loosening: false, over: null, version: null}, {name: 'maxOutputBytes', value: 32 * MiB, loosening: true, over: 16 * MiB, version: null}],
        locks: ['requestTimeout'],
        formsLeft: 2
      });
      // nothing of the dialog's mechanics, the client or the key
      const text = JSON.stringify(state);
      for (const word of ['nonce', 'mac', 'key', 'client', 'claude-code', 'pending', 'requestState', a.key.toString('hex'), a.key.toString('base64url')]) {
        assert.ok(!text.includes(word), word);
      }
      // another session's is its own
      assert.deepStrictEqual(sessionState.exportOf(B), {overrides: [], locks: [], formsLeft: 3});
    });

    // my /code-review: a ceiling under the tool's least value clamps a stored
    // loosening below it (lib/session-settings.js ceilingSeen), and that
    // value, told, would make the import refuse the row (C's refuses the
    // whole table): every later restart would lose every session's state
    it('never tells a state its own import would refuse: a value a ceiling clamped under the tool\'s bounds is left out', () => {
      settings.set(A, 'requestTimeout', 20000);
      settings.set(A, 'maxOutputBytes', 32 * MiB, {loosening: true, over: 16 * MiB});
      // the operator lowers the ceiling under the tool's 1 MiB minimum, and it is seen
      const low = {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 524288, forbid: [], conversation: true}};
      settings.configure({ceiling: () => low});
      settings.ceilingSeen(low);
      const state = sessionState.exportOf(A);
      assert.strictEqual(sessionState.stateProblem(state), null, JSON.stringify(state));
      assert.deepStrictEqual(state.overrides, [{name: 'requestTimeout', value: 20000, loosening: false, over: null, version: null}]);
      for (const m of told.filter((x) => x.type === 'session-state')) assert.strictEqual(sessionState.stateProblem(m.state), null, JSON.stringify(m.state));
    });

    it('a latched session\'s locks are the three kinds, as ordinary locks (N1)', () => {
      sources[A].emit('client', {status: 'ok', conditions: 'no', repo: null});
      assert.deepStrictEqual(sessionState.exportOf(A).locks, ['enabled', 'maxOutputBytes', 'module', 'requestTimeout']);
    });

    // (M5a: the overrides a session may hold are the two caps)
    it('is the daemon\'s row: under its 64 KiB with every override a session may hold; none for a session that is not one', () => {
      settings.set(A, 'maxOutputBytes', 2 * MiB);
      settings.set(A, 'requestTimeout', 5000);
      const state = sessionState.exportOf(A);
      assert.strictEqual(state.overrides.length, 2);
      assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 64 * 1024, String(Buffer.byteLength(JSON.stringify(state))));
      assert.strictEqual(sessionState.MAX_STATE_BYTES, 64 * 1024);
      for (const id of ['z'.repeat(32), '', null, undefined, 7]) assert.strictEqual(sessionState.exportOf(id), null, String(id));
    });
  });

  describe('told to the daemon: a full snapshot after every change', () => {
    it('a tightening, a confirmed loosening, a form shown, a decline: each tells the session\'s whole state', () => {
      settings.set(A, 'requestTimeout', 20000);
      assert.deepStrictEqual(told, [{type: 'session-state', session: A, state: {overrides: [{name: 'requestTimeout', value: 20000, loosening: false, over: null, version: null}], locks: [], formsLeft: 3}}]);
      const a = confirm.confirmations(A);
      const form = a.stage(change(A));
      assert.strictEqual(statesOf(A).pop().formsLeft, 2, 'a form shown');
      assert.strictEqual(a.verify(form.requestState, {name: 'maxOutputBytes', next: 32 * MiB, session: A}).ok, true);
      settings.set(A, 'maxOutputBytes', 32 * MiB, {loosening: true, over: 16 * MiB});
      assert.deepStrictEqual(statesOf(A).pop().overrides.map((o) => [o.name, o.value, o.loosening]), [['requestTimeout', 20000, false], ['maxOutputBytes', 32 * MiB, true]]);
      a.decline('enabled.one');
      assert.deepStrictEqual(statesOf(A).pop(), {
        overrides: [{name: 'requestTimeout', value: 20000, loosening: false, over: null, version: null}, {name: 'maxOutputBytes', value: 32 * MiB, loosening: true, over: 16 * MiB, version: null}],
        locks: ['enabled'], formsLeft: 2});
      // every message is exactly {type, session, state}, the state exactly its three keys, or those and
      // unanswered while a form was open
      for (const m of told) {
        assert.deepStrictEqual(Object.keys(m).sort(), ['session', 'state', 'type']);
        assert.deepStrictEqual(Object.keys(m.state).filter((k) => k !== 'unanswered').sort(), ['formsLeft', 'locks', 'overrides']);
      }
      assert.deepStrictEqual(statesOf(B), [], 'nothing of B changed');
    });

    // #300's review, (3): a session's own count of the forms it left unanswered (two of a kind lock that
    // kind) is part of its state, so a restart does not hand a form back
    it('a form left unanswered is told as its kind; one open now counts too, until it is answered', () => {
      const a = confirm.confirmations(A);
      a.stage(change(A, {name: 'requestTimeout', old: 30000, next: 60000}));
      assert.deepStrictEqual(statesOf(A).pop(), {overrides: [], locks: [], formsLeft: 2, unanswered: ['requestTimeout']}, 'open: if the runtime dies now it is never answered');
      // left for another: it is unanswered for good, and the new one is open
      const form = a.stage(change(A));
      assert.deepStrictEqual(statesOf(A).pop(), {overrides: [], locks: [], formsLeft: 1, unanswered: ['maxOutputBytes', 'requestTimeout']});
      // the open one answered: its kind is no longer listed, and its outcome's tell says so
      assert.strictEqual(a.verify(form.requestState, {name: 'maxOutputBytes', next: 32 * MiB, session: A}).ok, true);
      assert.deepStrictEqual(sessionState.exportOf(A), {overrides: [], locks: [], formsLeft: 1, unanswered: ['requestTimeout']});
      settings.set(A, 'maxOutputBytes', 32 * MiB, {loosening: true, over: 16 * MiB});
      assert.deepStrictEqual(statesOf(A).pop(), {overrides: [{name: 'maxOutputBytes', value: 32 * MiB, loosening: true, over: 16 * MiB, version: null}], locks: [], formsLeft: 1,
        unanswered: ['requestTimeout']});
      settings.clear(A, 'maxOutputBytes');
      // a session with none has exactly its three keys
      assert.deepStrictEqual(sessionState.exportOf(B), {overrides: [], locks: [], formsLeft: 3});
    });

    // /code-review of #308, 1: one form of a kind left unanswered and another of that kind open now are two,
    // if the runtime dies now: told as the lock it would be
    it('an open form of a kind already left unanswered once is told as a lock, until it is answered', () => {
      const a = confirm.confirmations(A);
      a.stage(change(A, {name: 'requestTimeout', old: 30000, next: 60000}));
      a.end();   // left unanswered
      assert.deepStrictEqual(sessionState.exportOf(A), {overrides: [], locks: [], formsLeft: 2, unanswered: ['requestTimeout']});
      const second = a.stage(change(A, {name: 'requestTimeout', old: 30000, next: 90000}));
      assert.ok(second != null, 'the kind is not locked: a second form is shown');
      assert.deepStrictEqual(statesOf(A).pop(), {overrides: [], locks: ['requestTimeout'], formsLeft: 1}, 'as it would stand were it never answered');
      assert.deepStrictEqual(a.locks(), [], 'not locked here: it may still be answered');
      assert.strictEqual(a.verify(second.requestState, {name: 'requestTimeout', next: 90000, session: A}).ok, true);
      assert.deepStrictEqual(sessionState.exportOf(A), {overrides: [], locks: [], formsLeft: 1, unanswered: ['requestTimeout']}, 'answered: one unanswered, as before it');
    });

    // /code-review of #308, 4: a form used up says nothing by itself; what its answer left is told, once
    it('a form used up tells nothing by itself: its outcome does, once', () => {
      const a = confirm.confirmations(A);
      const form = a.stage(change(A));
      const before = statesOf(A).length;
      assert.strictEqual(a.verify(form.requestState, {name: 'maxOutputBytes', next: 32 * MiB, session: A}).ok, true);
      assert.strictEqual(statesOf(A).length, before, 'no state between the form used up and its outcome');
      a.decline('maxOutputBytes');
      assert.strictEqual(statesOf(A).length, before + 1);
      assert.deepStrictEqual(statesOf(A).pop(), {overrides: [], locks: ['maxOutputBytes'], formsLeft: 2});
    });

    it('a kind that is locked is not also listed as unanswered', () => {
      const a = confirm.confirmations(A);
      a.stage(change(A, {next: 32 * MiB}));
      a.stage(change(A, {next: 48 * MiB}));
      a.stage(change(A, {next: 64 * MiB}));
      assert.deepStrictEqual(sessionState.exportOf(A), {overrides: [], locks: ['maxOutputBytes'], formsLeft: 1});
    });

    it('a lock that falls without an answer is told too: two forms left unanswered, and the latch', () => {
      const a = confirm.confirmations(A);
      a.stage(change(A, {next: 32 * MiB}));
      a.stage(change(A, {next: 48 * MiB}));
      a.stage(change(A, {next: 64 * MiB}));   // the second left for a third: the kind locks
      assert.deepStrictEqual(statesOf(A).pop(), {overrides: [], locks: ['maxOutputBytes'], formsLeft: 1});
      sources[B].emit('client', {status: 'ok', conditions: 'no', repo: null});
      assert.deepStrictEqual(statesOf(B).pop().locks, ['enabled', 'maxOutputBytes', 'module', 'requestTimeout']);
    });

    it('a default lowered at a terminal drops a session\'s looser value, and that is told (dropLooser)', () => {
      settings.set(A, 'maxOutputBytes', 32 * MiB, {loosening: true, over: 16 * MiB});
      told.length = 0;
      options.maxOutputBytes = 8 * MiB;
      settings.dropLooser('maxOutputBytes', 8 * MiB);
      assert.deepStrictEqual(told, [{type: 'session-state', session: A, state: {overrides: [], locks: [], formsLeft: 3}}]);
    });

    it('a change that changes nothing tells nothing again', () => {
      settings.set(A, 'requestTimeout', 20000);
      settings.set(A, 'requestTimeout', 20000);
      confirm.confirmations(A).decline('enabled.one');
      confirm.confirmations(A).decline('enabled.two');
      assert.strictEqual(statesOf(A).length, 2, 'one for the value, one for the lock');
    });

    it('a session\'s end tells no state: the registry tells the daemon it is gone (C\'s session-gone), and nothing of it is left here', () => {
      settings.set(A, 'requestTimeout', 20000);
      told.length = 0;
      sources[A].emit('end');
      assert.deepStrictEqual(told, [], 'no second session-gone, and no state of a session that has ended');
      assert.strictEqual(sessionState.exportOf(A), null);
      // an id is never reused; were one, its first change would be told afresh
      openSession(A);
      settings.set(A, 'requestTimeout', 20000);
      assert.strictEqual(statesOf(A).length, 1);
    });

    it('--stdio\'s one session, and a runtime with no channel, tell nothing; a tell that throws stops no change', () => {
      // the process's own store (--stdio) is no session's
      confirm.confirmations().decline('maxOutputBytes');
      assert.deepStrictEqual(told, []);
      sessionState.configure({tell: () => { throw new Error('the channel is gone'); }});
      assert.deepStrictEqual(settings.set(B, 'requestTimeout', 20000), {old: 30000, new: 20000});
      assert.strictEqual(settings.effective(B, 'requestTimeout'), 20000);
    });
  });

  // The daemon's 'restore', as lib/route-manager.js hands it over once C's
  // lib/session-transport/restore.js has validated it whole, before the
  // socket listens: {sessions: [{session, state}], declines, reset} (#270).
  // Nothing in it is trusted further than its shape: a tightening applies
  // as a replay's does, a loosening only as a fresh one would be allowed.
  describe('the import (the daemon\'s restore)', () => {
    const C = 'c'.repeat(32);
    const tighten = (name, value) => ({name, value, loosening: false, over: null, version: null});
    const loosen = (name, value, over) => ({name, value, loosening: true, over, version: null});
    const row = (session, state = {}) => ({session, state: Object.assign({overrides: [], locks: [], formsLeft: 3}, state)});
    const table = (sessions, over = {}) => Object.assign({sessions, declines: [], reset: []}, over);
    let grown;
    // a fresh runtime: no session yet; the table comes first, then the shims resume
    beforeEach(() => {
      reset();
      settings.configure({ceiling: () => ({state: 'none'})});
      told = [];
      grown = [];
      sessionState.configure({tell: (m) => { told.push(JSON.parse(JSON.stringify(m))); return true; }, growValidators: async (bytes) => { grown.push(bytes); }});
      confirm.configure({tell: () => {}});
      reg = new EventEmitter();
      sessions.attach(reg);
      sources = {};
    });
    const resumed = async (id, conditions) => { openSession(id, conditions); await sessionState.whenApplied(id); };

    // (an override set() refuses now, as a cap's bounds changed by an upgrade
    // between the export and the restore: not applied, and the shim told, so
    // it refuses the session rather than let it run looser in silence)
    it('a restored override that cannot be applied tells the shim: not kept, after a restore; one that can tells it nothing', async () => {
      sessions.importTable(table([row(A, {overrides: [tighten('requestTimeout', 15000)]}), row(B, {overrides: [tighten('requestTimeout', 20000)]})]));
      const entry = settingsTool.ALLOWLIST.requestTimeout;
      const was = entry.min;
      entry.min = 18000;
      try {
        const a = openSession(A);
        await sessionState.whenApplied(A);
        assert.strictEqual(settings.effective(A, 'requestTimeout'), 30000, 'not applied');
        assert.deepStrictEqual(a.answers, [[false, 'restore']]);
        const b = openSession(B);
        await sessionState.whenApplied(B);
        assert.strictEqual(settings.effective(B, 'requestTimeout'), 20000);
        assert.strictEqual(b.answers, undefined, 'all of it applied: nothing sent');
      } finally {
        entry.min = was;
      }
    });

    it('a row waits for its session: nothing applies until the shim resumes it, and then it does', async () => {
      assert.deepStrictEqual(sessions.importTable(table([row(A, {overrides: [tighten('requestTimeout', 20000)], locks: ['enabled'], formsLeft: 1})])), {sessions: 1});
      assert.strictEqual(sessionState.pending(), 1);
      assert.strictEqual(confirm.held(), 0, 'no store for a session that is not there');
      await resumed(A);
      assert.strictEqual(sessionState.pending(), 0);
      assert.strictEqual(settings.effective(A, 'requestTimeout'), 20000);
      assert.deepStrictEqual(sessionState.exportOf(A), {overrides: [tighten('requestTimeout', 20000)], locks: ['enabled'], formsLeft: 1});
      assert.strictEqual(confirm.confirmations(A).declined('enabled.any'), true);
      assert.strictEqual(confirm.confirmations(A).formsLeft(), 1);
      // told once, in its next result
      assert.deepStrictEqual(notices.take(null, A), ['this session\'s settings were restored after a runtime restart']);
      // a session with no row is a new one
      await resumed(B);
      assert.deepStrictEqual(sessionState.exportOf(B), {overrides: [], locks: [], formsLeft: 3});
      assert.deepStrictEqual(notices.take(null, B), []);
    });

    it('a tightening applies only if it is at least as tight as today\'s default and the ceiling; one above today\'s default is not applied at all', async () => {
      options.maxOutputBytes = 8 * MiB;   // the default was lowered while the runtime was down
      sessions.importTable(table([
        row(A, {overrides: [tighten('maxOutputBytes', 4 * MiB), tighten('requestTimeout', 20000)]}),
        // not marked a loosening, yet above today's default (as a handed-over table may have it): never applied
        row(B, {overrides: [tighten('maxOutputBytes', 12 * MiB)]})]));
      await resumed(A);
      await resumed(B);
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 4 * MiB);
      assert.strictEqual(settings.effective(A, 'requestTimeout'), 20000);
      assert.strictEqual(settings.limitsOf(B), null, 'nothing of B\'s was applied');
      assert.deepStrictEqual(settings.overridesOf(B), []);
      options.maxOutputBytes = 16 * MiB;
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 16 * MiB, 'and it does not come into force when the default rises');
    });

    it('a loosening waits for its session\'s client, and applies only as a fresh one would be let: the client says ok and yes, the ceiling allows it, the default is not under its "over"', async () => {
      sessions.importTable(table([row(A, {overrides: [loosen('maxOutputBytes', 32 * MiB, 16 * MiB)]}),
        row(B, {overrides: [loosen('maxOutputBytes', 32 * MiB, 16 * MiB), tighten('requestTimeout', 20000)]}),
        row(C, {overrides: [loosen('requestTimeout', 60000, 30000)]})]));
      // A: its client says ok and yes
      await resumed(A);
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 32 * MiB);
      assert.deepStrictEqual(notices.take(null, A), ['this session\'s settings were restored after a runtime restart']);
      // B: its client's configuration could answer for the user: the loosening is reset, the tightening kept, and B is latched
      await resumed(B, {status: 'ok', conditions: 'no', repo: null});
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 16 * MiB);
      assert.strictEqual(settings.effective(B, 'requestTimeout'), 20000);
      assert.deepStrictEqual(notices.take(null, B), ['your this-session loosening of maxOutputBytes was reset after a runtime restart',
        'this session\'s settings were restored after a runtime restart'], 'not "ask again": it is latched');
      assert.deepStrictEqual(confirm.confirmations(B).locks(), ['enabled', 'maxOutputBytes', 'module', 'requestTimeout']);
      // C: the default was lowered under what it was confirmed over
      options.requestTimeout = 20000;
      await resumed(C);
      assert.strictEqual(settings.effective(C, 'requestTimeout'), 20000);
      assert.deepStrictEqual(notices.take(null, C), ['your this-session loosening of requestTimeout was reset after a runtime restart; ask again']);
    });

    it('a loosening the ceiling no longer allows is reset; one above a ceiling that still allows loosening is held to it', async () => {
      sessions.importTable(table([row(A, {overrides: [loosen('maxOutputBytes', 32 * MiB, 16 * MiB)]}), row(B, {overrides: [loosen('maxOutputBytes', 32 * MiB, 16 * MiB)]})]));
      settings.configure({ceiling: () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], conversation: false}})});
      await resumed(A);
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 16 * MiB);
      assert.deepStrictEqual(notices.take(null, A), ['your this-session loosening of maxOutputBytes was reset after a runtime restart; ask again']);
      settings.configure({ceiling: () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 24 * MiB, forbid: [], conversation: true}})});
      await resumed(B);
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 24 * MiB);
    });

    it('a session a re-exec took loosenings from (reset) is told so at its resume', async () => {
      sessions.importTable(table([row(A, {overrides: [tighten('requestTimeout', 20000)]}), row(B)], {reset: [A]}));
      await resumed(A);
      await resumed(B);
      assert.deepStrictEqual(notices.take(null, A), ['your this-session loosenings were reset; ask again', 'this session\'s settings were restored after a runtime restart']);
      assert.deepStrictEqual(notices.take(null, B), []);
    });

    // #438's high review, 2: a stale pack override is dropped by restore.js
    // (one session's, never the table's fault); that session is told once
    it('a session whose own pack override restore.js dropped is told once at its resume; another is not', async () => {
      const t = table([row(A, {overrides: [tighten('requestTimeout', 20000)]}), row(B)]);
      sessions.importTable(Object.assign({}, t, {packsDropped: [{session: A, names: ['weather']}]}));
      await resumed(A);
      await resumed(B);
      assert.deepStrictEqual(notices.take(null, A), ['tools are turned on and off for all your sessions now: this session\'s own setting for weather was dropped after a runtime restart',
        'this session\'s settings were restored after a runtime restart']);
      assert.deepStrictEqual(notices.take(null, B), []);
      assert.strictEqual(settings.effective(A, 'requestTimeout'), 20000, 'the rest of the row is taken');
      // the daemon's row is told right (it still held the pack override), so
      // the next restart neither drops nor tells it again
      assert.deepStrictEqual(statesOf(A), [{overrides: [tighten('requestTimeout', 20000)], locks: [], formsLeft: 3}]);
    });

    // #449 (a): the runtime's own path, the daemon's message through
    // restore.js and the one adapter route-manager hands sessions.importTable
    it('a daemon\'s restore with a stale pack override: through restore.js and forSessions, that session is told once', async () => {
      const {validate, forSessions} = require('../../lib/session-transport/restore');
      const stale = {name: 'pack.weather', value: false, loosening: false, over: null, version: '1.0.0'};
      const msg = {id: 'd1', type: 'restore', declines: [], reset: [],
        sessions: [{session: A, resume: 'a'.repeat(64), state: {overrides: [tighten('requestTimeout', 20000), stale], locks: [], formsLeft: 3}},
          {session: B, resume: 'b'.repeat(64), state: {overrides: [], locks: [], formsLeft: 3}}]};
      sessions.importTable(forSessions(validate(msg)));
      await resumed(A);
      await resumed(B);
      const told = notices.take(null, A);
      assert.strictEqual(told.filter((t) => /own setting for weather was dropped/.test(t)).length, 1, JSON.stringify(told));
      assert.deepStrictEqual(notices.take(null, B), []);
      assert.ok(!forSessions(validate(msg)).sessions.some((r) => 'resume' in r), 'the resume hash is the registry\'s, never B2\'s');
    });

    it('a session that had more than eight packs of its own is told eight of them and how many more', async () => {
      const names = Array.from({length: 10}, (_, i) => `p${i}`);
      sessions.importTable(Object.assign({}, table([row(A)]), {packsDropped: [{session: A, names}]}));
      await resumed(A);
      assert.deepStrictEqual(notices.take(null, A), ['tools are turned on and off for all your sessions now: this session\'s own setting for p0, p1, p2, p3, p4, p5, p6, p7 and 2 more was dropped after a runtime restart']);
    });

    it('the daemon\'s row is put right: what was not applied is told as the session\'s state now', async () => {
      sessions.importTable(table([row(A, {overrides: [loosen('maxOutputBytes', 32 * MiB, 16 * MiB), tighten('requestTimeout', 20000)]}), row(B, {overrides: [tighten('requestTimeout', 20000)]})]));
      await resumed(A, {status: 'ok', conditions: 'no', repo: null});
      assert.deepStrictEqual(statesOf(A).pop(), {overrides: [tighten('requestTimeout', 20000)], locks: ['enabled', 'maxOutputBytes', 'module', 'requestTimeout'], formsLeft: 3});
      // a row applied whole is the daemon's row already: nothing is told again
      await resumed(B);
      assert.deepStrictEqual(statesOf(B), []);
    });

    it('a session that never resumes: its row is dropped when the registry forgets it, and nothing is left', async () => {
      sessions.importTable(table([row(A, {overrides: [tighten('requestTimeout', 20000)]}), row(B)]));
      assert.strictEqual(sessionState.pending(), 2);
      reg.emit('gone', A);
      assert.strictEqual(sessionState.pending(), 1);
      reg.emit('gone', 'e'.repeat(32));   // one it never had
      assert.strictEqual(sessionState.pending(), 1);
      await resumed(B);
      assert.strictEqual(sessionState.pending(), 0);
    });

    // over C's real registry: a restored row's session is resumed by its
    // token and announced at its settle; one never resumed ends with its
    // reconnect window, and the registry's 'gone' drops its row
    it('with the real registry: a resumed session gets its row at its settle; one that never resumes leaves nothing behind after its window', async () => {
      const crypto = require('crypto');
      const {createRegistry} = require('../../lib/session-transport/registry');
      const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
      reset();
      settings.configure({ceiling: () => ({state: 'none'})});
      sessionState.configure({tell: (m) => { told.push(JSON.parse(JSON.stringify(m))); return true; }});
      const real = createRegistry({tell: () => {}, reconnectWindowMs: 60});
      sessions.attach(real);
      real._restore([{session: A, resume: sha('rt_a')}, {session: B, resume: sha('rt_b')}]);
      sessions.importTable(table([row(A, {overrides: [tighten('requestTimeout', 20000)], locks: ['enabled'], formsLeft: 2}), row(B, {overrides: [tighten('requestTimeout', 10000)]})]));
      assert.strictEqual(sessionState.pending(), 2);
      // A's shim resumes it and its client frame settles it
      const back = real._resume('rt_a');
      assert.ok(back != null && back.id === A);
      back._attach({notify() {}, control() {}, settled: true});
      back._setClient({status: 'ok', conditions: 'yes', repo: null});
      back._announced = true;
      real._announce(back);
      await sessionState.whenApplied(A);
      assert.strictEqual(settings.effective(A, 'requestTimeout'), 20000);
      assert.deepStrictEqual(sessionState.exportOf(A), {overrides: [tighten('requestTimeout', 20000)], locks: ['enabled'], formsLeft: 2});
      // B's never does
      await new Promise((r) => setTimeout(r, 150));
      assert.strictEqual(real._count(), 1, 'the registry has forgotten B');
      assert.strictEqual(sessionState.pending(), 0, 'and its row went with it');
      back._end();
    });

    it('a row that is not exactly the agreed shape is dropped, and the others imported', () => {
      const good = row(A, {overrides: [tighten('requestTimeout', 20000)]});
      const bad = [
        {session: B, state: {overrides: [], locks: [], formsLeft: 3, nonce: 'x'}},
        {session: B, state: {overrides: [], locks: []}},
        {session: B, state: {overrides: [tighten('requestTimeout', 20000), tighten('requestTimeout', 10000)], locks: [], formsLeft: 3}},
        // M5a: a pack's on or off is never a session's own: a pack.* override is refused like any unknown name
        {session: B, state: {overrides: [{name: 'pack.ci', value: true, loosening: true, over: null, version: '1.2.3'}], locks: [], formsLeft: 3}},
        {session: B, state: {overrides: [{name: 'pack.docs', value: false, loosening: false, over: null, version: '2.0.0'}], locks: [], formsLeft: 3}},
        {session: B, state: {overrides: [{name: 'requestTimeout', value: '20000', loosening: false, over: null, version: null}], locks: [], formsLeft: 3}},
        {session: B, state: {overrides: [{name: 'requestTimeout', value: 20000, loosening: false, over: null, version: null, extra: 1}], locks: [], formsLeft: 3}},
        {session: B, state: {overrides: [{name: 'locale', value: 'zh', loosening: false, over: null, version: null}], locks: [], formsLeft: 3}},
        {session: B, state: {overrides: [loosen('maxOutputBytes', 32 * MiB, null)], locks: [], formsLeft: 3}},
        {session: B, state: {overrides: [tighten('maxOutputBytes', 1)], locks: [], formsLeft: 3}},
        {session: B, state: {overrides: [], locks: ['enabled', 'enabled'], formsLeft: 3}},
        {session: B, state: {overrides: [], locks: ['locale'], formsLeft: 3}},
        {session: B, state: {overrides: [], locks: [], formsLeft: 4}},
        {session: B, state: {overrides: [], locks: [], formsLeft: 1.5}},
        {session: 'not-an-id', state: {overrides: [], locks: [], formsLeft: 3}},
        {session: B, state: null}, {session: B}, null, 'x'];
      for (const b of bad) {
        sessionState.resetForTests();
        assert.deepStrictEqual(sessions.importTable(table([b, good])), {sessions: 1}, JSON.stringify(b).slice(0, 120));
      }
      // and the largest state a session can have (its two caps, M5a) is within the daemon's 64 KiB
      sessionState.resetForTests();
      const fat = row(B, {overrides: [loosen('maxOutputBytes', 32 * MiB, 16 * MiB), tighten('requestTimeout', 20000)]});
      assert.ok(Buffer.byteLength(JSON.stringify(fat.state)) <= 64 * 1024, 'the largest state a session can have is within it');
      assert.deepStrictEqual(sessions.importTable(table([fat, good])), {sessions: 2});
    });

    it('a session named twice keeps its first row; a second table changes nothing', async () => {
      assert.deepStrictEqual(sessions.importTable(table([row(A, {formsLeft: 1}), row(A, {formsLeft: 2})])), {sessions: 1});
      assert.deepStrictEqual(sessions.importTable(table([row(B)])), {sessions: 0}, 'the table was already taken');
      assert.strictEqual(sessionState.pending(), 1);
      await resumed(A);
      assert.strictEqual(confirm.confirmations(A).formsLeft(), 1, 'the first row');
    });

    // my /code-review of the import
    it('a loosening is reset when its session\'s client gives no answer, a failed one, or the ask throws', async () => {
      const D = 'd'.repeat(32);
      sessions.importTable(table([A, B, C, D].map((id) => row(id, {overrides: [loosen('requestTimeout', 60000, 30000)]}))));
      const answers = {[A]: async () => null, [B]: async () => ({status: 'failed', conditions: 'no', repo: null}),
        [C]: async () => { throw new Error('the shim is gone'); }, [D]: async () => ({status: 'ok', conditions: null, repo: null})};
      for (const id of [A, B, C, D]) {
        const s = new EventEmitter();
        Object.assign(s, {id, client: {status: 'ok', conditions: 'yes', repo: null}, connected: true, notify() {}, record() {}, forget() {}, askConditions: answers[id]});
        sources[id] = s;
        reg.emit('session', s);
        await sessionState.whenApplied(id);
        assert.strictEqual(settings.effective(id, 'requestTimeout'), 30000, id);
        assert.deepStrictEqual(settings.overridesOf(id), [], id);
      }
    });

    it('a raised output cap grows the validators before it is in force; a growth that fails resets it', async () => {
      sessions.importTable(table([row(A, {overrides: [loosen('maxOutputBytes', 64 * MiB, 16 * MiB)]}), row(B, {overrides: [loosen('maxOutputBytes', 64 * MiB, 16 * MiB)]})]));
      await resumed(A);
      assert.deepStrictEqual(grown, [64 * MiB]);
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 64 * MiB);
      sessionState.configure({tell: () => true, growValidators: async () => { throw Object.assign(new Error('no'), {code: 'RESIZE_FAILED'}); }});
      await resumed(B);
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 16 * MiB);
      assert.deepStrictEqual(notices.take(null, B), ['your this-session loosening of maxOutputBytes was reset after a runtime restart; ask again']);
    });

    it('what the session does while its client is asked wins: its own change is not written over, and a client that says no meanwhile gets nothing', async () => {
      sessions.importTable(table([row(A, {overrides: [loosen('maxOutputBytes', 32 * MiB, 16 * MiB)]}), row(B, {overrides: [loosen('requestTimeout', 60000, 30000)]})]));
      // A tightens for itself while its shim is asked
      const a = new EventEmitter();
      Object.assign(a, {id: A, client: {status: 'ok', conditions: 'yes', repo: null}, connected: true, notify() {}, record() {}, forget() {},
        askConditions: async () => { settings.set(A, 'maxOutputBytes', 4 * MiB); return {status: 'ok', conditions: 'yes', repo: null}; }});
      sources[A] = a;
      reg.emit('session', a);
      await sessionState.whenApplied(A);
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 4 * MiB, 'its own 4 MiB stands');
      // B's client says no in a frame of its own while it is asked, then answers yes: N1's "no" is final
      const b = new EventEmitter();
      Object.assign(b, {id: B, client: {status: 'ok', conditions: 'yes', repo: null}, connected: true, notify() {}, record() {}, forget() {},
        askConditions: async () => { b.emit('client', {status: 'ok', conditions: 'no', repo: null}); return {status: 'ok', conditions: 'yes', repo: null}; }});
      sources[B] = b;
      reg.emit('session', b);
      await sessionState.whenApplied(B);
      assert.strictEqual(settings.effective(B, 'requestTimeout'), 30000);
      assert.deepStrictEqual(confirm.confirmations(B).locks(), ['enabled', 'maxOutputBytes', 'module', 'requestTimeout']);
    });

    // the reviewer's high review of #300, (1)
    it('a marked loosening at or under today\'s default needs no client: it is restored as the tightening it now is, never reset up to the default', async () => {
      // raised by form from 2 to 5 MiB under a default of 16: a loosening of the session's own value then, under the default all along
      sessions.importTable(table([row(A, {overrides: [loosen('maxOutputBytes', 5 * MiB, 16 * MiB), loosen('requestTimeout', 60000, 30000)]}),
        row(B, {overrides: [loosen('maxOutputBytes', 5 * MiB, 16 * MiB)]})]));
      // A's client says no: it is latched, and what is above the default is reset
      await resumed(A, {status: 'ok', conditions: 'no', repo: null});
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 5 * MiB, 'not 16 MiB: the session is no looser than before the restart');
      assert.strictEqual(settings.effective(A, 'requestTimeout'), 30000, 'what was above the default is reset to it');
      assert.deepStrictEqual(statesOf(A).pop().overrides, [tighten('maxOutputBytes', 5 * MiB)], 'told as what it is now');
      assert.deepStrictEqual(grown, [], 'under the default: the validators have room already');
      assert.deepStrictEqual(notices.take(null, A), ['your this-session loosening of requestTimeout was reset after a runtime restart',
        'this session\'s settings were restored after a runtime restart']);
      // B's client gives no answer at all
      const b = new EventEmitter();
      Object.assign(b, {id: B, client: {status: 'ok', conditions: 'yes', repo: null}, connected: true, notify() {}, record() {}, forget() {},
        askConditions: async () => { throw new Error('no answer'); }});
      sources[B] = b;
      reg.emit('session', b);
      await sessionState.whenApplied(B);
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 5 * MiB);
      assert.deepStrictEqual(notices.take(null, B), ['this session\'s settings were restored after a runtime restart']);
    });

    // the reviewer's high review of #300, (2)
    it('a latch that falls while a loosening waits is seen on a session whose every kind was locked already', async () => {
      // every kind locked by the user's own declines before the restart; its client could still be asked
      sessions.importTable(table([row(A, {overrides: [loosen('maxOutputBytes', 32 * MiB, 16 * MiB)], locks: ['maxOutputBytes', 'enabled', 'requestTimeout'], formsLeft: 1})]));
      // its client answers yes, then says no in a frame of its own while the validators grow
      const a = new EventEmitter();
      Object.assign(a, {id: A, client: {status: 'ok', conditions: 'yes', repo: null}, connected: true, notify() {}, record() {}, forget() {},
        askConditions: async () => ({status: 'ok', conditions: 'yes', repo: null})});
      sessionState.configure({tell: (m) => { told.push(JSON.parse(JSON.stringify(m))); return true; },
        growValidators: async () => { a.emit('client', {status: 'ok', conditions: 'no', repo: null}); }});
      sources[A] = a;
      reg.emit('session', a);
      await sessionState.whenApplied(A);
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 16 * MiB, 'N1\'s "no" is final: nothing is loosened');
      assert.deepStrictEqual(notices.take(null, A), ['your this-session loosening of maxOutputBytes was reset after a runtime restart']);
    });

    it('a session latched at its settle (its client says no) keeps what it tightened across a second restart: the daemon is told its state as it stands', async () => {
      // the row of a session whose client always said no, and whose user tightened a cap
      sessions.importTable(table([row(A, {overrides: [tighten('requestTimeout', 20000)], locks: ['maxOutputBytes', 'enabled', 'requestTimeout'], formsLeft: 2})]));
      await resumed(A, {status: 'ok', conditions: 'no', repo: null});
      assert.strictEqual(settings.effective(A, 'requestTimeout'), 20000);
      assert.deepStrictEqual(statesOf(A).pop(), {overrides: [tighten('requestTimeout', 20000)], locks: ['enabled', 'maxOutputBytes', 'module', 'requestTimeout'], formsLeft: 2},
        'the last thing told is the whole state, not the latch alone');
    });

    it('while a row is applied nothing half-way is told: one state, at the end, when it differs from the row', async () => {
      sessions.importTable(table([row(A, {overrides: [tighten('requestTimeout', 20000), loosen('maxOutputBytes', 32 * MiB, 16 * MiB)], locks: ['enabled'], formsLeft: 2})]));
      await resumed(A, {status: 'ok', conditions: null, repo: null});   // no answer worth a yes: the loosening is reset
      assert.deepStrictEqual(statesOf(A), [{overrides: [tighten('requestTimeout', 20000)], locks: ['enabled'], formsLeft: 2}]);
    });

    it('what is restored is recorded in the history as that, and a session is told only what is true of it', async () => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s11-'));
      const was = options.settingsFile;
      options.settingsFile = path.join(home, 'settings.json');
      try {
        sessions.importTable(table([
          row(A, {overrides: [tighten('requestTimeout', 20000), loosen('maxOutputBytes', 32 * MiB, 16 * MiB)]}),
          // only restrictions: nothing of its settings was restored
          row(B, {locks: ['enabled'], formsLeft: 1}),
          // a loosening reset in a session that can ask no more
          row(C, {overrides: [loosen('requestTimeout', 60000, 30000)], formsLeft: 0})]));
        await resumed(A);
        const lines = fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert.deepStrictEqual(lines.map(({at, ...rest}) => rest), [
          {by: 'restore', setting: 'requestTimeout', old: 30000, new: 20000, change: 'this session (restored after a restart)', session: A},
          {by: 'restore', setting: 'maxOutputBytes', old: 16 * MiB, new: 32 * MiB, change: 'this session (restored after a restart)', session: A}]);
        await resumed(B);
        assert.deepStrictEqual(notices.take(null, B), [], 'no settings of B\'s were restored');
        await resumed(C, {status: 'ok', conditions: null, repo: null});
        assert.deepStrictEqual(notices.take(null, C), ['your this-session loosening of requestTimeout was reset after a runtime restart'], 'not "ask again": it has no forms left');
      } finally {
        options.settingsFile = was;
        fs.rmSync(home, {recursive: true, force: true});
      }
    });

    it('a tightening that no longer applies (the default is lower now) is said, once', async () => {
      options.maxOutputBytes = 8 * MiB;
      sessions.importTable(table([row(A, {overrides: [tighten('maxOutputBytes', 12 * MiB)]})]));
      await resumed(A);
      assert.deepStrictEqual(notices.take(null, A), ['your this-session maxOutputBytes of 12MiB was not restored after a runtime restart: the default is lower now']);
    });

    // #300's review, (3)
    it('a restored unanswered kind counts as one: the next form of that kind left unanswered locks it', async () => {
      sessions.importTable(table([row(A, {formsLeft: 2, unanswered: ['requestTimeout']}), row(B, {formsLeft: 2})]));
      await resumed(A);
      await resumed(B);
      assert.deepStrictEqual(sessionState.exportOf(A), {overrides: [], locks: [], formsLeft: 2, unanswered: ['requestTimeout']});
      assert.deepStrictEqual(statesOf(A), [], 'as the daemon has it: nothing is told again');
      for (const id of [A, B]) {
        const c = confirm.confirmations(id);
        assert.ok(c.stage(change(id, {name: 'requestTimeout', old: 30000, next: 60000})) != null, 'a form of the kind is shown');
        c.end();   // and left unanswered
      }
      assert.deepStrictEqual(confirm.confirmations(A).locks(), ['requestTimeout'], 'the second of its kind: locked');
      assert.deepStrictEqual(confirm.confirmations(B).locks(), [], 'the first of its kind for a session that had none');
    });

    it('a restored unanswered kind never undoes a lock', async () => {
      sessions.importTable(table([row(A, {locks: ['enabled'], formsLeft: 1, unanswered: ['maxOutputBytes']})]));
      await resumed(A);
      assert.deepStrictEqual(sessionState.exportOf(A), {overrides: [], locks: ['enabled'], formsLeft: 1, unanswered: ['maxOutputBytes']});
    });

    // /code-review of #308, 5 and 6: a state says one thing of a kind, and what it says of its forms adds up
    it('a kind both locked and unanswered, and an unanswered form with no form spent, are no state: the row is dropped', async () => {
      const base = {overrides: [], locks: [], formsLeft: 2};
      assert.notStrictEqual(sessionState.stateProblem(Object.assign({}, base, {locks: ['enabled'], unanswered: ['enabled']})), null, 'locked is not also unanswered');
      assert.notStrictEqual(sessionState.stateProblem(Object.assign({}, base, {formsLeft: 3, unanswered: ['enabled']})), null, 'a form left unanswered was a form spent');
      sessions.importTable(table([row(A, {locks: ['enabled'], formsLeft: 1, unanswered: ['enabled']}), row(B, {formsLeft: 2, unanswered: ['enabled']})]));
      await resumed(A);
      await resumed(B);
      assert.deepStrictEqual(sessionState.exportOf(A), {overrides: [], locks: [], formsLeft: 3}, 'dropped: a new session');
      assert.deepStrictEqual(sessionState.exportOf(B), {overrides: [], locks: [], formsLeft: 2, unanswered: ['enabled']});
      // and the store itself: restoring a kind as both leaves it locked, and listed once, as that
      const c = confirm.confirmations(B);
      c.restore({locks: ['requestTimeout'], formsLeft: 1, unanswered: ['requestTimeout']});
      assert.deepStrictEqual(sessionState.exportOf(B), {overrides: [], locks: ['requestTimeout'], formsLeft: 1, unanswered: ['enabled']});
    });

    it('the shared vectors\' restoreRows: B2 takes each accepted state and refuses each refused one\'s, as restore.js and the daemon do', () => {
      const V = require('../../docs/superpowers/specs/shared-runtime-wire/vectors.json').restoreRows;
      for (const row of V.accepted) assert.strictEqual(sessionState.stateProblem(row.state), null, JSON.stringify(row.state).slice(0, 120));
      // (a refused row may be refused for its session or its resume, which are not B2's: only a state's own faults are)
      const ofState = V.refused.filter((c) => !/session id|resume|\{session, resume, state\}/.test(c.reason));
      assert.ok(ofState.length >= 8, String(ofState.length));
      for (const c of ofState) assert.notStrictEqual(sessionState.stateProblem(c.row.state), null, c.why);
    });

    it('a state\'s unanswered is distinct known kinds, three at most, or not there at all', () => {
      const base = {overrides: [], locks: [], formsLeft: 2};
      for (const ok of [undefined, [], ['enabled'], ['maxOutputBytes', 'enabled', 'requestTimeout']]) {
        assert.strictEqual(sessionState.stateProblem(ok === undefined ? base : Object.assign({}, base, {unanswered: ok})), null, JSON.stringify(ok));
      }
      for (const bad of ['enabled', ['enabled', 'enabled'], ['other'], [7], null, {pack: 1}, ['maxOutputBytes', 'enabled', 'requestTimeout', 'enabled']]) {
        assert.notStrictEqual(sessionState.stateProblem(Object.assign({}, base, {unanswered: bad})), null, JSON.stringify(bad));
      }
      assert.notStrictEqual(sessionState.stateProblem(Object.assign({}, base, {unanswered: [], nonce: 'x'})), null, 'no other key beside it');
    });

    it('a table that is no table is as no table: every kind is locked, and none is taken after it', () => {
      for (const no of [null, 'x', {}, {sessions: 'x', declines: [], reset: []}, {sessions: [], declines: [], reset: 'x'}]) {
        confirm.resetForTests();
        sessionState.resetForTests();
        assert.deepStrictEqual(sessions.importTable(no), {sessions: 0}, JSON.stringify(no));
        for (const kind of ['maxOutputBytes', 'requestTimeout', 'enabled']) assert.strictEqual(confirm.userWindow().locked(kind), true, `${kind}: ${JSON.stringify(no)}`);
        assert.deepStrictEqual(sessions.importTable(table([row(A)])), {sessions: 0});
      }
    });

    // the reviewer's two sides of "no restore locks the forms"
    it('an empty table (a daemon\'s first start of a runtime) locks nothing: a form may be shown at once', async () => {
      assert.deepStrictEqual(sessions.importTable(table([])), {sessions: 0});
      for (const kind of ['maxOutputBytes', 'requestTimeout', 'enabled']) assert.strictEqual(confirm.userWindow().locked(kind), false, kind);
      await resumed(A);
      assert.ok(confirm.confirmations(A).stage(change(A)) != null);
    });

    it('--stdio is outside all of it: its one store has no window, so even noRestore leaves its forms alone', () => {
      sessionState.noRestore();
      const stdio = confirm.confirmations();
      assert.ok(stdio.stage(Object.assign(change('s1'), {session: 's1'})) != null, 'a form, as ever');
      assert.strictEqual(sessionState.exportOf('s1'), null);
    });

    it('a decline up to a minute ahead of this clock is taken (C\'s restore allows it): it counts as now', () => {
      const now = Date.now();
      sessions.importTable(table([], {declines: [{kind: 'enabled', at: now + 30 * 1000}, {kind: 'enabled', at: now - 1000}, {kind: 'enabled', at: now - 2000}]}));
      assert.strictEqual(confirm.userWindow().locked('enabled'), true, 'three within the window');
      assert.strictEqual(confirm.userWindow().locked('maxOutputBytes'), false, 'and the list was not thrown away');
    });

    it('the declines load into the user\'s window: a lock still running holds across the restart', async () => {
      const now = Date.now();
      sessions.importTable(table([row(A)], {declines: [{kind: 'maxOutputBytes', at: now - 20 * 60 * 1000}, {kind: 'maxOutputBytes', at: now - 10 * 60 * 1000}, {kind: 'maxOutputBytes', at: now - 60 * 1000}]}));
      assert.strictEqual(confirm.userWindow().locked('maxOutputBytes'), true);
      assert.strictEqual(confirm.userWindow().locked('requestTimeout'), false);
      await resumed(A);
      assert.strictEqual(confirm.confirmations(A).stage(change(A)), null, 'no form of that kind');
    });

    it('a list of declines that fails, or that is longer than the window can hold, locks every kind: what cannot be shown was declined is taken as declined (N2)', () => {
      const now = Date.now();
      const lists = [[{kind: 'locale', at: now}], [{kind: 'enabled', at: now + 3600 * 1000}], [{kind: 'enabled', at: now, session: A}], 'x', null,
        // C's restore lets up to 1024 through; the window takes 64
        Array.from({length: 65}, () => ({kind: 'enabled', at: now - 1000}))];
      for (const declines of lists) {
        confirm.resetForTests();
        sessionState.resetForTests();
        sessions.importTable(table([], {declines}));
        for (const kind of ['maxOutputBytes', 'requestTimeout', 'enabled']) assert.strictEqual(confirm.userWindow().locked(kind), true, `${kind}: ${JSON.stringify(declines).slice(0, 60)}`);
      }
    });

    it('no table at all (the daemon\'s restore never came): every kind is locked for 30 minutes, and no later table is taken', () => {
      sessionState.noRestore();
      for (const kind of ['maxOutputBytes', 'requestTimeout', 'enabled']) assert.strictEqual(confirm.userWindow().locked(kind), true, kind);
      assert.deepStrictEqual(sessions.importTable(table([row(A)])), {sessions: 0});
      assert.strictEqual(sessionState.pending(), 0);
    });
  });
});

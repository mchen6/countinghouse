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

    it('a latched session\'s locks are the three kinds, as ordinary locks (N1)', () => {
      sources[A].emit('client', {status: 'ok', conditions: 'no', repo: null});
      assert.deepStrictEqual(sessionState.exportOf(A).locks, ['maxOutputBytes', 'pack', 'requestTimeout']);
    });

    it('is the daemon\'s row: under its 64 KiB with every override a session may hold; none for a session that is not one', () => {
      settings.set(A, 'maxOutputBytes', 2 * MiB);
      settings.set(A, 'requestTimeout', 5000);
      for (let i = 0; i < settings.MAX_OVERRIDES - 2; i++) settings.set(A, `pack.${'p'.repeat(60)}${String(i).padStart(3, '0')}`, true, {loosening: true, version: `1.2.3-${'x'.repeat(60)}`});
      const state = sessionState.exportOf(A);
      assert.strictEqual(state.overrides.length, 64);
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
      a.decline('pack.one');
      assert.deepStrictEqual(statesOf(A).pop(), {
        overrides: [{name: 'requestTimeout', value: 20000, loosening: false, over: null, version: null}, {name: 'maxOutputBytes', value: 32 * MiB, loosening: true, over: 16 * MiB, version: null}],
        locks: ['pack'], formsLeft: 2});
      // every message is exactly {type, session, state}, the state exactly its three keys
      for (const m of told) {
        assert.deepStrictEqual(Object.keys(m).sort(), ['session', 'state', 'type']);
        assert.deepStrictEqual(Object.keys(m.state).sort(), ['formsLeft', 'locks', 'overrides']);
      }
      assert.deepStrictEqual(statesOf(B), [], 'nothing of B changed');
    });

    it('a lock that falls without an answer is told too: two forms left unanswered, and the latch', () => {
      const a = confirm.confirmations(A);
      a.stage(change(A, {next: 32 * MiB}));
      a.stage(change(A, {next: 48 * MiB}));
      a.stage(change(A, {next: 64 * MiB}));   // the second left for a third: the kind locks
      assert.deepStrictEqual(statesOf(A).pop(), {overrides: [], locks: ['maxOutputBytes'], formsLeft: 1});
      sources[B].emit('client', {status: 'ok', conditions: 'no', repo: null});
      assert.deepStrictEqual(statesOf(B).pop().locks, ['maxOutputBytes', 'pack', 'requestTimeout']);
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
      confirm.confirmations(A).decline('pack.one');
      confirm.confirmations(A).decline('pack.two');
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
    // a fresh runtime: no session yet; the table comes first, then the shims resume
    beforeEach(() => {
      reset();
      settings.configure({ceiling: () => ({state: 'none'})});
      told = [];
      sessionState.configure({tell: (m) => { told.push(JSON.parse(JSON.stringify(m))); return true; }});
      confirm.configure({tell: () => {}});
      reg = new EventEmitter();
      sessions.attach(reg);
      sources = {};
    });
    const resumed = async (id, conditions) => { openSession(id, conditions); await sessionState.whenApplied(id); };

    it('a row waits for its session: nothing applies until the shim resumes it, and then it does', async () => {
      assert.deepStrictEqual(sessions.importTable(table([row(A, {overrides: [tighten('requestTimeout', 20000)], locks: ['pack'], formsLeft: 1})])), {sessions: 1});
      assert.strictEqual(sessionState.pending(), 1);
      assert.strictEqual(confirm.held(), 0, 'no store for a session that is not there');
      await resumed(A);
      assert.strictEqual(sessionState.pending(), 0);
      assert.strictEqual(settings.effective(A, 'requestTimeout'), 20000);
      assert.deepStrictEqual(sessionState.exportOf(A), {overrides: [tighten('requestTimeout', 20000)], locks: ['pack'], formsLeft: 1});
      assert.strictEqual(confirm.confirmations(A).declined('pack.any'), true);
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
      assert.deepStrictEqual(notices.take(null, B), ['your this-session loosening of maxOutputBytes was reset after a runtime restart; ask again',
        'this session\'s settings were restored after a runtime restart']);
      assert.deepStrictEqual(confirm.confirmations(B).locks(), ['maxOutputBytes', 'pack', 'requestTimeout']);
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

    it('a pack\'s override is reset and said: a session has no packs of its own yet', async () => {
      sessions.importTable(table([row(A, {overrides: [{name: 'pack.ci', value: true, loosening: true, over: null, version: '1.2.3'}]})]));
      await resumed(A);
      assert.deepStrictEqual(settings.overridesOf(A), []);
      assert.deepStrictEqual(notices.take(null, A), ['your this-session change of pack.ci was reset after a runtime restart; ask again']);
    });

    it('a session a re-exec took loosenings from (reset) is told so at its resume', async () => {
      sessions.importTable(table([row(A, {overrides: [tighten('requestTimeout', 20000)]}), row(B)], {reset: [A]}));
      await resumed(A);
      await resumed(B);
      assert.deepStrictEqual(notices.take(null, A), ['your this-session loosenings were reset; ask again', 'this session\'s settings were restored after a runtime restart']);
      assert.deepStrictEqual(notices.take(null, B), []);
    });

    it('the daemon\'s row is put right: what was not applied is told as the session\'s state now', async () => {
      sessions.importTable(table([row(A, {overrides: [loosen('maxOutputBytes', 32 * MiB, 16 * MiB), tighten('requestTimeout', 20000)]}), row(B, {overrides: [tighten('requestTimeout', 20000)]})]));
      await resumed(A, {status: 'ok', conditions: 'no', repo: null});
      assert.deepStrictEqual(statesOf(A).pop(), {overrides: [tighten('requestTimeout', 20000)], locks: ['maxOutputBytes', 'pack', 'requestTimeout'], formsLeft: 3});
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
      sessions.importTable(table([row(A, {overrides: [tighten('requestTimeout', 20000)], locks: ['pack'], formsLeft: 2}), row(B, {overrides: [tighten('requestTimeout', 10000)]})]));
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
      assert.deepStrictEqual(sessionState.exportOf(A), {overrides: [tighten('requestTimeout', 20000)], locks: ['pack'], formsLeft: 2});
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
        {session: B, state: {overrides: Array.from({length: 65}, (x, i) => ({name: `pack.p${i}`, value: true, loosening: true, over: null, version: '1.0.0'})), locks: [], formsLeft: 3}},
        {session: B, state: {overrides: [{name: 'requestTimeout', value: '20000', loosening: false, over: null, version: null}], locks: [], formsLeft: 3}},
        {session: B, state: {overrides: [{name: 'requestTimeout', value: 20000, loosening: false, over: null, version: null, extra: 1}], locks: [], formsLeft: 3}},
        {session: B, state: {overrides: [{name: 'locale', value: 'zh', loosening: false, over: null, version: null}], locks: [], formsLeft: 3}},
        {session: B, state: {overrides: [loosen('maxOutputBytes', 32 * MiB, null)], locks: [], formsLeft: 3}},
        {session: B, state: {overrides: [tighten('maxOutputBytes', 1)], locks: [], formsLeft: 3}},
        {session: B, state: {overrides: [], locks: ['pack', 'pack'], formsLeft: 3}},
        {session: B, state: {overrides: [], locks: ['locale'], formsLeft: 3}},
        {session: B, state: {overrides: [], locks: [], formsLeft: 4}},
        {session: B, state: {overrides: [], locks: [], formsLeft: 1.5}},
        {session: 'not-an-id', state: {overrides: [], locks: [], formsLeft: 3}},
        {session: B, state: null}, {session: B}, null, 'x'];
      for (const b of bad) {
        sessionState.resetForTests();
        assert.deepStrictEqual(sessions.importTable(table([b, good])), {sessions: 1}, JSON.stringify(b).slice(0, 120));
      }
      // and a state over the daemon's 64 KiB
      sessionState.resetForTests();
      const fat = row(B, {overrides: Array.from({length: 64}, (x, i) => ({name: `pack.${'p'.repeat(60)}${String(i).padStart(3, '0')}`, value: true, loosening: true, over: null, version: `1.2.3-${'x'.repeat(64)}`}))});
      assert.ok(Buffer.byteLength(JSON.stringify(fat.state)) <= 64 * 1024, 'the largest state a session can have is within it');
      assert.deepStrictEqual(sessions.importTable(table([fat, good])), {sessions: 2});
      // a table that is no table imports nothing
      sessionState.resetForTests();
      for (const no of [null, {}, {sessions: 'x', declines: [], reset: []}, {sessions: [], declines: [], reset: 'x'}]) assert.deepStrictEqual(sessions.importTable(no), {sessions: 0}, JSON.stringify(no));
    });

    it('a session named twice keeps its first row; a second table changes nothing', () => {
      assert.deepStrictEqual(sessions.importTable(table([row(A, {formsLeft: 1}), row(A, {formsLeft: 2})])), {sessions: 1});
      assert.deepStrictEqual(sessions.importTable(table([row(B)])), {sessions: 0}, 'the table was already taken');
      assert.strictEqual(sessionState.pending(), 1);
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
      const lists = [[{kind: 'locale', at: now}], [{kind: 'pack', at: now + 3600 * 1000}], [{kind: 'pack', at: now, session: A}], 'x', null,
        // C's restore lets up to 1024 through; the window takes 64
        Array.from({length: 65}, () => ({kind: 'pack', at: now - 1000}))];
      for (const declines of lists) {
        confirm.resetForTests();
        sessionState.resetForTests();
        sessions.importTable(table([], {declines}));
        for (const kind of ['maxOutputBytes', 'requestTimeout', 'pack']) assert.strictEqual(confirm.userWindow().locked(kind), true, `${kind}: ${JSON.stringify(declines).slice(0, 60)}`);
      }
    });

    it('no table at all (the daemon\'s restore never came): every kind is locked for 30 minutes, and no later table is taken', () => {
      sessionState.noRestore();
      for (const kind of ['maxOutputBytes', 'requestTimeout', 'pack']) assert.strictEqual(confirm.userWindow().locked(kind), true, kind);
      assert.deepStrictEqual(sessions.importTable(table([row(A)])), {sessions: 0});
      assert.strictEqual(sessionState.pending(), 0);
    });
  });
});

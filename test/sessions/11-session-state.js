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

    it('a session\'s end is told, once, after which nothing of it is', () => {
      settings.set(A, 'requestTimeout', 20000);
      told.length = 0;
      sources[A].emit('end');
      assert.deepStrictEqual(told, [{type: 'session-gone', session: A}]);
      assert.strictEqual(sessionState.exportOf(A), null);
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
});

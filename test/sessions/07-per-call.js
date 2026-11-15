'use strict';
// B2 Task 2 (docs/superpowers/plans/2026-11-15-shared-runtime-b2-session-settings.md):
// per-call application, in flight included, server-free. On the main thread
// every check of a call's values takes, field by field, the tighter of the
// call's own (its override, or the defaults) and its session's current ones
// (lib/session-settings.js limitsOf, else the defaults). So a terminal
// tightening, or the session's own, reaches a call already under way at its
// next check; and a call's timer is re-armed, measured from its start.
const assert = require('assert');
const EventEmitter = require('events');
const options = require('../../lib/cli-options');
const callLimits = require('../../lib/call-limits');
const sessions = require('../../lib/sessions');
const settings = require('../../lib/session-settings');
const jobSessions = require('../../lib/job-sessions');
const Session = require('../../lib/session');

describe('sessions 07: a session\'s values on its calls, in flight included (shared runtime B2, Task 2)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  let saved;
  let defaults;
  let sources;
  beforeEach(() => {
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
    options.maxOutputBytes = 1000;
    options.requestTimeout = 60000;
    sessions.resetForTests();
    settings.resetForTests();
    jobSessions.resetForTests();
    const reg = new EventEmitter();
    sessions.attach(reg);
    sources = {};
    for (const id of [A, B]) { const s = new EventEmitter(); s.id = id; s.client = {status: 'ok', conditions: 'no', repo: null}; sources[id] = s; reg.emit('session', s); }
    defaults = () => ({maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout});
    // bounds widened here so a timer case runs in milliseconds, not the tool's 5 s minimum
    settings.configure({ceiling: () => ({state: 'none'}), defaultOf: (n) => defaults()[n], boundsOf: () => ({min: 1, max: 2 ** 31 - 1})});
  });
  afterEach(() => { Object.assign(options, saved); sessions.resetForTests(); settings.resetForTests(); jobSessions.resetForTests(); });

  const loosen = (id, name, value) => settings.set(id, name, value, {loosening: true, over: defaults()[name]});
  const callOf = (id) => {
    const s = new Session(null, null, 'u', 'k', 0, 'd', 0, () => {});
    s.sessionId = id;
    const own = settings.limitsOf(id);
    if (own != null) callLimits.override(s, own);   // as the gateway does at a direct call's start
    return s;
  };

  it('one session\'s raise holds its own calls only: A\'s call at 9000, B\'s at the default', () => {
    loosen(A, 'maxOutputBytes', 9000);
    assert.strictEqual(callLimits.of(callOf(A)).maxOutputBytes, 9000);
    assert.strictEqual(callLimits.of(callOf(B)).maxOutputBytes, 1000);
  });

  it('a hop\'s token entry (its session on it) is held to its session\'s values', () => {
    loosen(A, 'maxOutputBytes', 9000);
    const entry = {limits: settings.limitsOf(A), session: A};
    assert.strictEqual(callLimits.of(entry).maxOutputBytes, 9000);
    // a holder with no session of its own (the reply cap's) takes one passed in
    assert.strictEqual(callLimits.of({limits: settings.limitsOf(A)}, A).maxOutputBytes, 9000);
  });

  it('a terminal tightening reaches a call already under way at its next check (its override dropped)', () => {
    loosen(A, 'maxOutputBytes', 9000);
    const call = callOf(A);
    options.maxOutputBytes = 2000;
    assert.deepStrictEqual(settings.dropLooser('maxOutputBytes', 2000), [A]);
    assert.strictEqual(callLimits.of(call).maxOutputBytes, 2000, 'the call started at 9000');
  });

  it('the session\'s own tightening reaches its call under way too; a raise mid-call does not loosen it', () => {
    loosen(A, 'maxOutputBytes', 9000);
    const call = callOf(A);
    settings.set(A, 'maxOutputBytes', 300);
    assert.strictEqual(callLimits.of(call).maxOutputBytes, 300);
    loosen(A, 'maxOutputBytes', 20000);
    assert.strictEqual(callLimits.of(call).maxOutputBytes, 9000, 'never looser than it started');
  });

  it('a call\'s timer is re-armed at the session\'s tightened timeout, from the call\'s start', async () => {
        const call = callOf(A);
    const started = Date.now();
    const fired = new Promise((resolve) => { call.callback = (err) => resolve({err, ms: Date.now() - started}); });
    call.installTimer(() => {});
    settings.set(A, 'requestTimeout', 200);
    Session.rearmSession(A);
    const {err, ms} = await fired;
    assert.strictEqual(err.code, 'DEVICE_NOT_RESPONDING');
    assert.ok(ms >= 150 && ms < 2000, `${ms} ms`);
  });

  it('a terminal tightening re-arms every call under way (rearmAll)', async () => {
    const call = callOf(B);
    const started = Date.now();
    const fired = new Promise((resolve) => { call.callback = () => resolve(Date.now() - started); });
    call.installTimer(() => {});
    options.requestTimeout = 200;
    Session.rearmAll();
    const ms = await fired;
    assert.ok(ms >= 150 && ms < 2000, `${ms} ms`);
  });

  it('a hop\'s call is held to its caller\'s session: the session\'s tightening re-arms its timer (holdTo; #271 review, 1)', async () => {
    loosen(A, 'requestTimeout', 120000);
    const hop = new Session(null, null, 'u', 'k', 0, 'd', 0, () => {});
    hop.holdTo({limits: settings.limitsOf(A), session: A});   // as device-manager does for a hop
    const started = Date.now();
    const fired = new Promise((resolve) => { hop.callback = () => resolve(Date.now() - started); });
    hop.installTimer(() => {});
    settings.set(A, 'requestTimeout', 200);
    Session.rearmSession(A);
    const ms = await fired;
    assert.ok(ms >= 150 && ms < 2000, `${ms} ms`);
  });

  it('a deadline only moves earlier: a tightening, a raise and a smaller tightening keep the first (#271 review, 2)', () => {
    loosen(A, 'requestTimeout', 120000);
    const call = callOf(A);
    call.callback = () => {};
    call.installTimer(() => {});
    const start = call.timerStart;
    assert.strictEqual(call.deadline, start + 120000);
    settings.set(A, 'requestTimeout', 1000);
    Session.rearmSession(A);
    assert.strictEqual(call.deadline, start + 1000);
    loosen(A, 'requestTimeout', 120000);
    settings.set(A, 'requestTimeout', 5000);
    Session.rearmSession(A);
    assert.strictEqual(call.deadline, start + 1000, 'never later');
    call.clearDeviceTimer();
  });

  it('a session that ends re-arms its calls under way at the defaults (#271 review, 3)', () => {
    loosen(A, 'requestTimeout', 120000);
    const call = callOf(A);
    call.callback = () => {};
    call.installTimer(() => {});
    const start = call.timerStart;
    sources[A].emit('end');
    assert.strictEqual(call.deadline, start + 60000);
    call.clearDeviceTimer();
  });

  it('a peer entry\'s deadline takes its session\'s tightening, never later than it was given (#271 review, 4)', () => {
    const Broker = require('../../lib/peer-channel-broker');
    loosen(A, 'requestTimeout', 120000);
    const at = Date.now();
    const entry = {at, deadline: at + 90000, limits: settings.limitsOf(A), session: A};
    assert.strictEqual(Broker.deadlineNow(entry), at + 90000, 'the caller\'s time left');
    settings.set(A, 'requestTimeout', 500);
    assert.strictEqual(Broker.deadlineNow(entry), at + 500);
  });

  it('a finished call leaves the index; a live session\'s job run takes the session\'s caps', () => {
    const call = callOf(A);
    call.installTimer(() => {});
    call.clearDeviceTimer();
    assert.strictEqual(Session.inFlightCount(A), 0);
    loosen(A, 'maxOutputBytes', 9000);
    jobSessions.remember('j1', A);
    assert.deepStrictEqual(jobSessions.forRun('j1'), {session: A, limits: settings.limitsOf(A)});
  });

  it('the validators grow for a session\'s raise, awaited (growFor; resize only grows: sandbox 52); with no pool yet, nothing to grow', async () => {
    // a fresh copy of the module, so no pool another file started (in a full
    // run) is taken for this one's; the cached one is put back after
    const key = require.resolve('../../lib/validator-pool');
    const cached = require.cache[key];
    delete require.cache[key];
    try {
      const pool = require(key);
      assert.strictEqual(pool.started(), null);
      await pool.growFor(16 * 1024 * 1024);
      assert.strictEqual(pool.started(), null, 'growFor starts no pool');
    } finally {
      if (cached != null) require.cache[key] = cached; else delete require.cache[key];
    }
  });
});

'use strict';
// B1 Task 3 (as the reviewer ruled, 2026-11-15): a job's session lives on the
// main thread only, in memory (lib/job-sessions.js): never in job data, its
// history or the store. A run of a job whose session is live takes the
// session; one whose session has ended takes the session's last override
// bounded by the defaults (lib/call-limits.js bound: 'defaults'), so at each
// check a loosening never outlives its session, a tightening does, and a
// later tightening of the defaults still reaches the run; one with no entry
// (a job from no session, or after a restart) takes none: the defaults.
// Whether a session is live is lib/sessions.js's answer, never a guess from
// what this map holds.
const assert = require('assert');
const EventEmitter = require('events');
const options = require('../../lib/cli-options');
const callLimits = require('../../lib/call-limits');
const sessions = require('../../lib/sessions');
const jobSessions = require('../../lib/job-sessions');

describe('sessions 04: a job\'s session, in memory on the main thread (B1 Task 3)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  let saved;
  let reg;
  const live = {};
  // a live session, as C1's registry announces one
  function open(id) {
    const s = new EventEmitter();
    s.id = id;
    s.client = {status: 'ok', conditions: 'no', repo: null};
    reg.emit('session', s);
    live[id] = s;
  }
  const end = (id) => live[id].emit('end');
  const valuesOf = (key) => callLimits.of({limits: jobSessions.forRun(key).limits});
  beforeEach(() => {
    jobSessions.resetForTests();
    sessions.resetForTests();
    reg = new EventEmitter();
    sessions.attach(reg);
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
    options.maxOutputBytes = 1000;
    options.requestTimeout = 5000;
  });
  afterEach(() => { Object.assign(options, saved); sessions.resetForTests(); jobSessions.resetForTests(); });

  it('a run of a live session\'s job takes the session, with no values of its own', () => {
    open(A);
    jobSessions.remember('j1', A);
    assert.deepStrictEqual(jobSessions.forRun('j1'), {session: A, limits: null});
  });

  it('after its session ends, a job its session LOOSENED runs at the defaults (a loosening never outlives its session)', () => {
    open(A);
    jobSessions.remember('j1', A);
    sessions.overrideForTests(A, {maxOutputBytes: 9000, requestTimeout: 60000});
    end(A);
    assert.strictEqual(jobSessions.forRun('j1').session, A);
    assert.deepStrictEqual(valuesOf('j1'), {maxOutputBytes: 1000, requestTimeout: 5000});
  });

  it('after its session ends, a job its session TIGHTENED stays tight, field by field; a later tightening of the defaults still reaches it', () => {
    open(A);
    jobSessions.remember('j1', A);
    sessions.overrideForTests(A, {maxOutputBytes: 300, requestTimeout: 60000});
    end(A);
    const limits = jobSessions.forRun('j1').limits;   // what the run's token and message carry
    assert.deepStrictEqual(callLimits.of({limits}), {maxOutputBytes: 300, requestTimeout: 5000});
    options.maxOutputBytes = 200;
    options.requestTimeout = 4000;   // tightened while the run is under way: never pinned at its start
    assert.deepStrictEqual(callLimits.of({limits}), {maxOutputBytes: 200, requestTimeout: 4000});
    // and a hop of that run stays bounded
    assert.deepStrictEqual(callLimits.of({limits: callLimits.tighter(null, limits)}), {maxOutputBytes: 200, requestTimeout: 4000});
  });

  it('a session that ends with no override: its jobs run at the defaults as they are at each check', () => {
    open(A);
    jobSessions.remember('j1', A);
    end(A);
    assert.deepStrictEqual(jobSessions.forRun('j1'), {session: A, limits: null});
  });

  it('a session the map never saw end is not taken for live: an unknown session is ended, at the defaults', () => {
    jobSessions.remember('j1', B);   // B was never live here (it ended before its job was remembered)
    assert.deepStrictEqual(jobSessions.forRun('j1'), {session: B, limits: null});
  });

  it('a job with no entry (no session, or a restart) runs as no session\'s; a dropped one too', () => {
    assert.deepStrictEqual(jobSessions.forRun('none'), {session: null, limits: null});
    open(A);
    jobSessions.remember('j1', A);
    jobSessions.forget('j1');
    assert.deepStrictEqual(jobSessions.forRun('j1'), {session: null, limits: null});
  });

  it('an ended session\'s override is kept while it has jobs, and dropped with its last', () => {
    open(A);
    jobSessions.remember('j1', A);
    jobSessions.remember('j2', A);
    sessions.overrideForTests(A, {maxOutputBytes: 300, requestTimeout: 60000});
    end(A);
    jobSessions.forget('j1');
    assert.strictEqual(valuesOf('j2').maxOutputBytes, 300, 'kept for j2');
    jobSessions.forget('j2');
    jobSessions.remember('j3', A);   // (only a test can: the gateway refuses an ended session's job)
    assert.deepStrictEqual(jobSessions.forRun('j3'), {session: A, limits: null}, 'dropped with its last job: ended, no override');
  });

  it('the bounded form in lib/call-limits.js: check keeps the mark, a worker\'s copy (forToken) is bounded too, a plain override is not', () => {
    const bounded = callLimits.check({maxOutputBytes: 9000, requestTimeout: 300, bound: 'defaults'});
    assert.strictEqual(bounded.bound, 'defaults');
    callLimits.remember('tk', bounded);
    assert.deepStrictEqual(callLimits.forToken('tk'), {maxOutputBytes: 1000, requestTimeout: 300});
    callLimits.forget('tk');
    assert.deepStrictEqual(callLimits.of({limits: {maxOutputBytes: 9000, requestTimeout: 300}}), {maxOutputBytes: 9000, requestTimeout: 300}, 'a live session\'s loosening (B2) stays its own');
    assert.strictEqual(callLimits.check({maxOutputBytes: 1, requestTimeout: 1, bound: 'other'}).bound, undefined);
  });

  it('re-remembering a key moves it; only an id is kept', () => {
    open(A);
    open(B);
    jobSessions.remember('j1', A);
    jobSessions.remember('j1', B);
    assert.strictEqual(jobSessions.forRun('j1').session, B);
    assert.strictEqual(jobSessions.size(), 1);
    jobSessions.remember('j2', {id: A});
    jobSessions.remember(7, A);
    assert.strictEqual(jobSessions.size(), 1);
  });
});

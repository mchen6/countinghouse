'use strict';
// B2 Task 3 (docs/superpowers/plans/2026-11-15-shared-runtime-b2-session-settings.md;
// B1's Task 5 folded in), server-free: in a shared runtime the notices and
// the logging level are each session's own. A notice for one session is
// said to it alone, as its notifications/message (its s.notify) and on its
// next result; a global one (a terminal change, a pack ch-local changed) is
// copied into every open session's queue once. A session's
// logging/setLevel is its own. A session's queue ends with it, and a
// session opened after a plain global notice doesn't get it (one told to
// every session as a standing fact is kept for it: sessions 38). Under --stdio and
// over HTTP there's one queue, as before (stdio 13).
const assert = require('assert');
const EventEmitter = require('events');
const options = require('../../lib/cli-options');
const notices = require('../../lib/notices');
const sessions = require('../../lib/sessions');
const settings = require('../../lib/session-settings');
const jobSessions = require('../../lib/job-sessions');
const settingsTool = require('../../lib/settings-tool');
const {finishToolCall} = require('../../lib/usage/receipt');

const MiB = 1024 * 1024;

describe('sessions 08: notices and logging/setLevel per session (shared runtime B2, Task 3)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const C = 'c'.repeat(32);
  let reg;
  let sources;
  let sent;
  let saved;
  // legacy: the session sent initialize, so it's sent notifications/message
  const openSession = (id, {legacy = true} = {}) => {
    const s = new EventEmitter();
    s.id = id;
    s.client = {status: 'ok', conditions: 'no', repo: null};
    sent[id] = [];
    s.notify = (m) => sent[id].push(m);
    sources[id] = s;
    reg.emit('session', s);
    if (legacy) sessions.recordClientInfo(id, {name: 'test-client', version: '1.0.0'});
    return s;
  };
  const reset = () => { sessions.resetForTests(); settings.resetForTests(); jobSessions.resetForTests(); notices.resetForTests(); settingsTool.resetForTests(); };
  beforeEach(() => {
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
    reset();
    reg = new EventEmitter();
    sessions.attach(reg);
    sources = {};
    sent = {};
    openSession(A);
    openSession(B);
  });
  afterEach(() => { Object.assign(options, saved); reset(); });

  // the notices a session's next result of a tool of `module` carries
  const resultFor = (id, module = 'ch-pack-x') => finishToolCall({usage: null, call: null, result: {content: [{type: 'text', text: 'r'}]},
    role: 'scenario', tool: 't', module, startedMs: 0, session: id}).content.map((c) => c.text).slice(1);
  const said = (id) => sent[id].map((m) => m.params.data);
  const setLevel = (id, level) => new Promise((resolve) => require('../../lib/mcp/gateway').handle(
    {jsonrpc: '2.0', id: 1, method: 'logging/setLevel', params: {level}}, null, null, (e, out) => resolve(out), {session: sources[id]}));

  it('a per-session notice reaches its session only: as its notifications/message and on its next result, once', () => {
    notices.add('ch-pack-x', 'for A', {session: A});
    assert.deepStrictEqual(said(A), ['for A']);
    assert.deepStrictEqual(sent[A][0], {jsonrpc: '2.0', method: 'notifications/message', params: {level: 'notice', logger: 'countinghouse', data: 'for A'}});
    assert.deepStrictEqual(said(B), []);
    assert.deepStrictEqual(resultFor(B), []);
    assert.deepStrictEqual(resultFor(A), ['for A']);
    assert.deepStrictEqual(resultFor(A), [], 'once');
  });

  it('a global notice reaches each open session once', () => {
    notices.add(null, 'for all');
    assert.deepStrictEqual(said(A), ['for all']);
    assert.deepStrictEqual(said(B), ['for all']);
    assert.deepStrictEqual(resultFor(A, 'ch-pack-y'), ['for all']);
    assert.deepStrictEqual(resultFor(A, 'ch-pack-y'), [], 'once');
    assert.deepStrictEqual(resultFor(B), ['for all']);
  });

  it('a session\'s level is its own: logging/setLevel through the gateway; the result line is kept', async () => {
    assert.deepStrictEqual((await setLevel(A, 'warning')).result, {});
    notices.add(null, 'quiet for A');
    assert.deepStrictEqual(said(A), [], 'above notice: no notification for A');
    assert.deepStrictEqual(said(B), ['quiet for A']);
    assert.deepStrictEqual(resultFor(A), ['quiet for A'], 'its result still carries it');
    const bad = await setLevel(B, 'loud');
    assert.ok(bad.error != null && /params.level/.test(bad.error.message), JSON.stringify(bad));
  });

  it('a session\'s queue ends with it; a session opened after a global notice doesn\'t get it', () => {
    notices.add('ch-pack-x', 'pending for A', {session: A});
    sources[A].emit('end');
    assert.deepStrictEqual(resultFor(A), [], 'gone with its session');
    notices.add('ch-pack-x', 'for an ended session', {session: A});
    assert.deepStrictEqual(resultFor(A), [], 'nothing is kept for an ended one');
    notices.add(null, 'before C');
    openSession(C);
    assert.deepStrictEqual(resultFor(C), []);
    assert.deepStrictEqual(said(C), []);
    assert.deepStrictEqual(resultFor(B), ['before C']);
  });

  it('a terminal tightening tells the session whose loosening it ended, and no other (Task 2\'s dropped override)', () => {
    options.maxOutputBytes = 8 * MiB;
    settingsTool.captureAtStart();
    settings.configure({ceiling: () => ({state: 'none'}), defaultOf: (n) => options[n]});
    settings.set(A, 'maxOutputBytes', 16 * MiB, {loosening: true, over: 8 * MiB});
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'maxOutputBytes', value: 4 * MiB}), {ok: true});
    const sentence = 'your this-session loosening of maxOutputBytes ended: the default was lowered to 4MiB';
    assert.deepStrictEqual(said(A), [sentence]);
    assert.deepStrictEqual(resultFor(A), [sentence]);
    assert.deepStrictEqual(said(B), []);
    assert.deepStrictEqual(resultFor(B), []);
  });

  it('a session that never sent initialize (a 2026-07-28 one) is sent no notification; its next result carries the notice (review, 1)', () => {
    openSession(C, {legacy: false});
    notices.add(null, 'for all');
    assert.deepStrictEqual(said(C), [], 'nothing unasked');
    assert.deepStrictEqual(resultFor(C), ['for all']);
    assert.deepStrictEqual(said(A), ['for all']);
  });

  it('a level for a session whose notices aren\'t open is refused, not answered as set (review, 3)', async () => {
    notices.forget(B);
    const r = await setLevel(B, 'warning');
    assert.ok(r.error != null && /cannot be set now/.test(r.error.message), JSON.stringify(r));
  });

  it('what the process queue held before shared mode is dropped when it starts (review, 5)', () => {
    reset();
    notices.add(null, 'before the sessions');
    reg = new EventEmitter();
    sessions.attach(reg);
    openSession(A);
    assert.deepStrictEqual(resultFor(A), []);
    // the process queue, seen with shared mode off again: emptied, nothing stranded
    sessions.resetForTests();
    assert.deepStrictEqual(notices.take(null), [], 'nothing stranded');
  });

  it('a notice that is one session\'s, with no session named, is dropped, never said to all (fails closed; #279 review)', () => {
    notices.add(null, 'a confirmed change', {session: null, sessionOnly: true});
    assert.deepStrictEqual(said(A), []);
    assert.deepStrictEqual(said(B), []);
    assert.deepStrictEqual(resultFor(A), []);
    notices.add(null, 'its own', {session: A, sessionOnly: true});
    assert.deepStrictEqual(said(A), ['its own']);
  });

  it('a per-session queue is bounded as the global one is, and never silent', () => {
    for (let n = 1; n <= notices.PER_MODULE_MAX + 2; n++) notices.add('ch-pack-x', `change ${n}`, {session: A});
    const out = resultFor(A);
    assert.strictEqual(out.length, notices.PER_MODULE_MAX + 1);
    assert.strictEqual(out[0], '2 earlier changes to ch-pack-x not listed here');
  });

  it('a notice for a session that isn\'t a string id, or a level for none, changes nothing', () => {
    notices.add('ch-pack-x', 'odd', {session: 42});
    assert.deepStrictEqual(said(A), []);
    assert.deepStrictEqual(said(B), []);
    assert.strictEqual(notices.setLevel('warning', 'f'.repeat(32)), false, 'no such session');
  });
});

'use strict';
// Standing notices (a shared runtime), server-free: what is told to every
// session -- ch-local's start-time lines over the control channel, a module
// loaded, unloaded, turned off, a value not applied -- reaches a session that
// joins later too. ch-local's start sends its lines as soon as the runtime's
// control channel is up, before any session can have settled, so without
// this they reached no session at all. A joining session gets them queued at
// its open, each with when it was told ("Earlier, before this session joined
// (<ISO time>): ..."), never as a notification then. Bounded: the newest five
// of each kind, 64 kinds, each for 24 hours; past a bound the oldest go, and
// the joining session is told in one line how many of this run's were let go.
// A transition seen from inside a session (a change another session made for
// all) and a session's own notice are never kept for another.
const assert = require('assert');
const EventEmitter = require('events');
const notices = require('../../lib/notices');
const sessions = require('../../lib/sessions');
const settings = require('../../lib/session-settings');
const jobSessions = require('../../lib/job-sessions');
const settingsTool = require('../../lib/settings-tool');
const {tellEverySession} = require('../../lib/modules-in-place');
const {finishToolCall} = require('../../lib/usage/receipt');

describe('sessions 38: a global notice for the sessions that join later', () => {
  const A = 'a'.repeat(32);
  const C = 'c'.repeat(32);
  const D = 'd'.repeat(32);
  const T0 = Date.parse('2026-11-28T12:00:00.000Z');
  let clock;
  let reg;
  let sent;
  const openSession = (id, {legacy = true} = {}) => {
    const s = new EventEmitter();
    s.id = id;
    s.client = {status: 'ok', conditions: 'no', repo: null};
    sent[id] = [];
    s.notify = (m) => sent[id].push(m);
    reg.emit('session', s);
    if (legacy) sessions.recordClientInfo(id, {name: 'test-client', version: '1.0.0'});
    return s;
  };
  const reset = () => { sessions.resetForTests(); settings.resetForTests(); jobSessions.resetForTests(); notices.resetForTests(); settingsTool.resetForTests(); };
  beforeEach(() => {
    reset();
    clock = T0;
    notices.configure({now: () => clock});
    reg = new EventEmitter();
    sessions.attach(reg);
    sent = {};
  });
  afterEach(() => reset());

  // the notices a session's next result of a tool of `module` carries
  const resultFor = (id, module = 'ch-pack-x') => finishToolCall({usage: null, call: null, result: {content: [{type: 'text', text: 'r'}]},
    role: 'scenario', tool: 't', module, startedMs: 0, session: id}).content.map((c) => c.text).slice(1);
  const earlier = (at, text) => `Earlier, before this session joined (${new Date(at).toISOString()}): ${text}`;

  it('a line told before any session reaches the first to join and a later one, each once, with when it was told', () => {
    tellEverySession(null, 'under audit, countinghouse logs what a pack reads');
    clock += 5000;
    openSession(C);
    assert.deepStrictEqual(resultFor(C), [earlier(T0, 'under audit, countinghouse logs what a pack reads')]);
    assert.deepStrictEqual(resultFor(C), [], 'once');
    openSession(D);
    assert.deepStrictEqual(resultFor(D), [earlier(T0, 'under audit, countinghouse logs what a pack reads')]);
  });

  it('a session open when it was told hears it then, and never again; one that joins later is told it was earlier', () => {
    openSession(A);
    tellEverySession('ch-pack-x', 'ch-pack-x unloaded: its files changed');
    assert.deepStrictEqual(resultFor(A), ['ch-pack-x unloaded: its files changed']);
    openSession(C);
    assert.deepStrictEqual(resultFor(C), [earlier(T0, 'ch-pack-x unloaded: its files changed')]);
    assert.deepStrictEqual(resultFor(A), [], 'A is not told again');
  });

  it('at its open, a joining session is sent no notification: its next result carries them', () => {
    tellEverySession(null, 'told before');
    openSession(C);
    assert.deepStrictEqual(sent[C], []);
    assert.strictEqual(resultFor(C).length, 1);
    // (a session is not yet one that sent initialize at its open; a notifier
    // that would send is given none at the open either)
    const heard = [];
    notices.openSession(D, (m) => heard.push(m));
    assert.deepStrictEqual(heard, []);
    assert.strictEqual(notices.take(null, D).length, 1);
  });

  it('a change another session made for all, a session\'s own notice, and a plain global notice are not kept for a later one', () => {
    openSession(A);
    notices.add(null, 'requestTimeout changed to 20s for all sessions (changed from another session)', {except: A});
    notices.add(null, 'yours alone', {session: A, sessionOnly: true});
    notices.add(null, 'a plain global notice');
    openSession(C);
    assert.deepStrictEqual(resultFor(C), []);
  });

  it('the runtime\'s own lane keeps its own bound and comes first', () => {
    tellEverySession('ch-pack-x', 'about the pack');
    tellEverySession(null, 'x'.repeat(650), {own: true});
    openSession(C);
    const got = resultFor(C);
    assert.strictEqual(got[0], earlier(T0, 'x'.repeat(650)), 'the own lane first, whole');
    assert.strictEqual(got[1], earlier(T0, 'about the pack'));
  });

  describe('past a bound: the oldest go, and how many is said once', () => {
    const dropped = (lines) => lines.filter((l) => /^\d+ earlier notices? /.test(l));
    // business's words, whole (validation 04 pins them too)
    const BOUNDS = 'a session that joins later is given only the newest (5 of each kind, up to 64 kinds, from the last 24 hours)';

    it('the newest five of a kind', () => {
      for (let i = 1; i <= 7; i++) { tellEverySession('ch-pack-x', `change ${i}`); clock += 1000; }
      openSession(C);
      const got = resultFor(C);
      assert.deepStrictEqual(got.filter((l) => l.startsWith('Earlier')), [3, 4, 5, 6, 7].map((i) => earlier(T0 + (i - 1) * 1000, `change ${i}`)));
      assert.strictEqual(dropped(got).length, 1);
      assert.deepStrictEqual(dropped(got), [`2 earlier notices from this run are not shown here: ${BOUNDS}`]);
    });

    it('64 kinds: a 65th lets the kind told longest ago go, all of it', () => {
      for (let i = 0; i < 65; i++) { tellEverySession(`ch-pack-${i}`, `about ${i}`); tellEverySession(`ch-pack-${i}`, `again ${i}`); clock += 1000; }
      openSession(C);
      const all = [];
      for (let i = 0; i < 65; i++) all.push(...resultFor(C, `ch-pack-${i}`));
      assert.ok(!all.some((l) => l.endsWith(': about 0') || l.endsWith(': again 0')), 'the first kind gone');
      assert.ok(all.some((l) => l.endsWith(': again 64')));
      assert.strictEqual(all.filter((l) => l.startsWith('Earlier')).length, 128);
      assert.deepStrictEqual(dropped(all), [`2 earlier notices from this run are not shown here: ${BOUNDS}`]);
    });

    it('24 hours: one told longer ago is not given, and is counted', () => {
      tellEverySession(null, 'old');
      clock += 12 * 3600 * 1000;
      tellEverySession(null, 'newer');
      clock += 12 * 3600 * 1000 + 1;
      openSession(C);
      const got = resultFor(C);
      assert.deepStrictEqual(got.filter((l) => l.startsWith('Earlier')), [earlier(T0 + 12 * 3600 * 1000, 'newer')]);
      assert.deepStrictEqual(dropped(got), [`1 earlier notice from this run is not shown here: ${BOUNDS}`]);
    });

    it('nothing let go, nothing said of it', () => {
      tellEverySession(null, 'one');
      openSession(C);
      assert.deepStrictEqual(dropped(resultFor(C)), []);
    });
  });

  it('under --stdio (no shared runtime) nothing is kept: the one queue holds a notice until a result takes it, as before', () => {
    reset();
    notices.configure({now: () => clock});
    tellEverySession(null, 'one queue');
    assert.deepStrictEqual(notices.take(null), ['one queue']);
    assert.deepStrictEqual(notices.take(null), []);
  });
});

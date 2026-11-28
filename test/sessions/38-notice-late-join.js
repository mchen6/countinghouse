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
  const openSession = (id, {legacy = true, restored = false} = {}) => {
    const s = new EventEmitter();
    s.id = id;
    if (restored) s.restoredAfterRestart = true;
    s.client = {status: 'ok', conditions: 'no', repo: null};
    sent[id] = [];
    s.notify = (m) => sent[id].push(m);
    reg.emit('session', s);
    if (legacy) sessions.recordClientInfo(id, {name: 'test-client', version: '1.0.0'});
    return s;
  };
  const reset = () => { sessions.resetForTests(); settings.resetForTests(); jobSessions.resetForTests(); notices.resetForTests(); settingsTool.resetForTests(); require('../../lib/module-visibility').resetForTests(); };
  beforeEach(() => {
    reset();
    clock = T0;
    notices.configure({now: () => clock, wall: () => clock});
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

  it('each line of no module is a kind of its own: a start of many lines keeps them all; one told again is kept once, with the newer time', () => {
    const lines = ['an outside edit', 'a ceiling note', 'another ceiling note', 'the audit line', 'a module not loaded', 'the upgrade check', 'no module is loaded'];
    for (const l of lines) tellEverySession(null, l);
    clock += 1000;
    tellEverySession(null, 'the audit line');
    openSession(C);
    const got = resultFor(C);
    assert.deepStrictEqual(got, [...lines.filter((l) => l !== 'the audit line').map((l) => earlier(T0, l)), earlier(T0 + 1000, 'the audit line')]);
  });

  it('a session back after a runtime restart (as its registry restored it, whatever its state) is told the new run\'s, as from after the restart', () => {
    tellEverySession(null, 'under audit, countinghouse logs what a pack reads');
    openSession(C, {restored: true});
    assert.deepStrictEqual(resultFor(C), [`After a runtime restart, before this session resumed (${new Date(T0).toISOString()}): under audit, countinghouse logs what a pack reads`]);
    // the registry marks the sessions it restores after a runtime restart, every one
    const {createRegistry} = require('../../lib/session-transport/registry');
    const r = createRegistry({reconnectWindowMs: 60000});
    r._restore([{session: D, resume: 'f'.repeat(64)}]);
    try {
      assert.strictEqual(r._byId.get(D).restoredAfterRestart, true);
    } finally {
      clearTimeout(r._byId.get(D)._window);
    }
  });

  it('a module loaded again clears what was kept about it, not counted as let go: its off text is no longer told', () => {
    tellEverySession(null, '@acme/x turned off: turn it on with the way back', {own: true, about: '@acme/x'});
    clock += 1000;
    tellEverySession('x-tool', '@acme/x loaded again', {about: '@acme/x', clears: true});
    openSession(C);
    assert.deepStrictEqual(resultFor(C, 'x-tool'), [earlier(T0 + 1000, '@acme/x loaded again')]);
  });

  it('one module\'s own texts are one kind: many of them never push the other kinds out', () => {
    tellEverySession('ch-pack-y', 'about y');
    for (let i = 0; i < 70; i++) { clock += 1000; tellEverySession(null, `@acme/x turned off (callers ${i})`, {own: true, about: '@acme/x'}); }
    openSession(C);
    const got = [...resultFor(C, 'ch-pack-y')];
    assert.ok(got.includes(earlier(T0, 'about y')), 'the other kind kept');
    assert.strictEqual(got.filter((l) => l.includes('@acme/x turned off')).length, 5, 'the newest five of that one kind');
  });

  it('a notice about a module hidden at a session\'s open waits, and is given to it once the module is shown', () => {
    const visibility = require('../../lib/module-visibility');
    tellEverySession(null, '@acme/m: its settings changed', {about: '@acme/m'});
    visibility.hide(['@acme/m']);
    openSession(C);
    assert.deepStrictEqual(resultFor(C), []);
    visibility.show(['@acme/m']);
    assert.deepStrictEqual(resultFor(C), [earlier(T0, '@acme/m: its settings changed')]);
  });

  it('order and age by the monotonic clock: a wall clock stepped back changes only the time shown', () => {
    let wallNow = T0;
    notices.configure({wall: () => wallNow});
    tellEverySession(null, 'first');
    clock += 1000;
    wallNow -= 3600 * 1000;
    tellEverySession(null, 'second');
    openSession(C);
    assert.deepStrictEqual(resultFor(C), [earlier(T0, 'first'), earlier(T0 - 3600 * 1000, 'second')]);
  });

  describe('past a bound: the oldest go, and how many is said once', () => {
    const dropped = (lines) => lines.filter((l) => /^\d+ earlier notices? /.test(l));
    // the words, whole (validation 04 pins them too)
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

    it('the runtime\'s own lane goes last: 64 newer kinds of modules let a module kind go before it', () => {
      tellEverySession(null, 'm0 turned off: run the way back', {own: true});
      clock += 1000;
      for (let i = 1; i <= 64; i++) { tellEverySession(`ch-pack-${i}`, `about ${i}`); clock += 1000; }
      openSession(C);
      const got = resultFor(C);
      assert.ok(got.includes(earlier(T0, 'm0 turned off: run the way back')), 'the own lane kept');
      const all = [...got];
      for (let i = 1; i <= 64; i++) all.push(...resultFor(C, `ch-pack-${i}`));
      assert.ok(!all.some((l) => l.endsWith(': about 1')), 'the oldest module kind went');
      assert.deepStrictEqual(dropped(all), [`1 earlier notice from this run is not shown here: ${BOUNDS}`]);
    });

    it('the dropped line has a lane of its own: live notices queued after it never push it out', () => {
      for (let i = 1; i <= 6; i++) tellEverySession('ch-pack-x', `change ${i}`);
      openSession(C);
      for (let i = 0; i < 25; i++) notices.add(null, `live ${i}`, {session: C, own: true});
      assert.deepStrictEqual(dropped(resultFor(C)), [`1 earlier notice from this run is not shown here: ${BOUNDS}`]);
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

    it('a line let go and told again is not counted as let go', () => {
      tellEverySession(null, 'the audit line');
      clock += 24 * 3600 * 1000 + 1;
      // (another line's keep lets the first go, past 24 hours)
      tellEverySession(null, 'another line');
      tellEverySession(null, 'the audit line');
      openSession(C);
      assert.deepStrictEqual(resultFor(C), [earlier(T0 + 24 * 3600 * 1000 + 1, 'another line'), earlier(T0 + 24 * 3600 * 1000 + 1, 'the audit line')]);
    });

    it('24 hours by the wall clock too (a monotonic clock stops while the machine sleeps)', () => {
      let wallNow = T0;
      notices.configure({wall: () => wallNow});
      tellEverySession(null, 'before the sleep');
      clock += 1000;
      wallNow += 25 * 3600 * 1000;
      openSession(C);
      assert.deepStrictEqual(resultFor(C), [`1 earlier notice from this run is not shown here: ${BOUNDS}`]);
    });

    it('nothing let go, nothing said of it', () => {
      tellEverySession(null, 'one');
      openSession(C);
      assert.deepStrictEqual(dropped(resultFor(C)), []);
    });
  });

  it('under --stdio (no shared runtime) nothing is kept: the one queue holds a notice until a result takes it, as before', () => {
    reset();
    notices.configure({now: () => clock, wall: () => clock});
    tellEverySession(null, 'one queue');
    assert.deepStrictEqual(notices.take(null), ['one queue']);
    assert.deepStrictEqual(notices.take(null), []);
  });
});

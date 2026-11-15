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
    Session.holdTo(hop, {limits: settings.limitsOf(A), session: A});   // as device-manager does for a hop
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

  // The reviewer's ruling on #284: a call is held to the tighter of the
  // start's default and the operator's ceiling, override or none. A runtime
  // ch-local started has its defaults clamped to the ceiling already; one
  // started another way, with a default above it, must not serve above it.
  describe('held to the operator\'s ceiling, with an override or none', () => {
    const under = (ceiling) => settings.configure({ceiling: () => ceiling, defaultOf: (n) => defaults()[n], boundsOf: () => ({min: 1, max: 2 ** 31 - 1})});
    const trusted = (c) => ({state: 'trusted', ceiling: Object.assign({forbid: [], conversation: true}, c)});

    it('a session with no override: its call, a hop\'s token entry and the reply cap are held to the ceiling, not the default above it', () => {
      under(trusted({maxOutputBytes: 600, requestTimeout: 20000}));
      assert.strictEqual(settings.limitsOf(A), null, 'no override');
      assert.deepStrictEqual(callLimits.of(callOf(A)), {maxOutputBytes: 600, requestTimeout: 20000});
      assert.deepStrictEqual(callLimits.of({limits: null, session: A}), {maxOutputBytes: 600, requestTimeout: 20000});
      // a holder with no session of its own, its session passed in (the reply cap)
      assert.deepStrictEqual(callLimits.of({limits: null}, A), {maxOutputBytes: 600, requestTimeout: 20000});
      // what the session is shown is what it is held to
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 600);
      assert.strictEqual(settings.effective(A, 'requestTimeout'), 20000);
    });

    it('a ceiling that names only one of them bounds that one', () => {
      under(trusted({maxOutputBytes: 600}));
      assert.deepStrictEqual(callLimits.of(callOf(A)), {maxOutputBytes: 600, requestTimeout: 60000});
    });

    it('a ceiling that turns conversation off, or forbids the setting, still bounds it', () => {
      for (const c of [{maxOutputBytes: 600, conversation: false}, {maxOutputBytes: 600, forbid: ['maxOutputBytes']}]) {
        under(trusted(c));
        assert.strictEqual(callLimits.of(callOf(A)).maxOutputBytes, 600, JSON.stringify(c));
        assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 600, JSON.stringify(c));
      }
    });

    it('an override under the ceiling is the session\'s; a ceiling under it bounds it, conversation off or not', () => {
      settings.set(A, 'maxOutputBytes', 500);
      under(trusted({maxOutputBytes: 600, conversation: false}));
      assert.strictEqual(callLimits.of(callOf(A)).maxOutputBytes, 500);
      under(trusted({maxOutputBytes: 300, conversation: false}));
      assert.strictEqual(callLimits.of(callOf(A)).maxOutputBytes, 300);
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 300);
    });

    it('a ceiling above the default, none, or one that cannot be trusted or is not known, changes nothing: the default', () => {
      for (const c of [trusted({maxOutputBytes: 5000, requestTimeout: 90000}), {state: 'none'}, {state: 'untrusted', problem: 'x'}, undefined, null]) {
        under(c);
        assert.deepStrictEqual(callLimits.of(callOf(A)), {maxOutputBytes: 1000, requestTimeout: 60000}, JSON.stringify(c));
      }
    });

    it('the shared runtime reads the ceiling when it starts serving, so it is known at a session\'s first call', () => {
      const settingsTool = require('../../lib/settings-tool');
      settingsTool.resetForTests();
      try {
        const cached = () => settingsTool.cachedCeiling(() => { throw new Error('the cache only'); }, {cacheOnly: true});
        assert.strictEqual(cached(), undefined, 'not known before anything read it');
        // (lib/route-manager.js, where the session listener starts)
        settingsTool.primeCeiling(() => trusted({maxOutputBytes: 600}));
        assert.deepStrictEqual(cached(), trusted({maxOutputBytes: 600}));
        // the store's own default dependency is that cache: a first call is bounded
        settings.configure({defaultOf: (n) => defaults()[n], boundsOf: () => ({min: 1, max: 2 ** 31 - 1})});
        assert.strictEqual(callLimits.of(callOf(A)).maxOutputBytes, 600);
        // a ceiling that cannot be read leaves it unknown, and throws nothing
        settingsTool.resetForTests();
        assert.doesNotThrow(() => settingsTool.primeCeiling(() => { throw new Error('EIO'); }));
        assert.strictEqual(cached(), undefined);
      } finally {
        settingsTool.resetForTests();
      }
    });

    // A ceiling changed on disk is not known on a call's path until it is
    // read again (the cache answers "not known" once the file's stamp
    // differs). Until then calls stay held to the ceiling last seen: never
    // to the default alone, which a touch of the file would otherwise buy.
    it('between a change on disk and its re-read, calls stay held to the ceiling last seen', () => {
      let now = trusted({maxOutputBytes: 600});
      settings.configure({ceiling: () => now, defaultOf: (n) => defaults()[n], boundsOf: () => ({min: 1, max: 2 ** 31 - 1}), ceilingMemoMs: 0});
      assert.strictEqual(callLimits.of(callOf(A)).maxOutputBytes, 600);
      now = undefined;   // the file changed; not read again yet
      assert.strictEqual(callLimits.of(callOf(A)).maxOutputBytes, 600, 'the previous ceiling, not the default');
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 600);
      now = trusted({maxOutputBytes: 300});   // read again
      assert.strictEqual(callLimits.of(callOf(A)).maxOutputBytes, 300);
      now = {state: 'none'};   // removed, and read again: no ceiling
      assert.strictEqual(callLimits.of(callOf(A)).maxOutputBytes, 1000);
    });

    // The reviewer's ruling: the shared runtime re-checks the ceiling on a
    // timer, so one lowered while it runs bounds calls without anyone
    // calling the settings tool: every 10 s where the check is a stat
    // (POSIX; read again only when the file changed), every 5 minutes on
    // Windows, where reading it costs a PowerShell.
    it('the shared runtime re-checks the ceiling on a timer: a ceiling lowered while it runs comes to bound calls', () => {
      const settingsTool = require('../../lib/settings-tool');
      settingsTool.resetForTests();
      const ticks = [];
      const every = (fn, ms) => { ticks.push({fn, ms}); return {stop: true}; };
      let stopped = null;
      try {
        // the interval, by platform
        settingsTool.watchCeiling({read: () => ({state: 'none'}), every, clear: () => {}, platform: 'linux'});
        settingsTool.watchCeiling({read: () => ({state: 'none'}), every, clear: () => {}, platform: 'darwin'});
        settingsTool.watchCeiling({read: () => ({state: 'none'}), every, clear: () => {}, platform: 'win32'});
        assert.deepStrictEqual(ticks.map((x) => x.ms), [10000, 10000, 300000]);
        // a tick reads again once the cache is stale (here by the Windows
        // age rule, with a clock of the test's; on POSIX by the file's stamp)
        settingsTool.resetForTests();
        ticks.length = 0;
        let onDisk = trusted({maxOutputBytes: 600});
        let clock = 0;
        let reads = 0;
        const read = () => { reads += 1; if (onDisk == null) throw new Error('EIO'); return onDisk; };
        const stop = settingsTool.watchCeiling({read, every, clear: (h) => { stopped = h; }, platform: 'win32', now: () => clock});
        settingsTool.primeCeiling(read, {platform: 'win32', now: () => clock});
        settings.configure({defaultOf: (n) => defaults()[n], boundsOf: () => ({min: 1, max: 2 ** 31 - 1})});
        assert.strictEqual(callLimits.of(callOf(A)).maxOutputBytes, 600);
        // a tick with nothing changed reads nothing
        const before = reads;
        ticks[0].fn();
        assert.strictEqual(reads, before);
        // lowered on disk; the very next tick, one interval on, reads it (a
        // Windows read is current for a little less than the interval, so
        // no tick is ever skipped), and it bounds the next call
        onDisk = trusted({maxOutputBytes: 300});
        clock += ticks[0].ms;
        ticks[0].fn();
        assert.strictEqual(reads, before + 1);
        assert.strictEqual(callLimits.of(callOf(A)).maxOutputBytes, 300);
        // a read that fails leaves the last one in force, and the timer running
        clock += 5 * 60 * 1000 + 1;
        onDisk = null;
        assert.doesNotThrow(() => ticks[0].fn());
        assert.strictEqual(callLimits.of(callOf(A)).maxOutputBytes, 300, 'the last one read');
        stop();
        assert.deepStrictEqual(stopped, {stop: true});
      } finally {
        settingsTool.resetForTests();
      }
    });

    // The reviewer's review of #284: a ceiling rewritten in place, to the
    // same size, with its mtime put back (touch -r, an operator's cp -p) has
    // the inode, size, mtime, mode and owner it had. Its ctime moved.
    it('a ceiling rewritten in place with its size and mtime kept is still seen as changed (its ctime)', function() {
      if (process.platform === 'win32') return this.skip();
      const fsx = require('fs');
      const os = require('os');
      const path = require('path');
      const settingsTool = require('../../lib/settings-tool');
      const ceilingLib = require('../../lib/settings-ceiling');
      const was = ceilingLib.ceilingFile;
      const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'ch-ceiling-'));
      const file = path.join(dir, 'ceiling.json');
      fsx.writeFileSync(file, '{"version": 1, "maxOutputBytes": 600}');
      // an mtime in whole seconds, so it can be put back exactly
      const kept = Math.floor(Date.now() / 1000) - 60;
      fsx.utimesSync(file, kept, kept);
      ceilingLib.ceilingFile = () => file;
      settingsTool.resetForTests();
      try {
        let reads = 0;
        const read = () => { reads += 1; return {state: 'none'}; };
        settingsTool.cachedCeiling(read);
        settingsTool.cachedCeiling(read);
        assert.strictEqual(reads, 1, 'read once while nothing changes');
        const before = fsx.statSync(file);
        // wait for the clock's next tick, so the rewrite's ctime differs
        const until = Date.now() + 20;
        while (Date.now() < until) { /* spin */ }
        fsx.writeFileSync(file, '{"version": 1, "maxOutputBytes": 300}');
        fsx.utimesSync(file, kept, kept);
        const after = fsx.statSync(file);
        assert.deepStrictEqual([after.ino, after.size, after.mtimeMs], [before.ino, before.size, before.mtimeMs], 'the same but for its ctime');
        settingsTool.cachedCeiling(read);
        assert.strictEqual(reads, 2, 'read again');
      } finally {
        ceilingLib.ceilingFile = was;
        settingsTool.resetForTests();
        fsx.rmSync(dir, {recursive: true, force: true});
      }
    });

    it('the watch never keeps the process alive', () => {
      const settingsTool = require('../../lib/settings-tool');
      const stop = settingsTool.watchCeiling({read: () => ({state: 'none'})});
      try {
        assert.strictEqual(typeof(stop), 'function');
      } finally {
        stop();
        settingsTool.resetForTests();
      }
    });

    it('a job run of a session that has ended (its last values, bounded by the defaults) is held to the ceiling too', () => {
      under(trusted({maxOutputBytes: 600}));
      sources[A].emit('end');
      // as lib/job-sessions.js forRun hands an ended session's run: its session, and its last override so marked
      const run = {session: A, limits: {maxOutputBytes: 900, requestTimeout: 60000, bound: 'defaults'}};
      assert.deepStrictEqual(callLimits.of(run), {maxOutputBytes: 600, requestTimeout: 60000});
      // and one that had no override
      assert.deepStrictEqual(callLimits.of({session: A, limits: null}), {maxOutputBytes: 600, requestTimeout: 60000});
    });
  });
});

'use strict';
// B2 Task 4 (docs/superpowers/plans/2026-11-15-shared-runtime-b2-session-settings.md),
// server-free: in a shared runtime a session tightens the two caps in
// conversation, for itself. The change is the session's override: nothing
// is written to settings.json, the options every session shares stay as
// they were, and the history line names the session. A loosening stays the
// terminal's until Task 5. `get` shows a session its own values and its own
// history. The session's tightenings are kept by its shim as one snapshot,
// sent again when it reattaches, and a replayed one is applied only if it
// tightens. (The gateway's guard and two real sessions over the listener:
// test/session-runtime/01.)
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
const notices = require('../../lib/notices');
const sessions = require('../../lib/sessions');
const settings = require('../../lib/session-settings');
const jobSessions = require('../../lib/job-sessions');
const settingsTool = require('../../lib/settings-tool');
const Session = require('../../lib/session');

const MiB = 1024 * 1024;

describe('sessions 09: tightenings in conversation (shared runtime B2, Task 4)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const C = 'c'.repeat(32);
  let reg;
  let sources;
  let frames;   // id -> what its shim was sent: ['forget'] or ['record', entry]
  let home;
  let file;
  let tool;
  let saved;
  const openSession = (id) => {
    const s = new EventEmitter();
    s.id = id;
    s.client = {status: 'ok', conditions: 'no', repo: null};
    s.notify = () => {};
    // C1's session: a record or a forget is dropped while it's detached
    s.connected = true;
    frames[id] = [];
    s.record = (entry) => { if (s.connected) frames[id].push(['record', entry]); };
    s.forget = () => { if (s.connected) frames[id].push(['forget']); };
    sources[id] = s;
    reg.emit('session', s);
    return s;
  };
  const ctx = (id) => ({shared: true, session: id, clientInfo: null, capabilities: null});
  const history = () => (fs.existsSync(path.join(home, 'history.jsonl'))
    ? fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const refused = async (p, code) => {
    let err = null;
    try { await p; } catch (e) { err = e; }
    assert.ok(err != null, `refused ${code}`);
    assert.strictEqual(err.code, code, err.message);
    return err;
  };
  const reset = () => { sessions.resetForTests(); settings.resetForTests(); jobSessions.resetForTests(); notices.resetForTests(); settingsTool.resetForTests(); };
  beforeEach(() => {
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout, locale: options.locale};
    // the defaults every session shares, whatever the options' own are
    Object.assign(options, {maxOutputBytes: 8 * MiB, requestTimeout: 30000, locale: 'en-US'});
    reset();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s09-'));
    file = path.join(home, 'settings.json');
    tool = settingsTool.create({file, lockWaitMs: 200});
    reg = new EventEmitter();
    sessions.attach(reg);
    sources = {};
    frames = {};
    openSession(A);
    openSession(B);
  });
  afterEach(() => { Object.assign(options, saved); reset(); fs.rmSync(home, {recursive: true, force: true}); });

  it('A tightens maxOutputBytes: A\'s value only; settings.json, the options and the live options are as they were', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {upgradeCheck: 'weekly'}}));
    const before = {bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs, live: settingsTool.liveOptions()};
    assert.deepStrictEqual(await tool.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A)),
      {name: 'maxOutputBytes', old: 8 * MiB, new: 2 * MiB, applies: 'this session'});
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 2 * MiB);
    assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 8 * MiB);
    assert.strictEqual(settings.limitsOf(B), null, 'B has no override');
    assert.deepStrictEqual(fs.readFileSync(file), before.bytes, 'settings.json byte-identical');
    assert.strictEqual(fs.statSync(file).mtimeMs, before.mtimeMs, 'and not rewritten');
    assert.strictEqual(options.maxOutputBytes, 8 * MiB, 'the shared option');
    assert.deepStrictEqual(settingsTool.liveOptions(), before.live);
    const h = history();
    assert.strictEqual(h.length, 1);
    assert.deepStrictEqual((({at, ...rest}) => rest)(h[0]), {by: 'settings tool', setting: 'maxOutputBytes', old: 8 * MiB, new: 2 * MiB, change: 'this session', session: A});
    assert.ok(!Number.isNaN(Date.parse(h[0].at)));
  });

  it('the same value again changes nothing and records nothing', async () => {
    await tool.set('requestTimeout', '20s', 'settings tool', ctx(A));
    const lines = history().length;
    const sent = frames[A].length;
    assert.deepStrictEqual(await tool.set('requestTimeout', '20s', 'settings tool', ctx(A)), {name: 'requestTimeout', old: 20000, new: 20000, applies: 'this session'});
    assert.strictEqual(history().length, lines);
    assert.strictEqual(frames[A].length, sent, 'nor sent to the shim again');
  });

  it('a tightened timeout re-arms the session\'s calls under way; a tightened output cap needs none (it is read at the reply)', async () => {
    const was = Session.rearmSession;
    const rearmed = [];
    Session.rearmSession = (id) => rearmed.push(id);
    try {
      await tool.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A));
      assert.deepStrictEqual(rearmed, []);
      await tool.set('requestTimeout', '20s', 'settings tool', ctx(A));
      assert.deepStrictEqual(rearmed, [A]);
    } finally {
      Session.rearmSession = was;
    }
  });

  it('a loosening stays the terminal\'s (until Task 5), judged against the session\'s own value; nothing changes', async () => {
    await tool.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A));
    // back toward the default is a loosening of A's value
    const e = await refused(tool.set('maxOutputBytes', '4MiB', 'settings tool', ctx(A)), 'SETTING_TERMINAL_ONLY_SHARED');
    assert.match(e.message, /ch-local settings set maxOutputBytes 4MiB/);
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 2 * MiB);
    // B has no override: above the default is one
    await refused(tool.set('requestTimeout', '60s', 'settings tool', ctx(B)), 'SETTING_TERMINAL_ONLY_SHARED');
    assert.strictEqual(settings.limitsOf(B), null);
    assert.ok(!fs.existsSync(file), 'settings.json never written');
    assert.strictEqual(options.maxOutputBytes, 8 * MiB);
    assert.strictEqual(options.requestTimeout, 30000);
  });

  it('a session that has ended changes nothing and records nothing; a change the store refuses is said in the history as not made', async () => {
    // ended (or never opened): answered as its calls are, nothing recorded
    await refused(tool.set('maxOutputBytes', '2MiB', 'settings tool', ctx(C)), 'MODULE_NOT_LISTED');
    sources[B].emit('end');
    await refused(tool.set('maxOutputBytes', '2MiB', 'settings tool', ctx(B)), 'MODULE_NOT_LISTED');
    assert.deepStrictEqual(history(), []);
    // the store's own bound (64 overrides a session): the line already
    // written is followed by one saying the change was not made
    for (let i = 0; i < settings.MAX_OVERRIDES; i++) settings.set(A, `pack.p${i}`, false, {version: '1.0.0'});
    await refused(tool.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A)), 'SETTING_OUT_OF_BOUNDS');
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 8 * MiB);
    assert.deepStrictEqual(history().map((h) => [h.setting, h.change, h.session]), [['maxOutputBytes', 'this session', A], ['maxOutputBytes', 'not made', A]]);
    assert.deepStrictEqual((await tool.get(ctx(A))).history.map((h) => h.change), ['this session', 'not made']);
  });

  it('every other setting stays the terminal\'s for a session: nothing is written (finding 2)', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {'pack.ci': true}}));
    const before = fs.readFileSync(file);
    for (const [name, value] of [['moduleSandbox', 'audit'], ['moduleSandbox', 'enforce'], ['autoUpgrade', 'on'], ['upgradeCheck', 'weekly'], ['locale', 'zh'],
      ['pack.ci', 'off'], ['pack.ci', 'on']]) {
      const e = await refused(tool.set(name, value, 'settings tool', ctx(A)), 'SETTING_TERMINAL_ONLY_SHARED');
      assert.match(e.message, /ch-local settings set/, `${name} ${value}`);
    }
    await refused(tool.set('nonsense', '1', 'settings tool', ctx(A)), 'SETTING_UNKNOWN');
    await refused(tool.set('maxOutputBytes', '1KiB', 'settings tool', ctx(A)), 'SETTING_OUT_OF_BOUNDS');
    assert.deepStrictEqual(fs.readFileSync(file), before, 'settings.json byte-identical');
    assert.strictEqual(settings.limitsOf(A), null);
  });

  it('get shows a session its own values, and only the history that has no session or is its own (finding 8, F8)', async () => {
    // a terminal change: no session
    fs.appendFileSync(path.join(home, 'history.jsonl'), `${JSON.stringify({at: new Date().toISOString(), by: 'cli', setting: 'upgradeCheck', old: 'daily', new: 'weekly'})}\n`);
    await tool.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A));
    await refused(tool.set('maxOutputBytes', '64MiB', 'settings tool', ctx(A)), 'SETTING_TERMINAL_ONLY_SHARED');
    await refused(tool.set('maxOutputBytes', '65MiB', 'settings tool', ctx(A)), 'SETTING_TERMINAL_ONLY_SHARED');
    await tool.set('requestTimeout', '20s', 'settings tool', ctx(B));
    const value = (got, name) => got.settings.find((s) => s.name === name).value;
    const seen = (got) => got.history.map((h) => [h.setting, h.change || null, h.new !== undefined ? h.new : (h.asked !== undefined ? h.asked : null)]);

    const a = await tool.get(ctx(A));
    assert.strictEqual(value(a, 'maxOutputBytes'), 2 * MiB, 'A\'s own');
    assert.strictEqual(value(a, 'requestTimeout'), 30000, 'B\'s tightening is not A\'s');
    // A's second request was counted, and the count written (as A's) ahead of the next change recorded: B's
    assert.deepStrictEqual(seen(a), [['upgradeCheck', null, 'weekly'], ['maxOutputBytes', 'this session', 2 * MiB], ['maxOutputBytes', 'refused, terminal only', 64 * MiB],
      ['maxOutputBytes', 'refused, terminal only, asked again', null]]);
    assert.ok(history().some((h) => h.session === A && h.count === 1 && h.change === 'refused, terminal only, asked again'), JSON.stringify(history()));
    const b = await tool.get(ctx(B));
    assert.strictEqual(value(b, 'maxOutputBytes'), 8 * MiB);
    assert.strictEqual(value(b, 'requestTimeout'), 20000);
    assert.deepStrictEqual(seen(b), [['upgradeCheck', null, 'weekly'], ['requestTimeout', 'this session', 20000]]);
    // no session's id is shown, its own included
    for (const got of [a, b]) assert.ok(got.history.every((h) => h.session === undefined), JSON.stringify(got.history));
    // with no session (--stdio, or the terminal's reader): no session's lines
    assert.deepStrictEqual(seen(await tool.get()), [['upgradeCheck', null, 'weekly']]);
  });

  it('a session\'s record with its shim is one snapshot of all its tightenings, replaced at each change', async () => {
    await tool.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A));
    assert.deepStrictEqual(frames[A], [['forget'], ['record', {maxOutputBytes: 2 * MiB}]]);
    await tool.set('requestTimeout', '20s', 'settings tool', ctx(A));
    assert.deepStrictEqual(frames[A].slice(2), [['forget'], ['record', {maxOutputBytes: 2 * MiB, requestTimeout: 20000}]]);
    assert.deepStrictEqual(frames[B], [], 'B\'s shim hears nothing of A');
    // a terminal tightening under A's value ends that override: the snapshot follows
    frames[A].length = 0;
    settings.dropLooser('maxOutputBytes', 1 * MiB);
    assert.deepStrictEqual(frames[A], [['forget'], ['record', {requestTimeout: 20000}]]);
    frames[A].length = 0;
    settings.dropLooser('requestTimeout', 10000);
    assert.deepStrictEqual(frames[A], [['forget']], 'none left: the shim keeps none');
  });

  it('a tightening made while the session is detached reaches the shim when it attaches again (F10)', async () => {
    sources[A].connected = false;
    await tool.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A));
    assert.deepStrictEqual(frames[A], [], 'dropped while detached');
    sources[A].connected = true;
    sources[A].emit('attach');
    assert.deepStrictEqual(frames[A], [['forget'], ['record', {maxOutputBytes: 2 * MiB}]]);
    // a session with no tightening sends nothing on attach
    sources[B].emit('attach');
    assert.deepStrictEqual(frames[B], []);
  });

  describe('a replay (a new session, from a restarted daemon\'s shim)', () => {
    it('applies a tightening, and records it as the session\'s snapshot', () => {
      const s = openSession(C);
      s.emit('replay', [{maxOutputBytes: 2 * MiB, requestTimeout: 20000}]);
      assert.deepStrictEqual(settings.limitsOf(C), {maxOutputBytes: 2 * MiB, requestTimeout: 20000});
      assert.deepStrictEqual(frames[C].slice(-2), [['forget'], ['record', {maxOutputBytes: 2 * MiB, requestTimeout: 20000}]]);
      assert.strictEqual(settings.limitsOf(A), null);
    });

    it('ignores what does not tighten, and what set would refuse (review focus 4)', () => {
      const s = openSession(C);
      s.emit('replay', [
        {maxOutputBytes: String(2 * MiB)},        // a string
        {maxOutputBytes: 16 * MiB},               // looser than the default
        {requestTimeout: 1},                      // out of bounds
        {maxOutputBytes: 2 * MiB + 0.5},          // not a whole number
        {nonsense: 1}, {locale: 'zh'}, {'pack.ci': false}, {moduleSandbox: 'audit'},
        null, 'maxOutputBytes', 7, [{maxOutputBytes: 2 * MiB}]
      ]);
      assert.strictEqual(settings.limitsOf(C), null, 'nothing applied');
      assert.deepStrictEqual(frames[C], [], 'and nothing recorded');
    });

    it('takes an entry\'s good names and leaves its bad ones; a later entry only tightens further', () => {
      const s = openSession(C);
      s.emit('replay', [{requestTimeout: 20000, locale: 'zh', maxOutputBytes: 64 * MiB}, {requestTimeout: 25000}, {requestTimeout: 10000}]);
      assert.deepStrictEqual(settings.limitsOf(C), {maxOutputBytes: 8 * MiB, requestTimeout: 10000});
    });

    it('is held to the ceiling as well as the default', () => {
      settings.configure({ceiling: () => ({state: 'trusted', ceiling: {maxOutputBytes: 4 * MiB}})});
      const s = openSession(C);
      s.emit('replay', [{maxOutputBytes: 6 * MiB}]);
      assert.strictEqual(settings.limitsOf(C), null, 'under the default, above the ceiling: no tightening');
      s.emit('replay', [{maxOutputBytes: 3 * MiB}]);
      assert.deepStrictEqual(settings.limitsOf(C), {maxOutputBytes: 3 * MiB, requestTimeout: 30000});
    });

    it('is no more than 64 entries\' work, and a hostile one throws nothing', () => {
      const s = openSession(C);
      const hostile = Object.create(null);
      Object.defineProperty(hostile, 'maxOutputBytes', {enumerable: true, get() { throw new Error('a getter'); }});
      assert.doesNotThrow(() => s.emit('replay', [hostile, {maxOutputBytes: 2 * MiB}]));
      assert.strictEqual(settings.effective(C, 'maxOutputBytes'), 2 * MiB);
      assert.doesNotThrow(() => s.emit('replay', 'not a list'));
    });
  });
});

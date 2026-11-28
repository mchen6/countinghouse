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
// the module manager the tool reads what is loaded from (#449's high
// review, round 6, 8): none loaded here
const NO_MODULES = {modules: {}};
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
    // C1's session: connected is true from a connection's WELCOME, before it
    // has settled; a record or a forget sent with none attached is dropped
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
  const reset = () => { sessions.resetForTests(); settings.resetForTests(); jobSessions.resetForTests(); notices.resetForTests(); settingsTool.resetForTests(); require('../../lib/settings-confirm').resetForTests(); };
  beforeEach(() => {
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
    // the defaults every session shares, whatever the options' own are
    Object.assign(options, {maxOutputBytes: 8 * MiB, requestTimeout: 30000});
    reset();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s09-'));
    file = path.join(home, 'settings.json');
    // (a list with no tested client, as production's is now)
    tool = settingsTool.create({mm: NO_MODULES, file, lockWaitMs: 200, allowlist: require('../../lib/elicitation-clients').listFrom({clients: [{name: 'claude-code', conditions: 'claude-code', tested: []}]})});
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

  // these sessions' clients say "conditions: no" (openSession), so Task 5's
  // latch has locked them: a loosening is never asked of their users (the
  // form and its answer are sessions 10's)
  it('in a session whose client could answer for the user: its own lowering undone; a loosening above the value for all sessions is not asked, and changes nothing', async () => {
    await tool.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A));
    // back toward the default: its own lowering undone, though its client
    // latched it (the undo shows no form: sessions 10)
    assert.strictEqual((await tool.set('maxOutputBytes', '4MiB', 'settings tool', ctx(A))).new, 4 * MiB);
    // above it: a loosening, not asked
    await refused(tool.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A)), 'SETTING_NEEDS_CONFIRMATION');
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 4 * MiB);
    // B has no override: above the default is one
    await refused(tool.set('requestTimeout', '60s', 'settings tool', ctx(B)), 'SETTING_NEEDS_CONFIRMATION');
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
    // the store refusing a session's change (a stand-in: no input the tool
    // passes reaches its refusal now): the line already written is followed
    // by one saying the change was not made
    const realSet = settings.set;
    settings.set = () => { throw Object.assign(new Error('the store refused it'), {code: 'SETTING_OUT_OF_BOUNDS'}); };
    try {
      await refused(tool.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A)), 'SETTING_OUT_OF_BOUNDS');
    } finally { settings.set = realSet; }
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 8 * MiB);
    // (both of the session's own lines carry no scope: ch-local's outside-edit check reads a not made with a session and
    // without the every-session scope as that session's own change failing, which undoes nothing stored; validation 30
    // pins the every-session one, sessions 10 the way back's)
    assert.deepStrictEqual(history().map((h) => [h.setting, h.change, h.session, h.scope]), [['maxOutputBytes', 'this session', A, undefined], ['maxOutputBytes', 'not made', A, undefined]]);
    assert.deepStrictEqual((await tool.get(ctx(A))).history.map((h) => h.change), ['this session', 'not made']);
  });

  it('every other setting stays the terminal\'s for a session: nothing is written (finding 2)', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {'pack.ci': true}}));
    const before = fs.readFileSync(file);
    // (a stored pack.* is no setting since M5b; a module's on/off is every session's: sessions 37)
    for (const [name, value] of [['moduleSandbox', 'audit'], ['moduleSandbox', 'enforce'], ['autoUpgrade', 'on'], ['upgradeCheck', 'weekly']]) {
      const e = await refused(tool.set(name, value, 'settings tool', ctx(A)), 'SETTING_TERMINAL_ONLY_SHARED');
      assert.strictEqual(e.message, `This shared runtime takes this change to ${name} from a terminal only; nothing was changed. To change ${name} for all sessions, run \`ch-local settings set ${name} ${value}\` in a terminal yourself.`);
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
    await refused(tool.set('maxOutputBytes', '64MiB', 'settings tool', ctx(A)), 'SETTING_NEEDS_CONFIRMATION');
    await refused(tool.set('maxOutputBytes', '65MiB', 'settings tool', ctx(A)), 'SETTING_NEEDS_CONFIRMATION');
    await tool.set('requestTimeout', '20s', 'settings tool', ctx(B));
    const value = (got, name) => got.settings.find((s) => s.name === name).value;
    const seen = (got) => got.history.map((h) => [h.setting, h.change || null, h.new !== undefined ? h.new : (h.asked !== undefined ? h.asked : null)]);

    const a = await tool.get(ctx(A));
    assert.strictEqual(value(a, 'maxOutputBytes'), 2 * MiB, 'A\'s own');
    assert.strictEqual(value(a, 'requestTimeout'), 30000, 'B\'s tightening is not A\'s');
    // A's second request was counted, and the count written (as A's) ahead of the next change recorded: B's
    assert.deepStrictEqual(seen(a), [['upgradeCheck', null, 'weekly'], ['maxOutputBytes', 'this session', 2 * MiB], ['maxOutputBytes', 'not confirmed (locked in this session)', 64 * MiB],
      ['maxOutputBytes', 'not confirmed (locked in this session), asked again', null]]);
    assert.ok(history().some((h) => h.session === A && h.count === 1 && h.change === 'not confirmed (locked in this session), asked again'), JSON.stringify(history()));
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
    // a terminal tightening under A's values ends neither: a session's own
    // tightening is kept (held to the default while that is lower: #296's
    // review), so its shim's record stands
    frames[A].length = 0;
    settings.dropLooser('maxOutputBytes', 1 * MiB);
    settings.dropLooser('requestTimeout', 10000);
    assert.deepStrictEqual(frames[A], []);
    // a value of its own taken back (as a change it confirmed for all sessions does): the snapshot follows
    settings.clear(A, 'maxOutputBytes');
    assert.deepStrictEqual(frames[A], [['forget'], ['record', {requestTimeout: 20000}]]);
    frames[A].length = 0;
    settings.clear(A, 'requestTimeout');
    assert.deepStrictEqual(frames[A], [['forget']], 'none left: the shim keeps none');
  });

  it('a tightening made while the session is detached reaches the shim when it attaches again (F10)', async () => {
    sources[A].connected = false;
    sources[A].emit('detach');
    await tool.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A));
    assert.deepStrictEqual(frames[A], [], 'nothing is sent while detached');
    // a resumed connection is welcomed (connected) before it has settled,
    // and C1 drops what is sent in between: nothing is taken as sent until
    // the session's 'attach'
    sources[A].connected = true;
    await tool.set('requestTimeout', '20s', 'settings tool', ctx(A));
    assert.deepStrictEqual(frames[A], [], 'nor between the welcome and the settle');
    sources[A].emit('attach');
    assert.deepStrictEqual(frames[A], [['forget'], ['record', {maxOutputBytes: 2 * MiB, requestTimeout: 20000}]]);
    // a session with no tightening sends nothing on attach
    sources[B].emit('detach');
    sources[B].emit('attach');
    assert.deepStrictEqual(frames[B], []);
    // an override ended while detached: the shim is told to forget at the attach
    sources[A].emit('detach');
    settings.clear(A, 'maxOutputBytes');
    settings.clear(A, 'requestTimeout');
    frames[A].length = 0;
    sources[A].emit('attach');
    assert.deepStrictEqual(frames[A], [['forget']]);
  });

  // (the final pass's gateway part, A5: a tightening is never refused, the
  // budget included; past it the session's tightenings are one line and a
  // count, so the shared tail stays bounded)
  it('a session writes at most 32 changes to the history every session reads; past that a tightening still applies, as one line and a count', async () => {
    // one history, read by its 64 KiB tail: a session stepping a cap down
    // call after call must not push the others' lines out of it
    for (let i = 0; i < 32; i++) await tool.set('maxOutputBytes', String(8 * MiB - 1 - i), 'settings tool', ctx(A));
    const at = settings.effective(A, 'maxOutputBytes');
    for (let i = 1; i <= 5; i++) assert.strictEqual((await tool.set('maxOutputBytes', String(at - i), 'settings tool', ctx(A))).new, at - i);
    assert.strictEqual((await tool.set('requestTimeout', '20s', 'settings tool', ctx(A))).new, 20000);
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), at - 5, 'tightened');
    assert.strictEqual(settings.effective(A, 'requestTimeout'), 20000, 'tightened');
    assert.strictEqual(history().filter((h) => h.session === A && h.change === 'this session').length, 32);
    // one line for each kind past the budget; the rest counted at the end
    const past = history().filter((h) => h.session === A && /past this session's 32/.test(String(h.change)));
    assert.strictEqual(past.length, 2, JSON.stringify(past));
    // a loosening past it (above the value for all sessions: up to it, a
    // session's own lowering is undone in conversation) stays the terminal's
    await refused(tool.set('maxOutputBytes', String(8 * MiB + 1), 'settings tool', ctx(A)), 'SETTING_TERMINAL_ONLY_SHARED');
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), at - 5, 'unchanged');
    // another session has its own
    assert.deepStrictEqual(await tool.set('requestTimeout', '20s', 'settings tool', ctx(B)), {name: 'requestTimeout', old: 30000, new: 20000, applies: 'this session'});
  });

  it('a session\'s end writes the counts of its repeated requests and keeps nothing of it', async () => {
    await refused(tool.set('maxOutputBytes', '64MiB', 'settings tool', ctx(A)), 'SETTING_NEEDS_CONFIRMATION');
    await refused(tool.set('maxOutputBytes', '65MiB', 'settings tool', ctx(A)), 'SETTING_NEEDS_CONFIRMATION');
    assert.strictEqual(history().length, 1, 'the second only counted');
    sources[A].emit('end');
    assert.deepStrictEqual(history().map((h) => [h.session, h.change, h.count]),
      [[A, 'not confirmed (locked in this session)', undefined], [A, 'not confirmed (locked in this session), asked again', 1]]);
    // nothing of A is left to write
    tool.writeCounts();
    assert.strictEqual(history().length, 2);
  });

  it('the ceiling is read afresh before a session\'s set is judged, as a terminal-less set reads it', async () => {
    let reads = 0;
    const t2 = settingsTool.create({mm: NO_MODULES, file, lockWaitMs: 200, ceiling: (o) => { if (o == null || o.cacheOnly !== true) reads += 1; return {state: 'none'}; }});
    await t2.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A));
    assert.ok(reads >= 1, 'a real read, not the cache only');
  });

  it('attaching again (or another registry) hears each change once', async () => {
    sessions.attach(reg);
    const other = new EventEmitter();
    sessions.attach(other);
    await tool.set('maxOutputBytes', '2MiB', 'settings tool', ctx(A));
    assert.deepStrictEqual(frames[A], [['forget'], ['record', {maxOutputBytes: 2 * MiB}]]);
  });

  describe('a replay (a new session, from a restarted daemon\'s shim)', () => {
    it('applies a tightening, and records it as the session\'s snapshot', () => {
      const s = openSession(C);
      const was = Session.rearmSession;
      const rearmed = [];
      Session.rearmSession = (id) => rearmed.push(id);
      try {
        s.emit('replay', [{maxOutputBytes: 2 * MiB}, {requestTimeout: 20000}, {requestTimeout: 15000}]);
      } finally {
        Session.rearmSession = was;
      }
      assert.deepStrictEqual(settings.limitsOf(C), {maxOutputBytes: 2 * MiB, requestTimeout: 15000});
      // one snapshot for the whole replay, not one per entry
      assert.deepStrictEqual(frames[C], [['forget'], ['record', {maxOutputBytes: 2 * MiB, requestTimeout: 15000}]]);
      // a replay may come mid-life (a resumed connection's): its calls under way are re-armed, once
      assert.deepStrictEqual(rearmed, [C]);
      assert.strictEqual(settings.limitsOf(A), null);
    });

    it('is recorded in the history, one line a setting, marked as a replay and as its session\'s; the client is sent no notice', async () => {
      const was = {settingsFile: options.settingsFile, add: notices.add};
      const noticed = [];
      options.settingsFile = file;
      notices.add = (...args) => { noticed.push(args); };
      try {
        const s = openSession(C);
        s.emit('replay', [{maxOutputBytes: 2 * MiB}, {requestTimeout: 20000}, {requestTimeout: 15000}]);
        assert.deepStrictEqual(history().map(({at, ...rest}) => rest), [
          {by: 'replay', setting: 'maxOutputBytes', old: 8 * MiB, new: 2 * MiB, change: 'this session (replayed after a restart)', session: C},
          {by: 'replay', setting: 'requestTimeout', old: 30000, new: 15000, change: 'this session (replayed after a restart)', session: C}]);
        assert.ok(history().every((h) => !Number.isNaN(Date.parse(h.at))));
        // the session sees why its values hold; no other session does
        assert.deepStrictEqual((await tool.get(ctx(C))).history.map((h) => [h.by, h.setting, h.new]), [['replay', 'maxOutputBytes', 2 * MiB], ['replay', 'requestTimeout', 15000]]);
        assert.deepStrictEqual((await tool.get(ctx(A))).history, []);
        assert.deepStrictEqual(noticed, [], 'it asked for them itself');
        // its lines count toward what a session may write (the 32): 2 here, 30
        // more, then a tightening still applies, as one past-budget line (A5)
        for (let i = 0; i < 30; i++) await tool.set('maxOutputBytes', String(2 * MiB - 1 - i), 'settings tool', ctx(C));
        const before = history().length;
        assert.strictEqual((await tool.set('maxOutputBytes', String(MiB), 'settings tool', ctx(C))).new, MiB);
        assert.deepStrictEqual(history().slice(before).map((h) => [h.session, h.setting, /past this session's 32/.test(String(h.change))]), [[C, 'maxOutputBytes', true]]);
        // a replay that applies nothing records nothing
        const lines = history().length;
        openSession('d'.repeat(32)).emit('replay', [{maxOutputBytes: 64 * MiB}, {locale: 'zh'}]);
        assert.strictEqual(history().length, lines);
      } finally {
        options.settingsFile = was.settingsFile;
        notices.add = was.add;
      }
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
      // the shim holds what it replayed: with nothing of it applied it is
      // told to forget, or it would replay it at every later restart
      assert.deepStrictEqual(frames[C], [['forget']]);
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

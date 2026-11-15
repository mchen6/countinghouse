// countinghouse_settings (packs in place, part 2, plan Task A5), server-free:
// the allowlist and its bounds, never loosening a guard, and ch-local's
// settings protocol (ch-local docs/development/settings.md): the file, the
// settings.lock, and the history appended first.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
const settingsTool = require('../../lib/settings-tool');

const MiB = 1024 * 1024;

// On Windows the sandbox setting offers only audit, until enforce holds
// there (#195, lib/sandbox-platform.js).
const WIN = process.platform === 'win32';
const SANDBOX = WIN ? 'audit' : 'enforce';

describe('stdio 14: countinghouse_settings', () => {
  let home;
  let file;
  let tool;
  let saved;
  const history = () => fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf8')).values;
  const refused = async (p, code) => {
    let err = null;
    try { await p; } catch (e) { err = e; }
    assert.ok(err != null, `refused ${code}`);
    assert.strictEqual(err.code, code, err.message);
    return err;
  };

  before(() => { saved = {locale: options.locale, requestTimeout: options.requestTimeout, maxOutputBytes: options.maxOutputBytes}; });
  after(() => Object.assign(options, saved));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-settings-'));
    file = path.join(home, 'settings.json');
    tool = settingsTool.create({file, lockWaitMs: 200});
    options.locale = 'en-US';
  });

  it('get, with no file: every setting at its default, with its bounds, whether it guards, and when it applies', async () => {
    const got = await tool.get();
    const byName = Object.fromEntries(got.settings.map((s) => [s.name, s]));
    assert.deepStrictEqual(byName.maxOutputBytes, {name: 'maxOutputBytes', value: 8 * MiB, default: 8 * MiB, bounds: {min: MiB, max: 256 * MiB}, guarding: true, applies: 'now'});
    assert.deepStrictEqual(byName.requestTimeout, {name: 'requestTimeout', value: 30000, default: 30000, bounds: {min: 5000, max: 120000}, guarding: true, applies: 'now'});
    assert.deepStrictEqual(byName.moduleSandbox.bounds, {enum: WIN ? ['audit'] : ['enforce', 'audit']});
    assert.strictEqual(byName.moduleSandbox.default, SANDBOX);
    assert.strictEqual(byName.moduleSandbox.applies, 'next start');
    assert.strictEqual(byName.locale.guarding, false);
    assert.deepStrictEqual(got.history, []);
  });

  it('every allowlisted setting is set within its bounds, stored as ch-local stores it, the history line first', async () => {
    assert.deepStrictEqual(await tool.set('maxOutputBytes', '4MiB'), {name: 'maxOutputBytes', old: 8 * MiB, new: 4 * MiB, applies: 'now'});
    assert.deepStrictEqual(await tool.set('requestTimeout', '20s'), {name: 'requestTimeout', old: 30000, new: 20000, applies: 'now'});
    await tool.set('locale', 'zh');
    await tool.set('locale', 'en');
    // the current value again: a no-op, neither written nor recorded
    await tool.set('moduleSandbox', SANDBOX);
    await tool.set('autoUpgrade', 'off');
    await tool.set('upgradeCheck', 'weekly');
    assert.deepStrictEqual(await tool.set('pack.ci-failure-triage', 'off'), {name: 'pack.ci-failure-triage', old: 'on', new: 'off', applies: 'now'});
    assert.deepStrictEqual(stored(), {maxOutputBytes: 4 * MiB, requestTimeout: 20000, locale: 'en', upgradeCheck: 'weekly', 'pack.ci-failure-triage': false});
    const h = history();
    assert.strictEqual(h.length, 6);
    assert.deepStrictEqual((({by, setting, old, new: n}) => ({by, setting, old, new: n}))(h[0]), {by: 'settings tool', setting: 'maxOutputBytes', old: 8 * MiB, new: 4 * MiB});
    assert.ok(h.every((e) => e.loosened === undefined));
    assert.strictEqual((await tool.get()).history.length, 6);
  });

  it('a value out of bounds: SETTING_OUT_OF_BOUNDS, with the bounds, in en and zh; nothing changed', async () => {
    const en = await refused(tool.set('maxOutputBytes', '1KiB'), 'SETTING_OUT_OF_BOUNDS');
    assert.match(en.message, /The value 1KiB for maxOutputBytes is outside the allowed range \(1048576 to 268435456\); nothing was changed/);
    options.locale = 'zh-CN';
    const zh = await refused(tool.set('requestTimeout', 'soon'), 'SETTING_OUT_OF_BOUNDS');
    assert.match(zh.message, /requestTimeout 的值 soon 超出了允许的范围（5000 to 120000），未作修改。/);
    await refused(tool.set('locale', 'fr'), 'SETTING_OUT_OF_BOUNDS');
    assert.ok(!fs.existsSync(file));
  });

  it('an unknown name: SETTING_UNKNOWN', async () => {
    const err = await refused(tool.set('apiKey', 'x'), 'SETTING_UNKNOWN');
    assert.match(err.message, /There is no setting named apiKey/);
    await refused(tool.set('pack.../x', 'off'), 'SETTING_UNKNOWN');
  });

  // Part 3, section 1: what conversation may ask for, and what it may not
  it('a raised cap or timeout, or a pack turned on: SETTING_NEEDS_CONFIRMATION, naming the command; the file is unchanged', async () => {
    await tool.set('maxOutputBytes', '2MiB');
    await tool.set('requestTimeout', '10s');
    await tool.set('pack.ci-failure-triage', 'off');
    const before = fs.readFileSync(file, 'utf8');
    for (const [name, value, command] of [['maxOutputBytes', '4MiB', 'maxOutputBytes 4MiB'], ['requestTimeout', '15000', 'requestTimeout 15s'], ['pack.ci-failure-triage', 'on', 'pack.ci-failure-triage on']]) {
      const err = await refused(tool.set(name, value), 'SETTING_NEEDS_CONFIRMATION');
      assert.match(err.message, new RegExp(`needs your own confirmation; nothing was changed\\. To allow this, run \`ch-local settings set ${command.replace(/\./g, '\\.')}\` in a terminal yourself`));
    }
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    // each asked for and not confirmed: in the history (asked, never old/new), unchanged
    const asked = history().filter((h) => h.change === 'not confirmed').map((h) => h.setting);
    assert.deepStrictEqual(asked, ['maxOutputBytes', 'requestTimeout', 'pack.ci-failure-triage']);
  });

  it('the sandbox and automatic upgrades are loosened from a terminal only: SETTING_LOOSENS_A_GUARD, naming the command', async () => {
    const loosenings = [['autoUpgrade', 'on']].concat(WIN ? [] : [['moduleSandbox', 'audit']]);
    for (const [name, value] of loosenings) {
      const err = await refused(tool.set(name, value), 'SETTING_LOOSENS_A_GUARD');
      assert.match(err.message, new RegExp(`Changing ${name} to ${value} would loosen a guarding setting, which can only be done from a terminal.*run \`ch-local settings set ${name} ${value}\``));
    }
    assert.ok(!fs.existsSync(file));
    // recorded (spec section 5: the strongest sign of an injected prompt), as asked, never as a change
    assert.deepStrictEqual(history().map((h) => [h.setting, h.change, h.old, h.new]), loosenings.map(([name]) => [name, 'refused, terminal only', undefined, undefined]));
    // asked again: one entry per kind, the count written before the next change
    for (let i = 0; i < 3; i++) await refused(tool.set('autoUpgrade', 'on'), 'SETTING_LOOSENS_A_GUARD');
    await tool.set('locale', 'zh');
    assert.deepStrictEqual(history().filter((h) => h.setting === 'autoUpgrade').map((h) => [h.change, h.count]), [['refused, terminal only', undefined], ['refused, terminal only, asked again', 3]]);
    // off is never a value
    await refused(tool.set('moduleSandbox', 'off'), 'SETTING_OUT_OF_BOUNDS');
  });

  it('a value equal to the current one changes nothing and records nothing', async () => {
    await tool.set('requestTimeout', '20s');
    const before = history().length;
    for (let i = 0; i < 5; i++) assert.deepStrictEqual(await tool.set('requestTimeout', '20s'), {name: 'requestTimeout', old: 20000, new: 20000, applies: 'now'});
    await tool.set('locale', 'en');
    assert.strictEqual(history().length, before);
  });

  it('requests not confirmed: one entry per kind this start (any value, any pack), a fresh tool per call as the gateway makes, the count written before the next change', async () => {
    const fresh = () => require('../../lib/settings-tool').create({file});
    for (const p of ['a', 'b', 'made-up']) await fresh().set(`pack.${p}`, 'off');
    const before = history().length;
    const asked = () => history().slice(before);
    for (const v of ['64MiB', '65MiB', '66MiB', '64MiB']) await refused(fresh().set('maxOutputBytes', v), 'SETTING_NEEDS_CONFIRMATION');
    for (const p of ['a', 'b', 'made-up']) await refused(fresh().set(`pack.${p}`, 'on'), 'SETTING_NEEDS_CONFIRMATION');
    assert.deepStrictEqual(asked().map((h) => [h.setting, h.change, h.asked]), [['maxOutputBytes', 'not confirmed', 64 * MiB], ['pack.a', 'not confirmed', true]]);
    assert.ok(asked().every((h) => h.old === undefined && h.new === undefined), 'a request is never written as a change made');
    await fresh().set('locale', 'zh');
    assert.deepStrictEqual(asked().map((h) => [h.setting, h.change, h.count]), [
      ['maxOutputBytes', 'not confirmed', undefined], ['pack.a', 'not confirmed', undefined],
      ['maxOutputBytes', 'not confirmed, asked again', 3], ['pack', 'not confirmed, asked again', 2], ['locale', undefined, undefined]]);
  });

  // Part 3, section 4: the operator's ceiling binds conversation too
  describe('the operator\'s ceiling', () => {
    const withCeiling = (c) => require('../../lib/settings-tool').create({file, ceiling: () => c});
    const trusted = (ceiling) => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: Object.assign({forbid: [], conversation: true}, ceiling)});

    it('a ceiling that cannot be trusted refuses every loosening, naming the file and why; tightening still works', async () => {
      const t = withCeiling({state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: 'the file is not owned by root'});
      // (moduleSandbox audit is no loosening on Windows until #197 lands, where audit is the only value)
      for (const [name, value] of [['maxOutputBytes', '64MiB'], ['autoUpgrade', 'on']].concat(process.platform === 'win32' ? [] : [['moduleSandbox', 'audit']])) {
        const err = await refused(t.set(name, value), 'SETTING_CEILING_UNTRUSTED');
        assert.match(err.message, /ceiling file \/etc\/countinghouse\/ceiling\.json cannot be trusted \(the file is not owned by root\)/);
      }
      assert.deepStrictEqual(await t.set('requestTimeout', '10s'), {name: 'requestTimeout', old: 30000, new: 10000, applies: 'now'});
    });

    it('a loosening it forbids, or a value above it: SETTING_ABOVE_CEILING; get shows the lowered bound', async () => {
      // packs: the operator's allowlist; ci-failure-triage is not on it
      const t = withCeiling(trusted({maxOutputBytes: 16 * MiB, forbid: ['autoUpgrade'], packs: ['other']}));
      await t.set('maxOutputBytes', '4MiB');
      assert.match((await refused(t.set('maxOutputBytes', '32MiB'), 'SETTING_ABOVE_CEILING')).message, /maxOutputBytes 32MiB is above the ceiling this machine's operator set \(at most 16MiB\)/);
      await refused(t.set('maxOutputBytes', '8MiB'), 'SETTING_NEEDS_CONFIRMATION');
      await t.set('pack.ci-failure-triage', 'off');
      assert.match((await refused(t.set('pack.ci-failure-triage', 'on'), 'SETTING_FORBIDDEN_BY_CEILING')).message, /pack\.ci-failure-triage cannot be changed to on on this machine: its operator's ceiling forbids it/);
      await refused(t.set('autoUpgrade', 'on'), 'SETTING_FORBIDDEN_BY_CEILING');
      // a pack on the allowlist may be turned on as before (asked for: not confirmed in conversation)
      await t.set('pack.other', 'off');
      await refused(t.set('pack.other', 'on'), 'SETTING_NEEDS_CONFIRMATION');
      const got = await t.get();
      assert.strictEqual(got.settings.find((x) => x.name === 'maxOutputBytes').bounds.max, 16 * MiB);
      // grouped per kind and outcome: the 8MiB request is not filed under the ceiling's refusal
      assert.deepStrictEqual(history().filter((h) => h.setting === 'maxOutputBytes' && h.asked != null).map((h) => [h.asked, h.change]),
        [[32 * MiB, 'refused by the ceiling'], [8 * MiB, 'not confirmed']]);
      // a ceiling below a setting's least value: get's bounds stay sane
      const low = withCeiling(trusted({maxOutputBytes: 1000}));
      assert.deepStrictEqual((await low.get()).settings.find((x) => x.name === 'maxOutputBytes').bounds, {min: MiB, max: MiB});
    });

    it('the control set from ch-local: a value above the ceiling is refused there too', () => {
      settingsTool.resetForTests();
      settingsTool.ceilingForControl(() => trusted({maxOutputBytes: 4 * MiB}));
      try {
        assert.deepStrictEqual(settingsTool.applyControlSet({name: 'maxOutputBytes', value: 6 * MiB}), {ok: false, code: 'SETTING_ABOVE_CEILING'});
        settingsTool.ceilingForControl(() => ({state: 'untrusted', file: 'x', problem: 'y'}));
        assert.deepStrictEqual(settingsTool.applyControlSet({name: 'requestTimeout', value: 100}), {ok: false, code: 'SETTING_ABOVE_CEILING'});
      } finally {
        settingsTool.ceilingForControl(() => ({state: 'none'}));
        settingsTool.resetForTests();
      }
    });
  });

  it('a change the history cannot record is not made: SETTING_NOT_RECORDED', async () => {
    fs.mkdirSync(path.join(home, 'history.jsonl'));
    await refused(tool.set('locale', 'zh'), 'SETTING_NOT_RECORDED');
    assert.ok(!fs.existsSync(file));
  });

  it('the settings lock: a fresh one, even empty, makes it wait then refuse SETTINGS_BUSY; a stale one is cleared', async () => {
    const lock = path.join(home, 'settings.lock');
    fs.writeFileSync(lock, '');
    await refused(tool.set('locale', 'zh'), 'SETTINGS_BUSY');
    assert.ok(fs.existsSync(lock));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);
    await tool.set('locale', 'zh');
    assert.ok(!fs.existsSync(lock), 'released');
  });

  it('a settings file not valid is never changed: SETTINGS_FILE_INVALID; a name it does not know is ignored', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 1}}));
    const err = await refused(tool.set('locale', 'zh'), 'SETTINGS_FILE_INVALID');
    assert.match(err.message, /maxOutputBytes = 1, which is not allowed.*ch-local settings reset/);
    await refused(tool.get(), 'SETTINGS_FILE_INVALID');
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {fromTheFuture: 1, locale: 'zh'}}));
    await tool.set('maxOutputBytes', '1MiB');
    assert.deepStrictEqual(stored(), {fromTheFuture: 1, locale: 'zh', maxOutputBytes: MiB}, 'kept for the reader that knows it');
  });

  it('control set applies in the runtime\'s unit: requestTimeout in seconds; a call already running keeps its timer', () => {
    const Timer = require('../../lib/timer');
    options.requestTimeout = 30000;
    options.maxOutputBytes = 8 * MiB;
    settingsTool.resetForTests();
    const running = new Timer();
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'requestTimeout', value: 20}), {ok: true});
    assert.strictEqual(options.requestTimeout, 20000);
    assert.strictEqual(running.timeout._idleTimeout, 30000, 'the running call\'s timer is unchanged');
    clearTimeout(running.timeout);
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'maxOutputBytes', value: 4 * MiB}), {ok: true});
    assert.strictEqual(options.maxOutputBytes, 4 * MiB);
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'locale', value: 'zh-CN'}), {ok: true});
    assert.strictEqual(options.locale, 'zh-CN');
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'locale', value: 'zh'}), {ok: false, code: 'SETTING_OUT_OF_BOUNDS'}, 'the runtime\'s unit: en-US or zh-CN');
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'moduleSandbox', value: 'audit'}), {ok: false, code: 'CONTROL_NOT_LIVE'});
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'pack.ci-failure-triage', value: false}), {ok: false, code: 'CONTROL_NOT_LIVE'}, 'a pack is turned off by unload');
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'nope', value: 1}), {ok: false, code: 'CONTROL_UNKNOWN_SETTING'});
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'requestTimeout', value: 9999}), {ok: false, code: 'SETTING_OUT_OF_BOUNDS'});
  });

  it('control set: a value above the one the workers started with applies at the next start; back to it applies now', () => {
    options.requestTimeout = 30000;
    options.maxOutputBytes = 8 * MiB;
    settingsTool.resetForTests();
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'maxOutputBytes', value: 2 * MiB}), {ok: true});
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'maxOutputBytes', value: 16 * MiB}), {ok: false, code: 'CONTROL_APPLIES_AT_START'}, 'the validators\' heap is sized at start');
    assert.strictEqual(options.maxOutputBytes, 2 * MiB, 'unchanged');
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'maxOutputBytes', value: 8 * MiB}), {ok: true});
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'requestTimeout', value: 60}), {ok: false, code: 'CONTROL_APPLIES_AT_START'});
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'requestTimeout', value: 30}), {ok: true});
  });

  it('an earlier {autoUpgrade} that is not a boolean makes the file unusable: never dropped by the next write', async () => {
    fs.writeFileSync(file, JSON.stringify({autoUpgrade: 'yes'}));
    await refused(tool.set('locale', 'zh'), 'SETTINGS_FILE_INVALID');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {autoUpgrade: 'yes'});
    fs.writeFileSync(file, JSON.stringify({autoUpgrade: true}));
    await tool.set('locale', 'zh');
    assert.deepStrictEqual(stored(), {autoUpgrade: true, locale: 'zh'});
  });

  it('a home it cannot write to: SETTINGS_FILE_INVALID naming what failed; the history shows no change', async function() {
    if (process.platform === 'win32' || process.getuid() === 0) this.skip();
    fs.writeFileSync(path.join(home, 'history.jsonl'), '');
    fs.chmodSync(home, 0o555);
    try {
      const err = await refused(tool.set('locale', 'zh'), 'SETTINGS_FILE_INVALID');
      assert.match(err.message, /its lock cannot be created \(EACCES\)/);
    } finally {
      fs.chmodSync(home, 0o755);
    }
    assert.strictEqual(fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8'), '');
    assert.ok(!fs.readdirSync(home).some((n) => n.endsWith('.tmp')));
  });

  it('get reads only the history\'s tail, the last 50, and never shows ch-local\'s host or pid', async () => {
    const lines = [];
    for (let n = 0; n < 2000; n++) lines.push(JSON.stringify({at: `t${n}`, host: 'box', pid: 7, by: 'cli', setting: 'locale', old: 'en', new: 'zh', pad: 'x'.repeat(40)}));
    fs.writeFileSync(path.join(home, 'history.jsonl'), `${lines.join('\n')}\n`);
    assert.ok(fs.statSync(path.join(home, 'history.jsonl')).size > 64 * 1024, 'premise: larger than the tail read');
    const {history: h} = await tool.get();
    assert.strictEqual(h.length, 50);
    assert.strictEqual(h[49].at, 't1999');
    assert.strictEqual(h[0].at, 't1950');
    assert.deepStrictEqual(Object.keys(h[0]).sort(), ['at', 'by', 'new', 'old', 'setting']);
  });

  it('every set is said on stderr too', async () => {
    const LOG = require('../../lib/logger');
    const said = [];
    const was = LOG.I;
    LOG.I = (line) => said.push(line);
    try { await tool.set('locale', 'zh'); } finally { LOG.I = was; }
    assert.deepStrictEqual(said, ['countinghouse_settings: locale changed from "en" to "zh" by settings tool']);
  });

  it('a live set reaches every running module worker, only its fields; a worker takes only those, each of its own type', () => {
    options.requestTimeout = 30000;
    options.maxOutputBytes = 8 * MiB;
    options.locale = 'en-US';
    settingsTool.resetForTests();
    settingsTool.applyControlSet({name: 'requestTimeout', value: 20});
    const sent = [];
    settingsTool.broadcastLiveOptions({a: {sendMessageToWorker: (m) => sent.push(m)}, b: {sendMessageToWorker: (m) => sent.push(m)}, gone: null});
    assert.deepStrictEqual(sent, [0, 1].map(() => ({command: 'live-options', options: {maxOutputBytes: 8 * MiB, requestTimeout: 20000, locale: 'en-US'}})));
    // a worker started after the tighten holds 20 s; a loosening back to 30 s reaches it
    const worker = {requestTimeout: 20000, maxOutputBytes: 8 * MiB, locale: 'en-US', moduleSandbox: 'enforce'};
    settingsTool.applyControlSet({name: 'requestTimeout', value: 30});
    settingsTool.applyLiveOptions(worker, settingsTool.liveOptions());
    assert.strictEqual(worker.requestTimeout, 30000);
    settingsTool.applyLiveOptions(worker, {moduleSandbox: 'audit', requestTimeout: 'soon', locale: 'fr', maxOutputBytes: -1});
    assert.deepStrictEqual(worker, {requestTimeout: 30000, maxOutputBytes: 8 * MiB, locale: 'en-US', moduleSandbox: 'enforce'});
  });

  it('a live set reaches a worker in the same unit as the main thread\'s, from a worker started with setResolvedOptions (#112 with #183)', () => {
    // the main thread from the CLI (seconds), a worker's options from it
    options.setOptions({requestTimeout: 30, maxOutputBytes: 8 * MiB});
    const worker = options.getOptionsForWorker();
    assert.strictEqual(worker.requestTimeout, options.requestTimeout, 'started in the same unit');
    settingsTool.resetForTests();
    // ch-local sends seconds (its runtimeValue); the main thread holds ms
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'requestTimeout', value: 20}), {ok: true});
    settingsTool.applyLiveOptions(worker, settingsTool.liveOptions());
    assert.deepStrictEqual([options.requestTimeout, worker.requestTimeout], [20000, 20000]);
  });

  it('listed only in the single-identity profile with --settingsFile; never addressable by ctx.call', () => {
    const toolRegistry = require('../../lib/mcp/tool-registry');
    const callAddress = require('../../lib/call-address');
    const was = {singleIdentity: options.singleIdentity, settingsFile: options.settingsFile};
    try {
      options.singleIdentity = true;
      options.settingsFile = file;
      assert.ok(toolRegistry.platformTools().some((t) => t.name === 'countinghouse_settings'));
      options.settingsFile = null;
      assert.ok(!toolRegistry.platformTools().some((t) => t.name === 'countinghouse_settings'));
      options.singleIdentity = false;
      options.settingsFile = file;
      assert.ok(!toolRegistry.platformTools().some((t) => t.name === 'countinghouse_settings'), 'never over HTTP or multi-tenant');
    } finally {
      Object.assign(options, was);
    }
    assert.ok(require('../../lib/mcp/tool-name').RESERVED_TOOL_NAMES.includes('countinghouse_settings'));
    assert.strictEqual(callAddress.parseAddress('countinghouse_settings'), null, 'a built-in is no device/service/action address');
  });
});

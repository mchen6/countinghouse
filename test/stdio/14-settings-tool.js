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

  before(() => { saved = {locale: options.locale, requestTimeout: options.requestTimeout, requestTimeoutMs: options.requestTimeoutMs, maxOutputBytes: options.maxOutputBytes}; });
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
    assert.deepStrictEqual(byName.moduleSandbox.bounds, {enum: ['enforce', 'audit']});
    assert.strictEqual(byName.moduleSandbox.applies, 'next start');
    assert.strictEqual(byName.locale.guarding, false);
    assert.deepStrictEqual(got.history, []);
  });

  it('every allowlisted setting is set within its bounds, stored as ch-local stores it, the history line first', async () => {
    assert.deepStrictEqual(await tool.set('maxOutputBytes', '4MiB'), {name: 'maxOutputBytes', old: 8 * MiB, new: 4 * MiB, applies: 'now'});
    assert.deepStrictEqual(await tool.set('requestTimeout', '20s'), {name: 'requestTimeout', old: 30000, new: 20000, applies: 'now'});
    await tool.set('locale', 'zh');
    await tool.set('locale', 'en');
    await tool.set('moduleSandbox', 'enforce');
    await tool.set('autoUpgrade', 'off');
    await tool.set('upgradeCheck', 'weekly');
    assert.deepStrictEqual(await tool.set('pack.ci-failure-triage', 'off'), {name: 'pack.ci-failure-triage', old: 'on', new: 'off', applies: 'now'});
    assert.deepStrictEqual(stored(), {maxOutputBytes: 4 * MiB, requestTimeout: 20000, locale: 'en', moduleSandbox: 'enforce', autoUpgrade: false, upgradeCheck: 'weekly', 'pack.ci-failure-triage': false});
    const h = history();
    assert.strictEqual(h.length, 8);
    assert.deepStrictEqual((({by, setting, old, new: n}) => ({by, setting, old, new: n}))(h[0]), {by: 'settings tool', setting: 'maxOutputBytes', old: 8 * MiB, new: 4 * MiB});
    assert.ok(h.every((e) => e.loosened === undefined));
    assert.strictEqual((await tool.get()).history.length, 8);
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

  it('every loosening, turning a pack on included: SETTING_LOOSENS_A_GUARD, and the file is unchanged', async () => {
    await tool.set('maxOutputBytes', '2MiB');
    await tool.set('requestTimeout', '10s');
    await tool.set('pack.ci-failure-triage', 'off');
    const before = fs.readFileSync(file, 'utf8');
    for (const [name, value] of [['maxOutputBytes', '4MiB'], ['requestTimeout', '15s'], ['moduleSandbox', 'audit'], ['autoUpgrade', 'on'], ['pack.ci-failure-triage', 'on']]) {
      const err = await refused(tool.set(name, value), 'SETTING_LOOSENS_A_GUARD');
      assert.match(err.message, new RegExp(`Changing ${name.replace(/\./g, '\\.')} to ${value} would loosen a guarding setting.*ch-local command`));
    }
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    assert.strictEqual(history().length, 3);
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
    const running = new Timer();
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'requestTimeout', value: 20}), {ok: true});
    assert.strictEqual(options.requestTimeout, 20000);
    assert.strictEqual(options.requestTimeoutMs, 20000);
    assert.strictEqual(running.timeout._idleTimeout, 30000, 'the running call\'s timer is unchanged');
    clearTimeout(running.timeout);
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'maxOutputBytes', value: 4 * MiB}), {ok: true});
    assert.strictEqual(options.maxOutputBytes, 4 * MiB);
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'locale', value: 'zh-CN'}), {ok: true});
    assert.strictEqual(options.locale, 'zh-CN');
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'locale', value: 'zh'}), {ok: false, code: 'SETTING_OUT_OF_BOUNDS'}, 'the runtime\'s unit: en-US or zh-CN');
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'moduleSandbox', value: 'audit'}), {ok: false, code: 'SETTING_APPLIES_AT_START'});
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'requestTimeout', value: 9999}), {ok: false, code: 'SETTING_OUT_OF_BOUNDS'});
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

// countinghouse_settings (packs in place, part 2, plan Task A5), server-free:
// the allowlist and its bounds, never loosening a guard, and ch-local's
// settings protocol (ch-local docs/development/settings.md): the file, the
// settings.lock, and the history appended first.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const options = require('../../lib/cli-options');
const settingsTool = require('../../lib/settings-tool');
// the module manager the tool reads what is loaded from (#449's high
// review, round 6, 8): none loaded here
const NO_MODULES = {modules: {}};

const MiB = 1024 * 1024;


// a top-level module's on/off (M5b)
const SC = '@countinghouse/ch-pack-ci-failure-triage';
const EN = `enabled.${SC}`;
const core = (a) => ({name: a.name, old: a.old, new: a.new, applies: a.applies});

// this file's temporary trees, under test/.tmp and removed
// (test/helpers/test-tmp.js forFile); nothing left in os.tmpdir()
const tmpDirs = require('../helpers/test-tmp').forFile(['ch-settings-']);

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
    home = tmpDirs.mkdtemp('ch-settings-');
    file = path.join(home, 'settings.json');
    // ch-local's record beside it: the installed top-level modules a
    // module's on/off names (M5b: enabled.<module>; no setting is a pack's)
    // (each the scenario of a pack of its own: ch-local's top-level rule)
    const tops = [SC, 'a', 'b', 'made-up', 'other'];
    fs.writeFileSync(path.join(home, 'modules.json'), JSON.stringify({modules: Object.fromEntries(tops.map((m) => [m, {version: '1.0.0', role: 'scenario'}])),
      packs: Object.fromEntries(tops.map((m, i) => [`p${i}`, {modules: {[m]: '1.0.0'}}]))}));
    tool = settingsTool.create({mm: NO_MODULES, file, lockWaitMs: 200});
    // the runtime on its defaults at each case's start, whatever the case
    // before (or a file run before this one, #285) left: a cap's value is
    // what the runtime runs with
    Object.assign(options, {locale: 'en-US', maxOutputBytes: 16 * MiB, requestTimeout: 30000});
  });

  it('get, with no file: every setting at its default, with its bounds, whether it guards, and when it applies', async () => {
    const got = await tool.get();
    const byName = Object.fromEntries(got.settings.map((s) => [s.name, s]));
    // 16 MiB: the approved default (maintainer's decision, 2026-11-15)
    assert.deepStrictEqual(byName.maxOutputBytes, {name: 'maxOutputBytes', value: 16 * MiB, default: 16 * MiB, bounds: {min: MiB, max: 256 * MiB}, guarding: true, applies: 'now'});
    assert.deepStrictEqual(byName.requestTimeout, {name: 'requestTimeout', value: 30000, default: 30000, bounds: {min: 5000, max: 120000}, guarding: true, applies: 'now'});
    assert.deepStrictEqual(byName.moduleSandbox.bounds, {enum: ['enforce', 'audit']});
    assert.strictEqual(byName.moduleSandbox.default, 'enforce');
    assert.strictEqual(byName.moduleSandbox.applies, 'next start');
    assert.strictEqual(byName.locale.guarding, false);
    assert.deepStrictEqual(got.history, []);
  });

  it('every allowlisted setting is set within its bounds, stored as ch-local stores it, the history line first', async () => {
    assert.deepStrictEqual(await tool.set('maxOutputBytes', '4MiB'), {name: 'maxOutputBytes', old: 16 * MiB, new: 4 * MiB, applies: 'now'});
    assert.deepStrictEqual(await tool.set('requestTimeout', '20s'), {name: 'requestTimeout', old: 30000, new: 20000, applies: 'now'});
    await tool.set('locale', 'zh');
    await tool.set('locale', 'en');
    // the current value again: a no-op, neither written nor recorded
    await tool.set('moduleSandbox', 'enforce');
    await tool.set('autoUpgrade', 'off');
    await tool.set('upgradeCheck', 'weekly');
    assert.deepStrictEqual(core(await tool.set(EN, 'off')), {name: EN, old: 'on', new: 'off', applies: 'now'});
    assert.deepStrictEqual(stored(), {maxOutputBytes: 4 * MiB, requestTimeout: 20000, locale: 'en', upgradeCheck: 'weekly', [EN]: false});
    const h = history();
    assert.strictEqual(h.length, 6);
    assert.deepStrictEqual((({by, setting, old, new: n}) => ({by, setting, old, new: n}))(h[0]), {by: 'settings tool', setting: 'maxOutputBytes', old: 16 * MiB, new: 4 * MiB});
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
  it('a raised cap or timeout, or a module turned on: SETTING_NEEDS_CONFIRMATION, naming the command; the file is unchanged', async () => {
    await tool.set('maxOutputBytes', '2MiB');
    await tool.set('requestTimeout', '10s');
    await tool.set(EN, 'off');
    const before = fs.readFileSync(file, 'utf8');
    for (const [name, value, command] of [['maxOutputBytes', '4MiB', 'maxOutputBytes 4MiB'], ['requestTimeout', '15000', 'requestTimeout 15s'], [EN, 'on', `${EN} on`]]) {
      const err = await refused(tool.set(name, value), 'SETTING_NEEDS_CONFIRMATION');
      assert.match(err.message, new RegExp(`needs your own confirmation; nothing was changed\\. To allow this, run \`ch-local settings set ${command.replace(/[./@]/g, '\\$&')}\` in a terminal yourself`));
    }
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    // each asked for and not confirmed: in the history (asked, never old/new), unchanged
    // (a client not on the tested-client list gets no form: part 3 P2, the reason recorded)
    const asked = history().filter((h) => h.change === 'not confirmed (not on the tested-client list)').map((h) => h.setting);
    assert.deepStrictEqual(asked, ['maxOutputBytes', 'requestTimeout', EN]);
  });

  // (the dry run, walk step 9) ch-local is on no PATH: with the home's
  // launcher in the held-back file, the command a refusal names is
  // `node "<launcher>" settings set ...`, as countinghouse_load_module's and
  // the overview's are; without one, the bare form as before
  it('with ch-local\'s launcher known, a refusal names the command through it', async () => {
    const heldBack = require('../../lib/held-back');
    const kept = {heldBackFile: options.heldBackFile, settingsFile: options.settingsFile};
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin', 'ch-local.js'), '// launcher');
    const launcher = fs.realpathSync.native(path.join(home, 'bin', 'ch-local.js'));
    const held = path.join(home, 'held-back.json');
    // (private as ch-local writes it: 0600, or on Windows this user's ACL
    // alone -- a file a test writes inherits its folder's, which the read
    // refuses; #536's Windows leg)
    require('../helpers/private-auth').writePrivate(held, JSON.stringify({v: 1, modules: [], launcher}));
    Object.assign(options, {heldBackFile: held, settingsFile: file});
    heldBack.resetForTests();
    try {
      // (no read awaited first: the tool waits for the list's first read
      // itself -- the medium on this fix, 1)
      // (and a settings file that cannot be used: its reset command, the same way)
      fs.writeFileSync(file, '{');
      const bad = await refused(tool.set('requestTimeout', '20s'), 'SETTINGS_FILE_INVALID');
      assert.ok(bad.message.includes(`reset it with \`node "${launcher}" settings reset\` in a terminal`), bad.message);
      // (a module's load keeps the file's problem alone: no command, no path
      // outside the module's root -- the medium on the follow-ups, 3)
      const state = require('../../lib/module-settings').stateFor('m', {name: 'm', version: '1.0.0', countinghouse: {settings: {r: {type: 'string'}}}}, {operator: false, net: []});
      assert.ok(state.refusedWhy != null && state.refusedWhy.includes('it is not JSON'), JSON.stringify(state.refusedWhy));
      assert.ok(!state.refusedWhy.includes(home) && !/settings reset/.test(state.refusedWhy), state.refusedWhy);
      fs.rmSync(file);
      for (const [name, value, command] of [['maxOutputBytes', '64MiB', 'maxOutputBytes 64MiB'], ['requestTimeout', '45s', 'requestTimeout 45s'], [EN, 'on', `${EN} on`]]) {
        if (name === EN) await tool.set(EN, 'off');
        const err = await refused(tool.set(name, value), 'SETTING_NEEDS_CONFIRMATION');
        assert.ok(err.message.includes(`run \`node "${launcher}" settings set ${command}\` in a terminal yourself`), err.message);
      }
      assert.strictEqual(heldBack.list().launcher, launcher, 'the launcher taken');
    } finally {
      Object.assign(options, kept);
      heldBack.resetForTests();
    }
  });

  it('the sandbox and automatic upgrades are loosened from a terminal only: SETTING_LOOSENS_A_GUARD, naming the command', async () => {
    const loosenings = [['autoUpgrade', 'on'], ['moduleSandbox', 'audit']];
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

  it('requests not confirmed: one entry per kind this start (any value, any module turned on), a fresh tool per call as the gateway makes, the count written before the next change', async () => {
    const fresh = () => require('../../lib/settings-tool').create({mm: NO_MODULES, file});
    for (const p of ['a', 'b', 'made-up']) await fresh().set(`enabled.${p}`, 'off');
    const before = history().length;
    const asked = () => history().slice(before);
    for (const v of ['64MiB', '65MiB', '66MiB', '64MiB']) await refused(fresh().set('maxOutputBytes', v), 'SETTING_NEEDS_CONFIRMATION');
    for (const p of ['a', 'b', 'made-up']) await refused(fresh().set(`enabled.${p}`, 'on'), 'SETTING_NEEDS_CONFIRMATION');
    assert.deepStrictEqual(asked().map((h) => [h.setting, h.change, h.asked]), [['maxOutputBytes', 'not confirmed (not on the tested-client list)', 64 * MiB], ['enabled.a', 'not confirmed (not on the tested-client list)', true]]);
    assert.ok(asked().every((h) => h.old === undefined && h.new === undefined), 'a request is never written as a change made');
    await fresh().set('locale', 'zh');
    assert.deepStrictEqual(asked().map((h) => [h.setting, h.change, h.count]), [
      ['maxOutputBytes', 'not confirmed (not on the tested-client list)', undefined], ['enabled.a', 'not confirmed (not on the tested-client list)', undefined],
      ['maxOutputBytes', 'not confirmed (not on the tested-client list), asked again', 3], ['enabled', 'not confirmed (not on the tested-client list), asked again', 2], ['locale', undefined, undefined]]);
  });

  // the runtime as it started: its options, recorded when it starts serving
  // (lib/route-manager.js captureAtStart)
  const startedAt = (values) => {
    settingsTool.resetForTests();
    Object.assign(options, values);
    settingsTool.captureAtStart();
  };
  afterEach(() => settingsTool.resetForTests());

  describe('what a cap is judged against, and when a change applies', () => {

    it('a stored value above what runs (a terminal raise awaiting the next start), tightened: written for the next start, and said so', async () => {
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 128 * MiB}}));
      options.maxOutputBytes = 16 * MiB;
      assert.deepStrictEqual(await tool.set('maxOutputBytes', '64MiB'), {name: 'maxOutputBytes', old: 128 * MiB, new: 64 * MiB, applies: 'next start'});
      assert.strictEqual(stored().maxOutputBytes, 64 * MiB);
      assert.strictEqual(options.maxOutputBytes, 16 * MiB, 'nothing changes now');
      // down to what runs, or under it: now
      assert.strictEqual((await tool.set('maxOutputBytes', '16MiB')).applies, 'now');
      assert.strictEqual((await tool.set('maxOutputBytes', '4MiB')).applies, 'now');
      assert.strictEqual(options.maxOutputBytes, 4 * MiB);
    });

    it('get shows what runs, and the stored value beside it when the two differ', async () => {
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 128 * MiB}}));
      options.maxOutputBytes = 16 * MiB;
      const cap = (await tool.get()).settings.find((s) => s.name === 'maxOutputBytes');
      assert.deepStrictEqual(cap, {name: 'maxOutputBytes', value: 16 * MiB, stored: 128 * MiB, default: 16 * MiB, bounds: {min: MiB, max: 256 * MiB}, guarding: true, applies: 'now'});
      // nothing stored and the runtime on the default: no stored beside it
      fs.rmSync(file);
      assert.strictEqual((await tool.get()).settings.find((s) => s.name === 'maxOutputBytes').stored, undefined);
    });

    it('nothing stored and a runtime started under the default (a flag given by hand): a value between them is a loosening of what it started with, not a tightening of the default', async () => {
      startedAt({maxOutputBytes: 8 * MiB});
      assert.strictEqual((await tool.get()).settings.find((s) => s.name === 'maxOutputBytes').value, 8 * MiB);
      await refused(tool.set('maxOutputBytes', '12MiB'), 'SETTING_NEEDS_CONFIRMATION');
      assert.ok(!fs.existsSync(file), 'not written');
      assert.strictEqual(options.maxOutputBytes, 8 * MiB);
    });

    it('started under the default, then raised this start: a value between is a this-start tightening, written nowhere (the start value is the baseline, not what runs)', async () => {
      startedAt({maxOutputBytes: 8 * MiB});
      options.maxOutputBytes = 12 * MiB;   // a raise confirmed for this start
      const t = settingsTool.create({mm: NO_MODULES, file, lockWaitMs: 200, ceiling: () => ({state: 'none'}), applyChange: async (staged) => { options[staged.name] = staged.next; }});
      assert.deepStrictEqual(await t.set('maxOutputBytes', '10MiB'), {name: 'maxOutputBytes', old: 12 * MiB, new: 10 * MiB, applies: 'this start'});
      assert.ok(!fs.existsSync(file), 'not written: 10 MiB is above what it started with');
      assert.strictEqual(options.maxOutputBytes, 10 * MiB);
    });

    // The reviewer's ruling on #287. A runtime started ABOVE the default by
    // a flag, with nothing stored: the start value is the baseline, so a
    // value under it needs no form; written, it would RAISE what the file
    // yields (the default) with no form. What is written without a form
    // never exceeds what the file yields now; a value between that and what
    // runs applies to this start only.
    describe('started above the default by a flag, nothing stored', () => {
      const applying = (o = {}) => settingsTool.create(Object.assign({mm: NO_MODULES, file, lockWaitMs: 200, ceiling: () => ({state: 'none'}),
        applyChange: async (staged) => { options[staged.name] = staged.next; }}, o));
      const lines = () => (fs.existsSync(path.join(home, 'history.jsonl')) ? history() : []);
      beforeEach(() => startedAt({maxOutputBytes: 32 * MiB}));

      it('a value between the default and what runs applies to this start only: not written, and no history line says it was stored', async () => {
        assert.deepStrictEqual(await applying().set('maxOutputBytes', '24MiB'), {name: 'maxOutputBytes', old: 32 * MiB, new: 24 * MiB, applies: 'this start'});
        assert.ok(!fs.existsSync(file), 'settings.json not written: 24 MiB is above what it yields (16 MiB)');
        assert.strictEqual(options.maxOutputBytes, 24 * MiB, 'applied now');
        assert.deepStrictEqual(lines().map(({at, ...rest}) => rest), [{by: 'settings tool', setting: 'maxOutputBytes', old: 32 * MiB, new: 24 * MiB, change: 'this start'}]);
      });

      it('the value it started with, asked for: nothing is stored (it would raise the file), nothing changes, nothing is recorded', async () => {
        assert.deepStrictEqual(await applying().set('maxOutputBytes', '32MiB'), {name: 'maxOutputBytes', old: 32 * MiB, new: 32 * MiB, applies: 'this start'});
        assert.ok(!fs.existsSync(file), 'settings.json not written');
        assert.deepStrictEqual(lines(), []);
        assert.strictEqual(options.maxOutputBytes, 32 * MiB);
      });

      it('the timeout, the same: between its default and what runs, this start only', async () => {
        startedAt({requestTimeout: 60000});
        assert.deepStrictEqual(await applying().set('requestTimeout', '45s'), {name: 'requestTimeout', old: 60000, new: 45000, applies: 'this start'});
        assert.ok(!fs.existsSync(file), 'settings.json not written: 45 s is above what it yields (30 s)');
        // then under its default: written, and said from what runs (45 s), not from the start value
        assert.deepStrictEqual(await applying().set('requestTimeout', '20s'), {name: 'requestTimeout', old: 45000, new: 20000, applies: 'now'});
        assert.strictEqual(stored().requestTimeout, 20000);
        assert.deepStrictEqual((({old, new: n, change}) => ({old, new: n, change}))(lines().pop()), {old: 45000, new: 20000, change: undefined});
      });

      it('a value at or under the default is a tightening of the file too: written, applied now', async () => {
        assert.deepStrictEqual(await applying().set('maxOutputBytes', '8MiB'), {name: 'maxOutputBytes', old: 32 * MiB, new: 8 * MiB, applies: 'now'});
        assert.strictEqual(stored().maxOutputBytes, 8 * MiB);
        assert.strictEqual(options.maxOutputBytes, 8 * MiB);
      });

      it('exactly the default is no more than the file yields: written, applied now', async () => {
        assert.deepStrictEqual(await applying().set('maxOutputBytes', '16MiB'), {name: 'maxOutputBytes', old: 32 * MiB, new: 16 * MiB, applies: 'now'});
        assert.strictEqual(stored().maxOutputBytes, 16 * MiB);
        assert.strictEqual(options.maxOutputBytes, 16 * MiB);
      });

      it('the timeout under a ceiling of 20 s: its default lowers nothing and is not stored; a value under the default is stored, though above the ceiling', async () => {
        startedAt({requestTimeout: 60000});
        const ceiling20 = () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {requestTimeout: 20000, forbid: [], conversation: true}});
        assert.deepStrictEqual(await applying({ceiling: ceiling20}).set('requestTimeout', '30s'), {name: 'requestTimeout', old: 60000, new: 30000, applies: 'this start'});
        assert.ok(!fs.existsSync(file), 'settings.json not written');
        assert.deepStrictEqual(await applying({ceiling: ceiling20}).set('requestTimeout', '25s'), {name: 'requestTimeout', old: 30000, new: 25000, applies: 'now'});
        assert.strictEqual(stored().requestTimeout, 25000);
      });

      it('lowered for this start, then asked back up under the start value: a raise of what runs, so it needs the user\'s confirmation; nothing is written', async () => {
        const t = applying();
        await t.set('maxOutputBytes', '24MiB');
        await refused(t.set('maxOutputBytes', '28MiB'), 'SETTING_NEEDS_CONFIRMATION');
        assert.ok(!fs.existsSync(file), 'settings.json not written');
        assert.strictEqual(options.maxOutputBytes, 24 * MiB);
        // down again: this start only, from what runs
        assert.deepStrictEqual(await t.set('maxOutputBytes', '20MiB'), {name: 'maxOutputBytes', old: 24 * MiB, new: 20 * MiB, applies: 'this start'});
      });

      describe('under a ceiling of 12 MiB', () => {
        const ceiling12 = () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 12 * MiB, forbid: [], conversation: true}});

        it('the start value asked for is not stored: it is above the ceiling and above what the file yields', async () => {
          assert.deepStrictEqual(await applying({ceiling: ceiling12}).set('maxOutputBytes', '32MiB'), {name: 'maxOutputBytes', old: 32 * MiB, new: 32 * MiB, applies: 'this start'});
          assert.ok(!fs.existsSync(file), 'settings.json not written');
          assert.deepStrictEqual(lines(), []);
        });

        it('a tightening of what runs, still above the ceiling, is never refused, and is never stored: this start only', async () => {
          assert.deepStrictEqual(await applying({ceiling: ceiling12}).set('maxOutputBytes', '24MiB'), {name: 'maxOutputBytes', old: 32 * MiB, new: 24 * MiB, applies: 'this start'});
          assert.ok(!fs.existsSync(file), 'settings.json not written');
          assert.strictEqual(options.maxOutputBytes, 24 * MiB);
        });

        // the reviewer's reading: what lowers what the file YIELDS tightens
        // every later start (which is clamped to the ceiling anyway)
        it('a value under the default lowers what the file yields: stored, though above the ceiling, and applied now', async () => {
          assert.deepStrictEqual(await applying({ceiling: ceiling12}).set('maxOutputBytes', '14MiB'), {name: 'maxOutputBytes', old: 32 * MiB, new: 14 * MiB, applies: 'now'});
          assert.strictEqual(stored().maxOutputBytes, 14 * MiB);
          assert.strictEqual(options.maxOutputBytes, 14 * MiB);
          assert.deepStrictEqual((({at, ...rest}) => rest)(lines().pop()), {by: 'settings tool', setting: 'maxOutputBytes', old: 32 * MiB, new: 14 * MiB}, 'recorded as a store');
        });

        it('the default itself lowers nothing the file yields: above the ceiling it is not stored, and applies to this start only', async () => {
          assert.deepStrictEqual(await applying({ceiling: ceiling12}).set('maxOutputBytes', '16MiB'), {name: 'maxOutputBytes', old: 32 * MiB, new: 16 * MiB, applies: 'this start'});
          assert.ok(!fs.existsSync(file), 'settings.json not written');
          assert.strictEqual(options.maxOutputBytes, 16 * MiB);
        });

        it('a value at or under the ceiling is stored, and applies now', async () => {
          assert.deepStrictEqual(await applying({ceiling: ceiling12}).set('maxOutputBytes', '12MiB'), {name: 'maxOutputBytes', old: 32 * MiB, new: 12 * MiB, applies: 'now'});
          assert.strictEqual(stored().maxOutputBytes, 12 * MiB);
        });

        it('lowered for this start, a raise of what runs is refused by the ceiling', async () => {
          const t = applying({ceiling: ceiling12});
          await t.set('maxOutputBytes', '24MiB');
          await refused(t.set('maxOutputBytes', '28MiB'), 'SETTING_ABOVE_CEILING');
          assert.ok(!fs.existsSync(file), 'settings.json not written');
          assert.strictEqual(options.maxOutputBytes, 24 * MiB);
        });
      });
    });

    // my /code-review of the fix: with nothing stored, a write ABOVE what
    // runs changes nothing running and lowers what the file yields, so it
    // is said from the file's yield, not from what runs (which would read
    // as a raise made with no confirmation)
    it('a write above what runs, nothing stored: said from what the file yields, for the next start', async () => {
      startedAt({maxOutputBytes: 16 * MiB});
      await tool.set('maxOutputBytes', '8MiB');
      fs.rmSync(file);   // by hand: nothing stored again, the runtime still at 8 MiB
      assert.deepStrictEqual(await tool.set('maxOutputBytes', '12MiB'), {name: 'maxOutputBytes', old: 16 * MiB, new: 12 * MiB, applies: 'next start'});
      assert.strictEqual(stored().maxOutputBytes, 12 * MiB);
      assert.strictEqual(options.maxOutputBytes, 8 * MiB, 'nothing changes now');
      assert.deepStrictEqual((({old, new: n}) => ({old, new: n}))(history().pop()), {old: 16 * MiB, new: 12 * MiB});
    });

    // and: the start value itself, asked for once the runtime runs under it,
    // is a raise of what runs like any value between (it was answered
    // "done, next start", past the ceiling)
    it('lowered under its start value (the default), then the default asked for: a raise of what runs, refused by a ceiling under it, else the user\'s to confirm', async () => {
      startedAt({maxOutputBytes: 16 * MiB});
      options.maxOutputBytes = 12 * MiB;   // as ch-local's control set brings it down to a ceiling lowered since
      const under = settingsTool.create({mm: NO_MODULES, file, lockWaitMs: 200, ceiling: () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 12 * MiB, forbid: [], conversation: true}})});
      await refused(under.set('maxOutputBytes', '16MiB'), 'SETTING_ABOVE_CEILING');
      await refused(tool.set('maxOutputBytes', '16MiB'), 'SETTING_NEEDS_CONFIRMATION');
      assert.ok(!fs.existsSync(file), 'settings.json not written');
      assert.strictEqual(options.maxOutputBytes, 12 * MiB);
      // the same with no start recorded: what runs is still what a raise is judged by
      settingsTool.resetForTests();
      options.maxOutputBytes = 12 * MiB;
      await refused(tool.set('maxOutputBytes', '16MiB'), 'SETTING_NEEDS_CONFIRMATION');
      assert.ok(!fs.existsSync(file), 'settings.json not written');
      // a stored value this runtime does not run yet (a terminal raise awaiting the next start) is still just that
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 64 * MiB}}));
      assert.deepStrictEqual(await tool.set('maxOutputBytes', '64MiB'), {name: 'maxOutputBytes', old: 64 * MiB, new: 64 * MiB, applies: 'next start'});
    });

    it('started under the default by a flag, above the ceiling: the value that runs, asked for, is stored (it lowers what the file yields)', async () => {
      startedAt({maxOutputBytes: 14 * MiB});
      const t = settingsTool.create({mm: NO_MODULES, file, lockWaitMs: 200, ceiling: () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 12 * MiB, forbid: [], conversation: true}})});
      assert.deepStrictEqual(await t.set('maxOutputBytes', '14MiB'), {name: 'maxOutputBytes', old: 14 * MiB, new: 14 * MiB, applies: 'now'});
      assert.strictEqual(stored().maxOutputBytes, 14 * MiB);
    });

    it('a module\'s on/off in get is the stored one: only the two caps are reported by what runs', async () => {
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {[EN]: false}}));
      const row = (await tool.get()).settings.find((s) => s.name === EN);
      assert.deepStrictEqual([row.value, row.stored], ['off', undefined]);
    });
  });

  // Part 3, section 4: the operator's ceiling binds conversation too
  describe('the operator\'s ceiling', () => {
    const withCeiling = (c) => require('../../lib/settings-tool').create({mm: NO_MODULES, file, ceiling: () => c});
    const trusted = (ceiling) => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: Object.assign({forbid: [], conversation: true}, ceiling)});

    it('a ceiling that cannot be trusted refuses every loosening, naming the file and why; tightening still works', async () => {
      const t = withCeiling({state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: 'the file is not owned by root'});
      for (const [name, value] of [['maxOutputBytes', '64MiB'], ['autoUpgrade', 'on'], ['moduleSandbox', 'audit']]) {
        const err = await refused(t.set(name, value), 'SETTING_CEILING_UNTRUSTED');
        assert.match(err.message, /ceiling file \/etc\/countinghouse\/ceiling\.json cannot be trusted \(the file is not owned by root\)/);
      }
      assert.deepStrictEqual(await t.set('requestTimeout', '10s'), {name: 'requestTimeout', old: 30000, new: 10000, applies: 'now'});
    });

    // The reviewer's finding after #283: with a ceiling under the default
    // and nothing stored, ch-local starts the runtime at the ceiling. The
    // tool went by the file's default (16 MiB): get said 16 MiB, and a set
    // of 14 MiB passed as a tightening of it, was written above the
    // ceiling, and was said to apply now though nothing changed.
    describe('a ceiling under the default, nothing stored, the runtime started at the ceiling', () => {
      let t;
      beforeEach(() => {
        startedAt({maxOutputBytes: 12 * MiB, requestTimeout: 20000});
        t = withCeiling(trusted({maxOutputBytes: 12 * MiB, requestTimeout: 20000}));
      });

      it('get reports what the runtime runs with, not the file\'s default', async () => {
        const byName = Object.fromEntries((await t.get()).settings.map((s) => [s.name, s]));
        assert.deepStrictEqual(byName.maxOutputBytes, {name: 'maxOutputBytes', value: 12 * MiB, default: 16 * MiB, bounds: {min: MiB, max: 12 * MiB}, guarding: true, applies: 'now'});
        assert.strictEqual(byName.requestTimeout.value, 20000);
      });

      it('a value above what runs is a loosening, refused by the ceiling; nothing is written', async () => {
        const e = await refused(t.set('maxOutputBytes', '14MiB'), 'SETTING_ABOVE_CEILING');
        assert.match(e.message, /maxOutputBytes 14MiB is above the ceiling this machine's operator set \(at most 12MiB\)/);
        await refused(t.set('requestTimeout', '25s'), 'SETTING_ABOVE_CEILING');
        assert.ok(!fs.existsSync(file), 'settings.json not written');
        assert.strictEqual(options.maxOutputBytes, 12 * MiB);
      });

      it('a value under what runs is a tightening of it: written, applied now, and said from the running value', async () => {
        assert.deepStrictEqual(await t.set('maxOutputBytes', '10MiB'), {name: 'maxOutputBytes', old: 12 * MiB, new: 10 * MiB, applies: 'now'});
        assert.strictEqual(stored().maxOutputBytes, 10 * MiB);
        assert.strictEqual(options.maxOutputBytes, 10 * MiB);
        assert.deepStrictEqual((({by, setting, old, new: n}) => ({by, setting, old, new: n}))(history().pop()), {by: 'settings tool', setting: 'maxOutputBytes', old: 12 * MiB, new: 10 * MiB});
      });

      it('the value that runs, asked for: it is stored (it holds when the ceiling is raised), and nothing changes now; again, a no-op', async () => {
        assert.deepStrictEqual(await t.set('maxOutputBytes', '12MiB'), {name: 'maxOutputBytes', old: 12 * MiB, new: 12 * MiB, applies: 'now'});
        assert.strictEqual(stored().maxOutputBytes, 12 * MiB, 'the user\'s choice, kept');
        const lines = history().length;
        assert.deepStrictEqual(await t.set('maxOutputBytes', '12MiB'), {name: 'maxOutputBytes', old: 12 * MiB, new: 12 * MiB, applies: 'now'});
        assert.strictEqual(history().length, lines, 'stored already: nothing recorded');
      });
    });

    it('a write above the ceiling AND above what runs is refused, also as a tightening of a stored value', async () => {
      // stored before the ceiling was lowered; ch-local started the runtime at the ceiling
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 64 * MiB}}));
      startedAt({maxOutputBytes: 12 * MiB});
      const t = withCeiling(trusted({maxOutputBytes: 12 * MiB}));
      await refused(t.set('maxOutputBytes', '32MiB'), 'SETTING_ABOVE_CEILING');
      assert.strictEqual(stored().maxOutputBytes, 64 * MiB, 'unchanged');
      // down to the ceiling: written, and nothing changes live
      assert.deepStrictEqual(await t.set('maxOutputBytes', '12MiB'), {name: 'maxOutputBytes', old: 64 * MiB, new: 12 * MiB, applies: 'now'});
      assert.strictEqual(stored().maxOutputBytes, 12 * MiB);
      // a ceiling that cannot be trusted refuses no tightening
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 64 * MiB}}));
      const untrusted = withCeiling({state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: 'x'});
      assert.strictEqual((await untrusted.set('maxOutputBytes', '32MiB')).new, 32 * MiB);
    });

    it('a tightening of what the runtime runs with is never refused by the ceiling, though it is still above it', async () => {
      // the ceiling was lowered under a runtime that runs above it (not yet clamped, or not ch-local's)
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 64 * MiB}}));
      startedAt({maxOutputBytes: 64 * MiB});
      const t = withCeiling(trusted({maxOutputBytes: 12 * MiB}));
      assert.deepStrictEqual(await t.set('maxOutputBytes', '32MiB'), {name: 'maxOutputBytes', old: 64 * MiB, new: 32 * MiB, applies: 'now'});
      assert.strictEqual(options.maxOutputBytes, 32 * MiB, 'lowered now');
      // a ceiling under a setting's least value: the least value can still be set
      const low = withCeiling(trusted({maxOutputBytes: 1000}));
      assert.strictEqual((await low.set('maxOutputBytes', '1MiB')).new, MiB);
      assert.strictEqual(options.maxOutputBytes, MiB);
    });

    it('a loosening it forbids, or a value above it: SETTING_ABOVE_CEILING; get shows the lowered bound', async () => {
      // modules: the operator's allowlist; ci-failure-triage is not on it
      const t = withCeiling(trusted({maxOutputBytes: 16 * MiB, forbid: ['autoUpgrade'], modules: ['other']}));
      await t.set('maxOutputBytes', '4MiB');
      assert.match((await refused(t.set('maxOutputBytes', '32MiB'), 'SETTING_ABOVE_CEILING')).message, /maxOutputBytes 32MiB is above the ceiling this machine's operator set \(at most 16MiB\)/);
      await refused(t.set('maxOutputBytes', '8MiB'), 'SETTING_NEEDS_CONFIRMATION');
      await t.set(EN, 'off');
      assert.match((await refused(t.set(EN, 'on'), 'SETTING_FORBIDDEN_BY_CEILING')).message, /enabled\.@countinghouse\/ch-pack-ci-failure-triage cannot be changed to on on this machine: its operator's ceiling forbids it/);
      await refused(t.set('autoUpgrade', 'on'), 'SETTING_FORBIDDEN_BY_CEILING');
      // a module on the allowlist may be turned on (asked for: not confirmed in conversation)
      await t.set('enabled.other', 'off');
      await refused(t.set('enabled.other', 'on'), 'SETTING_NEEDS_CONFIRMATION');
      const got = await t.get();
      assert.strictEqual(got.settings.find((x) => x.name === 'maxOutputBytes').bounds.max, 16 * MiB);
      // grouped per kind and outcome: the 8MiB request is not filed under the ceiling's refusal
      assert.deepStrictEqual(history().filter((h) => h.setting === 'maxOutputBytes' && h.asked != null).map((h) => [h.asked, h.change]),
        [[32 * MiB, 'refused by the ceiling'], [8 * MiB, 'not confirmed (not on the tested-client list)']]);
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
    assert.deepStrictEqual(settingsTool.applyControlSet({name: EN, value: false}), {ok: false, code: 'CONTROL_NOT_LIVE'}, 'a module is turned off by its enabled.<module> in the file');
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'pack.ci-failure-triage', value: false}), {ok: false, code: 'CONTROL_UNKNOWN_SETTING'}, 'no setting is a pack\'s (M5b)');
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
  tmpDirs.hooks();
});

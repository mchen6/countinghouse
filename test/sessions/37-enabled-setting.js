'use strict';
// M5b (#413 rev 3, sections 5.1 and 5.3): enabled.<module> in the settings
// tool, a top-level module's on/off for every session of the user. get lists
// one row per installed top-level module (modules.json; never a part); off
// is made on request, written under the lock (history first, naming the
// session), never counted against the budget, and answered to the asker
// only (every session is told by ch-local's unload of it); on
// needs the user's confirmation (a form of kind `enabled` for a tested
// client, else the terminal), written with the version confirmed, refused if
// the version changed meanwhile. A part's name is SETTING_UNKNOWN. The
// ceiling binds it by its modules list.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
const settingsTool = require('../../lib/settings-tool');
const confirm = require('../../lib/settings-confirm');

const SCENARIO = '@countinghouse/ch-pack-ci-failure-triage';
const PART = '@countinghouse/ch-access-github';
const TOOL = 'weather-tool';
const CALLER = 'trip-planner';
const CLIENT = {clientInfo: {name: 'claude-code', version: '2.1.323'}, capabilities: {elicitation: {}}, session: 'session-1'};
const ACCEPT = {approve: {action: 'accept', content: {approve: true}}};
const DECLINE = {approve: {action: 'decline'}};

describe('sessions 37: enabled.<module> in the settings tool (M5b)', () => {
  let dir;
  let file;
  let savedLocale;
  const history = () => { try { return fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf8')).values;
  // ch-local's record: by default each module that is no part is a pack of
  // its own (so its scenario: top-level), and a part is in no pack
  const ownPacks = (modules) => Object.fromEntries(Object.entries(modules).filter(([, m]) => m.role !== 'part').map(([pkg, m], i) => [`p${i}`, {modules: {[pkg]: m.version}}]));
  const record = (modules, packs = ownPacks(modules)) => fs.writeFileSync(path.join(dir, 'modules.json'), JSON.stringify({modules, packs}));
  const tool = (o = {}) => settingsTool.create(Object.assign({
    file,
    ceiling: () => ({state: 'none'}),
    mayElicit: async () => ({ok: true, client: {name: 'claude-code', version: '2.1.323'}}),
    // weather-tool loaded, and trip-planner, whose closure holds it
    loadedTops: () => [{name: TOOL, modules: [TOOL], tools: ['weather_tool_forecast_get']}, {name: CALLER, modules: [CALLER, TOOL], tools: ['plan_trip']}]
  }, o));
  const refused = async (p, code) => {
    try { await p; } catch (e) { assert.strictEqual(e.code, code, `${e.code}: ${e.message}`); return e; }
    assert.fail(`expected ${code}`);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s37-'));
    file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {'pack.ci-failure-triage': false}}));
    record({[SCENARIO]: {version: '0.5.0', role: 'scenario'}, [PART]: {version: '0.2.0', role: 'part'}, [TOOL]: {version: '1.2.0', role: null}, [CALLER]: {version: '2.0.0', role: 'scenario'}});
    savedLocale = options.locale;
    options.locale = 'en-US';
    confirm.resetForTests();
    settingsTool.resetForTests();
  });
  afterEach(() => {
    options.locale = savedLocale;
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('get: one row per installed top-level module, never a part; value, default, loaded, version and listed tools', async () => {
    const got = await tool().get();
    const rows = got.settings.filter((r) => r.name.startsWith('enabled.'));
    assert.deepStrictEqual(rows.map((r) => r.name), [`enabled.${SCENARIO}`, `enabled.${CALLER}`, `enabled.${TOOL}`]);
    const w = rows.find((r) => r.module === TOOL);
    assert.deepStrictEqual(w, {name: `enabled.${TOOL}`, module: TOOL, value: 'on', default: 'on', bounds: {enum: ['on', 'off']}, guarding: true, applies: 'now',
      loaded: true, version: '1.2.0', tools: ['weather_tool_forecast_get']});
    assert.strictEqual(rows.find((r) => r.module === SCENARIO).loaded, false);
    assert.ok(!got.settings.some((r) => r.name.startsWith('pack.')), 'no pack row');
  });

  // #449's high review, 1: ch-local's rule, one vector for both repos
  it('the top-level modules are ch-local\'s: each pack\'s scenario (the vectors\' topLevelModules)', () => {
    const V = require('../../docs/superpowers/specs/shared-runtime-wire/vectors.json').topLevelModules;
    assert.ok(V.cases.length >= 8);
    for (const c of V.cases) assert.deepStrictEqual([...settingsTool.topLevelModules(c.record)].sort(), c.topLevel, c.why);
  });

  it('a module of role null in no pack, or a part, has no row and is SETTING_UNKNOWN', async () => {
    fs.writeFileSync(path.join(dir, 'modules.json'), JSON.stringify({modules: {[SCENARIO]: {version: '0.5.0', role: 'scenario'}, [TOOL]: {version: '1.2.0', role: null}},
      packs: {'ci-failure-triage': {modules: {[SCENARIO]: '0.5.0'}}}}));
    const rows = (await tool().get()).settings.filter((r) => r.name.startsWith('enabled.'));
    assert.deepStrictEqual(rows.map((r) => r.module), [SCENARIO]);
    await refused(tool().set(`enabled.${TOOL}`, 'off'), 'SETTING_UNKNOWN');
  });

  // #449's high review, 9: the enabled rows are paged with the module rows
  // (theirs first), and a request reads ch-local's record and the loaded
  // modules once
  it('the enabled rows are paged with the module rows, at most 64 a call; each get reads the record and the loaded modules once', async () => {
    const many = Object.fromEntries(Array.from({length: 70}, (_, i) => [`tool-${String(i).padStart(2, '0')}`, {version: '1.0.0', role: null}]));
    record(many);
    let tops = 0;
    let reads = 0;
    const realRead = fs.readFileSync;
    const t = tool({loadedTops: () => { tops += 1; return []; }});
    fs.readFileSync = function(f, ...rest) { if (typeof(f) === 'string' && f.endsWith('modules.json')) reads += 1; return realRead.call(fs, f, ...rest); };
    let first;
    let second;
    try {
      first = await t.get();
      assert.deepStrictEqual([reads, tops], [1, 1], 'once each');
      second = await t.get({}, {cursor: first.nextCursor});
    } finally { fs.readFileSync = realRead; }
    const names = (a) => a.settings.filter((r) => r.name.startsWith('enabled.')).map((r) => r.module);
    assert.strictEqual(names(first).length, 64);
    assert.strictEqual(typeof(first.nextCursor), 'string');
    assert.deepStrictEqual(names(first).concat(names(second)), Object.keys(many));
    assert.strictEqual(second.nextCursor, undefined);
    assert.strictEqual(second.history, undefined, 'a later page: the paged rows alone');
  });

  // #449's high review, round 3, 6: the list paged over is live; a cursor
  // is bound to the rows it was cut from, so a list that changed between
  // pages is said, never a row skipped or repeated
  it('a cursor from a list that changed since is SETTING_CURSOR_STALE: start again', async () => {
    const many = Object.fromEntries(Array.from({length: 70}, (_, i) => [`tool-${String(i).padStart(2, '0')}`, {version: '1.0.0', role: null}]));
    record(many);
    const t = tool({loadedTops: () => []});
    const first = await t.get();
    // one installed before the cursor's place: every row after it moves
    record(Object.assign({'tool-00a': {version: '1.0.0', role: null}}, many));
    const e = await refused(t.get({}, {cursor: first.nextCursor}), 'SETTING_CURSOR_STALE');
    assert.match(e.message, /changed/);
    // the list as it was: the cursor is good again
    record(many);
    assert.strictEqual((await t.get({}, {cursor: first.nextCursor})).settings.length, 70 - 64);
  });

  it('set reads the record and the loaded modules once', async () => {
    let tops = 0;
    let reads = 0;
    const realRead = fs.readFileSync;
    const t = tool({loadedTops: () => { tops += 1; return [{name: TOOL, modules: [TOOL], tools: []}, {name: CALLER, modules: [CALLER, TOOL], tools: []}]; }});
    fs.readFileSync = function(f, ...rest) { if (typeof(f) === 'string' && f.endsWith('modules.json')) reads += 1; return realRead.call(fs, f, ...rest); };
    try {
      assert.deepStrictEqual((await t.set(`enabled.${TOOL}`, 'off')).alsoOff, [CALLER]);
    } finally { fs.readFileSync = realRead; }
    assert.deepStrictEqual([reads, tops], [1, 1]);
  });

  // the medium review of round 3, 5: only a runtime that serves the
  // settings tool tells an unload as its off
  it('storedOff: a module the settings file has off, read only where the settings tool is served', () => {
    const saved = {settingsFile: options.settingsFile, settingsTool: options.settingsTool};
    try {
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {[`enabled.${TOOL}`]: false}}));
      options.settingsFile = file;
      options.settingsTool = true;
      assert.strictEqual(settingsTool.storedOff(TOOL), true);
      assert.strictEqual(settingsTool.storedOff(CALLER), false);
      options.settingsTool = false;
      assert.strictEqual(settingsTool.storedOff(TOOL), false);
    } finally { Object.assign(options, saved); }
  });

  it('a part, a module not installed and a name of no grammar are SETTING_UNKNOWN', async () => {
    for (const name of [`enabled.${PART}`, 'enabled.not-installed', 'pack.ci-failure-triage']) {
      await refused(tool().set(name, 'off'), 'SETTING_UNKNOWN');
    }
  });

  // #449's high review, round 3, R: every session is told by ch-local's
  // unload (lib/module-control.js), the one source; the settings tool
  // answers the asking session only
  it('off: made on request, written under the lock with the history line first, the asker answered, no session told here; a stored pack.* kept', async () => {
    const got = await tool().set(`enabled.${TOOL}`, 'off');
    assert.strictEqual(got.new, 'off');
    assert.deepStrictEqual(got.alsoOff, [CALLER]);
    assert.strictEqual(stored()[`enabled.${TOOL}`], false);
    assert.strictEqual(stored()['pack.ci-failure-triage'], false, 'an unknown name is kept');
    const line = history().find((l) => l.setting === `enabled.${TOOL}`);
    assert.deepStrictEqual({old: line.old, new: line.new}, {old: true, new: false});
    assert.strictEqual(got.said, `${TOOL} off is written; it turns off for every session as soon as ch-local applies it.`);
    // (the medium review of round 3, 6) one not loaded: no unload comes, so
    // none is promised
    assert.strictEqual((await tool().set(`enabled.${SCENARIO}`, 'off')).said, `${SCENARIO} off is written; it is not loaded now, so nothing else changes.`);
    // the text the unload tells (#449's high review, 7: the two ways back)
    assert.strictEqual(settingsTool.offNotice(TOOL, [CALLER]),
      `${TOOL} is turned off for all your sessions. ${CALLER} calls it, so ${CALLER} is off too. They stay off until ${TOOL} is turned on again: here (you'll be asked to confirm) or at a terminal: \`ch-local settings set enabled.${TOOL} on\`.`);
    assert.strictEqual(settingsTool.offNotice(CALLER, []),
      `${CALLER} is turned off for all your sessions. It stays off until it is turned on again: here (you'll be asked to confirm) or at a terminal: \`ch-local settings set enabled.${CALLER} on\`.`);
    // the same again changes nothing and records nothing
    const n = history().length;
    assert.strictEqual((await tool().set(`enabled.${TOOL}`, 'off')).new, 'off');
    assert.strictEqual(history().length, n);
  });

  it('on with no tested client: SETTING_NEEDS_CONFIRMATION with the terminal command', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {[`enabled.${TOOL}`]: false}}));
    const e = await refused(tool({mayElicit: async () => ({ok: false, why: 'not on the tested-client list'})}).set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    assert.match(e.message, /ch-local settings set enabled\.weather-tool on/);
    assert.strictEqual(stored()[`enabled.${TOOL}`], false);
  });

  it('on with a tested client: the form of kind enabled, the runtime\'s sentence in en and zh; a yes writes it with the version confirmed', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {[`enabled.${TOOL}`]: false}}));
    const t = tool();
    const asked = await t.set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT);
    assert.strictEqual(asked.inputRequired.inputRequests.approve.params.message,
      `Turn on ${TOOL} 1.2.0 in countinghouse for all your sessions? It stays on, now and after a restart, until it is turned off.`);
    const done = await t.confirm(`enabled.${TOOL}`, 'on', {requestState: asked.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT);
    assert.deepStrictEqual({old: done.old, new: done.new, applies: done.applies}, {old: 'off', new: 'on', applies: 'now'});
    assert.strictEqual(stored()[`enabled.${TOOL}`], true);
    assert.match(history().filter((l) => l.setting === `enabled.${TOOL}`).pop().confirmed, /^1\.2\.0 \(elicitation, claude-code 2\.1\.323\)$/);
    options.locale = 'zh-CN';
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {[`enabled.${CALLER}`]: false}}));
    const zh = await tool().set(`enabled.${CALLER}`, 'on', 'settings tool', CLIENT);
    assert.strictEqual(zh.inputRequired.inputRequests.approve.params.message, `要在 countinghouse 中为你的所有会话启用模块 ${CALLER}（2.0.0）吗？启用后一直有效，重启后仍然有效，直到被关闭。`);
  });

  it('on: a version that changed while the user was asked writes nothing (SETTING_CHANGED_MEANWHILE); a decline locks the kind', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {[`enabled.${TOOL}`]: false}}));
    const t = tool();
    const asked = await t.set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT);
    record({[TOOL]: {version: '1.3.0', role: null}});
    await refused(t.confirm(`enabled.${TOOL}`, 'on', {requestState: asked.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_CHANGED_MEANWHILE');
    assert.strictEqual(stored()[`enabled.${TOOL}`], false);
    const again = await t.set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT);
    const no = await t.confirm(`enabled.${TOOL}`, 'on', {requestState: again.inputRequired.requestState, inputResponses: DECLINE}, CLIENT);
    assert.strictEqual(no.applies, 'declined');
    assert.strictEqual(confirm.kindOf(`enabled.${TOOL}`), 'enabled');
    await refused(t.set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT), 'SETTING_DECLINED_THIS_START');
  });

  it('the ceiling: a module not on its modules list is SETTING_FORBIDDEN_BY_CEILING; one that lists packs only is not trusted for a module; conversation off is the terminal', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {[`enabled.${TOOL}`]: false}}));
    const trusted = (c) => () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: Object.assign({forbid: [], conversation: true, packs: null, modules: null}, c)});
    await refused(tool({ceiling: trusted({modules: [CALLER]})}).set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT), 'SETTING_FORBIDDEN_BY_CEILING');
    await refused(tool({ceiling: trusted({packs: ['other']})}).set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT), 'SETTING_CEILING_UNTRUSTED');
    await refused(tool({ceiling: trusted({modules: [TOOL], conversation: false})}).set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    // off is never refused by it
    assert.strictEqual((await tool({ceiling: trusted({modules: []})}).set(`enabled.${CALLER}`, 'off')).new, 'off');
  });

  // the medium review of M5b
  it('ch-local\'s record unreadable: off is still made, on is the terminal\'s', async () => {
    fs.writeFileSync(path.join(dir, 'modules.json'), '{"modules": ');
    assert.strictEqual((await tool().set(`enabled.${TOOL}`, 'off')).new, 'off');
    assert.strictEqual(stored()[`enabled.${TOOL}`], false);
    // (#449's high review, 5: said as it is, never a ceiling's doing)
    const e = await refused(tool().set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT), 'SETTING_RECORD_UNREADABLE');
    assert.match(e.message, /ch-local's record of the installed modules can't be read right now/);
    assert.match(e.message, /ch-local settings set enabled\.weather-tool on/);
    assert.ok(!/ceiling/.test(e.message), e.message);
    const line = history().filter((l) => l.setting === `enabled.${TOOL}` && l.asked === true).pop();
    assert.strictEqual(line.change, 'not confirmed (ch-local\'s record cannot be read)');
    assert.deepStrictEqual((await tool().get()).settings.filter((r) => r.name.startsWith('enabled.')), [], 'no rows to show');
  });

  // #449's high review, 3: the record before modules.json, the same way
  it('no modules.json and packs.json unreadable, or not a record: off is still made, on is the terminal\'s', async () => {
    fs.rmSync(path.join(dir, 'modules.json'));
    for (const text of ['{"packs": ', '[]', '{"packs": 7}']) {
      fs.writeFileSync(path.join(dir, 'packs.json'), text);
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {}}));
      assert.strictEqual((await tool().set(`enabled.${TOOL}`, 'off')).new, 'off', text);
      assert.strictEqual(stored()[`enabled.${TOOL}`], false, text);
      await refused(tool().set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT), 'SETTING_RECORD_UNREADABLE');
    }
    // neither record there: nothing installed, so no module to name
    fs.rmSync(path.join(dir, 'packs.json'));
    await refused(tool().set(`enabled.${TOOL}`, 'off'), 'SETTING_UNKNOWN');
  });

  it('a form answered yes while ch-local\'s record has become unreadable writes nothing, and says why', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {[`enabled.${TOOL}`]: false}}));
    const t = tool();
    const asked = await t.set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT);
    fs.writeFileSync(path.join(dir, 'modules.json'), '{"modules": ');
    await refused(t.confirm(`enabled.${TOOL}`, 'on', {requestState: asked.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_RECORD_UNREADABLE');
    assert.strictEqual(stored()[`enabled.${TOOL}`], false);
  });

  it('two requests turning one module off at once: one writes; the other changes nothing', async () => {
    const t = tool();
    const both = await Promise.all([t.set(`enabled.${TOOL}`, 'off'), t.set(`enabled.${TOOL}`, 'off')]);
    assert.strictEqual(both.filter((r) => r.said != null).length, 1);
    assert.strictEqual(history().filter((l) => l.setting === `enabled.${TOOL}`).length, 1);
  });

  // #449's high review, 6: a tightening never counts against the budget, on
  // any runtime; only a module turned on does
  it('an off never counts against the budget: forty in a row are all made, on the runtime and in a session', async () => {
    const t = tool();
    const sid = 'a'.repeat(32);
    for (const ctx of [undefined, {shared: true, session: sid}]) {
      for (let i = 0; i < 40; i++) {
        fs.writeFileSync(file, JSON.stringify({version: 1, values: {}}));
        assert.strictEqual((await t.set(`enabled.${TOOL}`, 'off', 'settings tool', ctx)).new, 'off', `${i}`);
      }
    }
  });

  // the medium review of the #449 fixes, 1: an off with ch-local's record
  // unreadable names no module known to be installed, so it counts (else any
  // name, without end, each a line and a notice)
  // (#449's high review, round 3, 1: counted, but a tightening is never
  // refused: past the budget it is still made; the ons that follow go to the
  // terminal)
  it('an off while ch-local\'s record cannot be read counts against the budget, and is never refused', async () => {
    fs.writeFileSync(path.join(dir, 'modules.json'), '{"modules": ');
    const t = tool();
    for (let i = 0; i < 40; i++) assert.strictEqual((await t.set(`enabled.made-up-${i}`, 'off')).new, 'off', `${i}`);
    assert.strictEqual(history().filter((l) => /^enabled\.made-up-/.test(l.setting) && l.new === false).length, 40, 'each one a line');
    // the record readable again: an installed module's off is made; an on is
    // past the budget, so the terminal's
    record({[TOOL]: {version: '1.2.0', role: null}});
    assert.strictEqual((await t.set(`enabled.${TOOL}`, 'off')).new, 'off');
    await refused(t.set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    assert.match(history().pop().change, /32 changes made/);
  });

  it('the budget counts a module turned on, and is checked under the lock: confirmations at once never pass it together', async () => {
    const t = tool();
    const on = async () => {
      const asked = await t.set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT);
      return t.confirm(`enabled.${TOOL}`, 'on', {requestState: asked.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT);
    };
    for (let i = 0; i < 31; i++) {
      confirm.resetForTests();   // (three forms a start)
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {[`enabled.${TOOL}`]: false}}));
      assert.strictEqual((await on()).new, 'on', `${i}`);
    }
    confirm.resetForTests();
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {[`enabled.${TOOL}`]: false, [`enabled.${CALLER}`]: false}}));
    const a = await t.set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT);
    const b = await t.set(`enabled.${CALLER}`, 'on', 'settings tool', CLIENT);
    const got = await Promise.allSettled([
      t.confirm(`enabled.${TOOL}`, 'on', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT),
      t.confirm(`enabled.${CALLER}`, 'on', {requestState: b.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT)]);
    assert.strictEqual(got.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(got.map((r) => r.status === 'fulfilled' ? r.value : r.reason.code)));
    // and an off is still made past it
    assert.strictEqual((await t.set(`enabled.${TOOL}`, 'off')).new, 'off');
  });

  it('packs.json: a pack\'s scenario stays a top-level module, whatever another pack lists it as; a ~ in a name is a name', async () => {
    fs.rmSync(path.join(dir, 'modules.json'));
    fs.writeFileSync(path.join(dir, 'packs.json'), JSON.stringify({packs: {
      a: {packages: {'@countinghouse/ch-pack-a': '1.0.0'}},
      b: {packages: {'@countinghouse/ch-pack-b': '1.0.0', '@countinghouse/ch-pack-a': '1.0.0'}}}}));
    const names = (await tool().get()).settings.filter((r) => r.name.startsWith('enabled.')).map((r) => r.module);
    assert.deepStrictEqual(names, ['@countinghouse/ch-pack-a', '@countinghouse/ch-pack-b']);
    record({'tilde~tool': {version: '1.0.0', role: null}});
    assert.strictEqual((await tool().set('enabled.tilde~tool', 'off')).new, 'off');
  });

  it('a shared runtime\'s session turns a module off for every session: its line names the session with the every-session marker', async () => {
    const sid = 'a'.repeat(32);
    const got = await tool().set(`enabled.${TOOL}`, 'off', 'settings tool', {shared: true, session: sid});
    assert.strictEqual(got.new, 'off');
    const line = history().find((l) => l.setting === `enabled.${TOOL}`);
    assert.strictEqual(line.session, sid);
    assert.ok(line.scope != null, JSON.stringify(line));
  });
});

'use strict';
// M5b (#413 rev 3, sections 5.1 and 5.3): enabled.<module> in the settings
// tool, a top-level module's on/off for every session of the user. get lists
// one row per installed top-level module (modules.json; never a part); off
// is made on request, written under the lock (history first, naming the
// session), counted against the 32-change budget (a runtime with one session
// too), and every session is told what went with it and how to undo it; on
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
  let told;
  let savedLocale;
  const history = () => { try { return fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf8')).values;
  const record = (modules) => fs.writeFileSync(path.join(dir, 'modules.json'), JSON.stringify({modules}));
  const tool = (o = {}) => settingsTool.create(Object.assign({
    file,
    ceiling: () => ({state: 'none'}),
    mayElicit: async () => ({ok: true, client: {name: 'claude-code', version: '2.1.323'}}),
    // weather-tool loaded, and trip-planner, whose closure holds it
    loadedTops: () => [{name: TOOL, modules: [TOOL], tools: ['weather_tool_forecast_get']}, {name: CALLER, modules: [CALLER, TOOL], tools: ['plan_trip']}],
    tellEverySession: (module, text) => told.push([module, text])
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
    told = [];
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

  it('a part, a module not installed and a name of no grammar are SETTING_UNKNOWN', async () => {
    for (const name of [`enabled.${PART}`, 'enabled.not-installed', 'pack.ci-failure-triage']) {
      await refused(tool().set(name, 'off'), 'SETTING_UNKNOWN');
    }
  });

  it('off: made on request, written under the lock with the history line first, every session told what went with it and how to undo it; a stored pack.* kept', async () => {
    const got = await tool().set(`enabled.${TOOL}`, 'off');
    assert.strictEqual(got.new, 'off');
    assert.deepStrictEqual(got.alsoOff, [CALLER]);
    assert.strictEqual(stored()[`enabled.${TOOL}`], false);
    assert.strictEqual(stored()['pack.ci-failure-triage'], false, 'an unknown name is kept');
    const line = history().find((l) => l.setting === `enabled.${TOOL}`);
    assert.deepStrictEqual({old: line.old, new: line.new}, {old: true, new: false});
    const text = `${TOOL} is turned off for all your sessions. ${CALLER} calls it, so ${CALLER} is off too. They stay off until ${TOOL} is turned on at a terminal: \`ch-local settings set enabled.${TOOL} on\`.`;
    assert.deepStrictEqual(told, [[TOOL, text]]);
    assert.strictEqual(got.said, text);
    // the same again changes nothing and records nothing
    const n = history().length;
    assert.strictEqual((await tool().set(`enabled.${TOOL}`, 'off')).new, 'off');
    assert.strictEqual(history().length, n);
  });

  it('off counts against the budget of 32 changes, on a runtime with one session too; past it, the terminal', async () => {
    const t = tool();
    for (let i = 0; i < 16; i++) {
      await t.set(`enabled.${TOOL}`, 'off');
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {}}));   // the terminal turns it back on
      await t.set(`enabled.${CALLER}`, 'off');
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {}}));
    }
    const e = await refused(t.set(`enabled.${TOOL}`, 'off'), 'SETTING_NEEDS_CONFIRMATION');
    assert.match(e.message, /ch-local settings set enabled\.weather-tool off/);
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
    await refused(tool().set(`enabled.${TOOL}`, 'on', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    assert.deepStrictEqual((await tool().get()).settings.filter((r) => r.name.startsWith('enabled.')), [], 'no rows to show');
  });

  it('two requests turning one module off at once: one writes and tells; the other changes nothing and tells no one', async () => {
    const t = tool();
    const both = await Promise.all([t.set(`enabled.${TOOL}`, 'off'), t.set(`enabled.${TOOL}`, 'off')]);
    assert.strictEqual(told.length, 1, JSON.stringify(told));
    assert.strictEqual(both.filter((r) => r.said != null).length, 1);
    assert.strictEqual(history().filter((l) => l.setting === `enabled.${TOOL}`).length, 1);
  });

  it('the budget is checked under the lock: requests at once never pass it together', async () => {
    const t = tool();
    for (let i = 0; i < 31; i++) {
      await t.set(`enabled.${TOOL}`, i % 2 === 0 ? 'off' : 'off');
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {}}));
    }
    const got = await Promise.allSettled([t.set(`enabled.${TOOL}`, 'off'), t.set(`enabled.${CALLER}`, 'off')]);
    assert.strictEqual(got.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(got.map((r) => r.status)));
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

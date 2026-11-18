'use strict';
// countinghouse_settings and module settings (the module-level configuration
// design, section 4.4; M2b), server-free: get lists each loaded top-level
// module's declared settings (never a part's), at most 64 a call with a
// cursor; set module.<package>.<setting> changes one on request (an enum,
// integer, number or boolean the author did not mark confirm), written
// under the lock with the history line first, then applied; every string
// setting, and one marked confirm, needs the user's own confirmation (the
// terminal, with no tested client); the operator's ceiling binds (fixed,
// conversation: false, untrusted); a hint never carries a value; a part's
// name, an undeclared one or a module not loaded is SETTING_UNKNOWN.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
const settingsTool = require('../../lib/settings-tool');
const ms = require('../../lib/module-settings');
const ceilingLib = require('../../lib/settings-ceiling');

const pkgOf = (name, settings, extra = {}) => ({name, version: '1.2.0', countinghouse: Object.assign({settings}, extra)});
const W = pkgOf('@acme/weather-tool', {
  units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric', title: 'Units'},
  maxResults: {type: 'integer', min: 1, max: 100, default: 20},
  shareStats: {type: 'boolean', default: false, confirm: true},
  defaultRepo: {type: 'string', format: 'repo', title: 'Default repository', description: 'Used when you name none'}});
const P = pkgOf('@acme/region-part', {region: {type: 'string'}}, {role: 'part'});
const trusted = (obj) => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: ceilingLib.parse(JSON.stringify(Object.assign({version: 1}, obj))).ceiling});

describe('validation 30: countinghouse_settings and module settings', () => {
  let home;
  let file;
  let saved;
  let applied;
  let ceiling;
  let modules;
  const history = () => fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf8')).values;
  const refused = async (p, code) => {
    let err = null;
    try { await p; } catch (e) { err = e; }
    assert.ok(err != null, `refused ${code}`);
    assert.strictEqual(err.code, code, err.message);
    return err;
  };
  const make = () => settingsTool.create({file, lockWaitMs: 200, ceiling: () => ceiling,
    moduleStates: () => modules, applyModuleSettings: async () => { applied += 1; return {applied: 1, refused: []}; }});
  const loadedWith = (values) => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values}));
    modules = [{name: W.name, version: W.version, part: false, state: ms.stateFor(W.name, W, {operator: false, net: []})},
      {name: P.name, version: P.version, part: true, state: ms.stateFor(P.name, P, {operator: false, net: []})}];
  };

  before(() => { saved = {settingsFile: options.settingsFile}; });
  after(() => Object.assign(options, saved));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-validation-30-'));
    file = path.join(home, 'settings.json');
    options.settingsFile = file;
    applied = 0;
    ceiling = {state: 'none'};
    loadedWith({'module.@acme/weather-tool.units': 'imperial', 'other.kept': 1});
  });
  afterEach(() => fs.rmSync(home, {recursive: true, force: true}));

  describe('get', () => {
    it('each declared setting of a loaded top-level module: its value, default, what is allowed, the module\'s own words, and how it changes; never a part\'s', async () => {
      const got = await make().get();
      const rows = Object.fromEntries(got.settings.filter((s) => s.name.startsWith('module.')).map((s) => [s.name, s]));
      assert.deepStrictEqual(Object.keys(rows).sort(), ['module.@acme/weather-tool.defaultRepo', 'module.@acme/weather-tool.maxResults',
        'module.@acme/weather-tool.shareStats', 'module.@acme/weather-tool.units']);
      assert.deepStrictEqual(rows['module.@acme/weather-tool.units'], {name: 'module.@acme/weather-tool.units', module: '@acme/weather-tool', version: '1.2.0',
        type: 'enum', value: 'imperial', default: 'metric', bounds: {enum: ['metric', 'imperial']}, changes: 'on request',
        byTheModule: {title: 'Units'}});
      assert.deepStrictEqual(rows['module.@acme/weather-tool.maxResults'].bounds, {min: 1, max: 100});
      assert.strictEqual(rows['module.@acme/weather-tool.shareStats'].changes, 'needs your confirmation');
      const repo = rows['module.@acme/weather-tool.defaultRepo'];
      assert.strictEqual(repo.changes, 'needs your confirmation');
      assert.strictEqual(repo.value, undefined, 'unset: no value');
      assert.deepStrictEqual(repo.byTheModule, {title: 'Default repository', description: 'Used when you name none'});
      assert.deepStrictEqual(repo.bounds, {format: 'repo', maxLength: 256});
      assert.ok(!got.settings.some((s) => s.name.includes('region')), 'a part\'s are never listed');
    });

    it('the ceiling: a fixed value is the operator\'s; conversation off is the terminal\'s', async () => {
      ceiling = trusted({moduleSettings: {'@acme/weather-tool.units': {fixed: 'metric'}, '@acme/weather-tool.maxResults': {conversation: false}}});
      const rows = Object.fromEntries((await make().get()).settings.map((s) => [s.name, s]));
      assert.strictEqual(rows['module.@acme/weather-tool.units'].changes, 'fixed by the operator');
      assert.strictEqual(rows['module.@acme/weather-tool.maxResults'].changes, 'at a terminal only');
    });

    it('at most 64 module settings a call, with a cursor', async () => {
      const many = [];
      for (let m = 0; m < 3; m += 1) {
        const decl = {};
        for (let i = 0; i < 30; i += 1) decl[`s${i}`] = {type: 'boolean', default: false};
        const pkg = pkgOf(`mod-${m}`, decl);
        many.push({name: pkg.name, version: pkg.version, part: false, state: ms.stateFor(pkg.name, pkg, {operator: false, net: []})});
      }
      modules = many;
      const tool = make();
      const first = await tool.get({}, {});
      const firstRows = first.settings.filter((s) => s.name.startsWith('module.'));
      assert.strictEqual(firstRows.length, 64);
      assert.strictEqual(typeof(first.nextCursor), 'string');
      const second = await tool.get({}, {cursor: first.nextCursor});
      const secondRows = second.settings.filter((s) => s.name.startsWith('module.'));
      assert.strictEqual(secondRows.length, 26);
      assert.strictEqual(second.nextCursor, undefined);
      assert.strictEqual(new Set([...firstRows, ...secondRows].map((s) => s.name)).size, 90);
      await refused(tool.get({}, {cursor: 'not-a-cursor'}), 'SETTING_CURSOR_INVALID');
    });
  });

  describe('the tool\'s input schema', () => {
    it('takes a cursor for get, and names module settings', () => {
      const props = settingsTool.INPUT_SCHEMA.properties;
      assert.deepStrictEqual(Object.keys(props).sort(), ['action', 'cursor', 'name', 'scope', 'value']);
      assert.strictEqual(props.cursor.type, 'string');
      assert.match(props.name.description, /module\.<package>\.<setting>/);
      assert.strictEqual(settingsTool.INPUT_SCHEMA.additionalProperties, false);
    });
  });

  describe('set', () => {
    it('on request: an enum, an integer or a boolean not marked confirm; written under the lock, the history line first, unknown names kept, then applied', async () => {
      const tool = make();
      assert.deepStrictEqual(await tool.set('module.@acme/weather-tool.units', 'metric'),
        {name: 'module.@acme/weather-tool.units', old: 'imperial', new: 'metric', applies: 'now', scope: 'every session of this user'});
      assert.deepStrictEqual(await tool.set('module.@acme/weather-tool.maxResults', '50'),
        {name: 'module.@acme/weather-tool.maxResults', old: 20, new: 50, applies: 'now', scope: 'every session of this user'});
      assert.deepStrictEqual(stored(), {'module.@acme/weather-tool.units': 'metric', 'other.kept': 1, 'module.@acme/weather-tool.maxResults': 50});
      const lines = history();
      assert.deepStrictEqual(lines.map((l) => [l.setting, l.old, l.new]), [['module.@acme/weather-tool.units', 'imperial', 'metric'], ['module.@acme/weather-tool.maxResults', 20, 50]]);
      assert.strictEqual(applied, 2, 'applied after each write');
    });

    it('a value outside what is declared: refused, saying what is allowed, never the value', async () => {
      const err = await refused(make().set('module.@acme/weather-tool.units', 'kelvin'), 'SETTING_INVALID');
      assert.match(err.message, /metric or imperial/);
      assert.ok(!/kelvin/.test(err.message), err.message);
      assert.ok(!/kelvin/.test(JSON.stringify(err.fields || {})), 'never the value');
      assert.strictEqual(applied, 0);
    });

    it('every string setting, and one marked confirm, needs the user\'s own confirmation: the terminal command, no value', async () => {
      for (const [name, value] of [['defaultRepo', 'acme/repo'], ['shareStats', 'on']]) {
        const err = await refused(make().set(`module.@acme/weather-tool.${name}`, value), 'SETTING_MODULE_NEEDS_CONFIRMATION');
        assert.match(err.message, new RegExp(`ch-local settings set @acme/weather-tool\\.${name}`), err.message);
        assert.ok(!err.message.includes('acme/repo'), err.message);
      }
      assert.deepStrictEqual(stored(), {'module.@acme/weather-tool.units': 'imperial', 'other.kept': 1}, 'nothing written');
    });

    it('the ceiling: fixed refuses every change; conversation off is the terminal\'s; one that cannot be trusted refuses', async () => {
      ceiling = trusted({moduleSettings: {'@acme/weather-tool.units': {fixed: 'metric'}}});
      await refused(make().set('module.@acme/weather-tool.units', 'metric'), 'SETTING_FIXED_BY_CEILING');
      ceiling = trusted({moduleSettings: {conversation: false}});
      await refused(make().set('module.@acme/weather-tool.maxResults', '50'), 'SETTING_MODULE_NEEDS_CONFIRMATION');
      ceiling = {state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: 'it is a symbolic link'};
      await refused(make().set('module.@acme/weather-tool.maxResults', '50'), 'SETTING_CEILING_UNTRUSTED');
      assert.strictEqual(applied, 0);
    });

    it('a part\'s setting, an undeclared one or a module not loaded: SETTING_UNKNOWN, as a name that does not exist', async () => {
      for (const name of ['module.@acme/region-part.region', 'module.@acme/weather-tool.nope', 'module.not-loaded.units', 'module.@acme/weather-tool']) {
        await refused(make().set(name, 'x'), 'SETTING_UNKNOWN');
      }
    });
  });
});

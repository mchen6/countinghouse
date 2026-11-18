'use strict';
// The values a module's worker runs with (the module-level configuration
// design, sections 4.2, 4.5 and 4.7; lib/module-settings.js stateFor):
// read at each load, reload and supervised restart, from
// - `--settingsFile` (ch-local's settings.json): `module.<package>.<setting>`,
//   the last dot splitting the setting from the package name;
// - or, on a server outside the single-identity profile, `--moduleSettings`
//   (`{"<package>": {"<setting>": value}}`), never written by the runtime;
// numbered with a version of their own (a later state, a higher version).
// A stored value the loaded version does not accept is not applied: one log
// line naming the setting (never the value), and on an operator's load one
// history line beside the settings file. Under --moduleSettings a required
// setting left unset, or a file that cannot be read, refuses the load with
// an operator-facing reason. Server-free.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');

const DECL = {
  units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric'},
  maxResults: {type: 'integer', min: 1, max: 100, default: 20},
  defaultRepo: {type: 'string', format: 'repo'},
};
const pkgOf = (name, settings = DECL) => ({name, version: '1.2.3', countinghouse: {settings}});

describe('module-loading 41: the values a module\'s worker runs with', () => {
  let dir = null;
  let saved = null;
  let lines = null;
  const ms = () => require('../../lib/module-settings');
  const state = (name, pkg, opts = {}) => ms().stateFor(name, pkg, Object.assign({net: [], operator: true, log: (l) => lines.push(l)}, opts));
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ml41-'));
    saved = {settingsFile: options.settingsFile, singleIdentity: options.singleIdentity, moduleSettings: options.moduleSettings};
    lines = [];
  });
  afterEach(() => {
    Object.assign(options, saved);
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const settingsFile = (values) => {
    const f = path.join(dir, 'settings.json');
    fs.writeFileSync(f, JSON.stringify({version: 1, values}));
    options.settingsFile = f;
    options.singleIdentity = true;
    options.moduleSettings = null;
    return f;
  };
  const moduleSettingsFile = (content) => {
    const f = path.join(dir, 'module-settings.json');
    fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
    options.settingsFile = null;
    options.singleIdentity = false;
    options.moduleSettings = f;
    return f;
  };
  const history = () => {
    try { return fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; }
  };

  it('a module that declares nothing has no state to carry', () => {
    settingsFile({});
    const s = state('plain', {name: 'plain', countinghouse: {}});
    assert.strictEqual(s.refused, null);
    assert.strictEqual(s.settings, null);
  });

  it('--settingsFile: module.<package>.<setting>, the last dot splitting; other modules\' and the runtime\'s names ignored', () => {
    settingsFile({
      'requestTimeout': 30000,
      'module.@acme/weather.tool.units': 'imperial',
      'module.@acme/weather.tool.defaultRepo': 'acme/api',
      'module.@acme/weather.units': 'metric',
      'module.@acme/weather.tool.nested.x': 1,
    });
    const s = state('@acme/weather.tool', pkgOf('@acme/weather.tool'));
    assert.strictEqual(s.refused, null);
    assert.deepStrictEqual(Object.assign({}, s.values), {units: 'imperial', maxResults: 20, defaultRepo: 'acme/api'});
  });

  it('no settings file yet: the defaults', () => {
    options.settingsFile = path.join(dir, 'none.json');
    options.singleIdentity = true;
    options.moduleSettings = null;
    const s = state('w', pkgOf('w'));
    assert.deepStrictEqual(Object.assign({}, s.values), {units: 'metric', maxResults: 20});
  });

  it('each state has a version of its own, higher than the one before', () => {
    settingsFile({});
    const a = state('w', pkgOf('w'));
    const b = state('w', pkgOf('w'));
    assert.ok(Number.isInteger(a.version) && b.version > a.version, `${a.version} ${b.version}`);
  });

  it('a stored value the version does not accept: not applied, one log line naming the setting (not the value), one history line on an operator\'s load', () => {
    const f = settingsFile({'module.w.units': 'kelvin-private', 'module.w.gone': 'x'});
    const s = state('w', pkgOf('w'));
    assert.strictEqual(s.values.units, 'metric');
    const said = lines.filter((l) => /w/.test(l) && /not applied/.test(l));
    assert.strictEqual(said.length, 2, lines.join('\n'));
    assert.ok(lines.every((l) => !l.includes('kelvin-private')), lines.join('\n'));
    const h = history();
    assert.deepStrictEqual(h.map((x) => [x.setting, x.change, x.by]).sort(), [
      ['module.w.gone', 'no longer valid for 1.2.3', 'runtime'],
      ['module.w.units', 'no longer valid for 1.2.3', 'runtime'],
    ]);
    assert.strictEqual(h.find((x) => x.setting === 'module.w.units').kept, 'kelvin-private');
    assert.ok(fs.readFileSync(f, 'utf8').includes('kelvin-private'), 'the stored value stays in the file');
    // a supervised restart says it in the log only
    lines = [];
    state('w', pkgOf('w'), {operator: false});
    assert.strictEqual(lines.filter((l) => /not applied/.test(l)).length, 2);
    assert.strictEqual(history().length, 2, 'no second history line');
  });

  it('the history line is written once per value in this runtime: a second operator load writes none', () => {
    settingsFile({'module.w2.units': 'kelvin'});
    state('w2', pkgOf('w2'));
    state('w2', pkgOf('w2'));
    assert.strictEqual(history().filter((h) => h.setting === 'module.w2.units').length, 1);
  });

  it('a dry run (before anything is unloaded): the refusal alone, nothing logged, written or numbered', () => {
    settingsFile({'module.w3.units': 'kelvin'});
    const before = state('w3', pkgOf('w3')).version;
    lines = [];
    const dry = state('w3', pkgOf('w3'), {dryRun: true});
    assert.strictEqual(dry.refused, null);
    assert.strictEqual(dry.version, null);
    assert.deepStrictEqual(lines, []);
    assert.ok(state('w3', pkgOf('w3')).version === before + 1, 'no version taken by the dry run');
    moduleSettingsFile({'w3': {}});
    const refusedDry = state('w3', pkgOf('w3', Object.assign({}, DECL, {region: {type: 'string', required: true}})), {dryRun: true});
    assert.ok(refusedDry.refused != null && /region/.test(refusedDry.refused.message));
  });

  it('a supervised restart whose settings file cannot be read keeps the values it ran with; an operator\'s load is refused', () => {
    settingsFile({'module.w4.units': 'imperial'});
    const last = state('w4', pkgOf('w4'));
    fs.writeFileSync(options.settingsFile, '{broken');
    lines = [];
    const kept = state('w4', pkgOf('w4'), {operator: false, last});
    assert.strictEqual(kept, last);
    assert.ok(lines.some((l) => /keeps the values it ran with/.test(l)), lines.join('\n'));
    assert.ok(state('w4', pkgOf('w4'), {operator: true, last}).refused != null);
  });

  it('the settings file is read as the settings tool reads it: another version is refused', () => {
    const f = path.join(dir, 'settings.json');
    fs.writeFileSync(f, JSON.stringify({version: 2, values: {'module.w.units': 'imperial'}}));
    options.settingsFile = f;
    options.singleIdentity = true;
    options.moduleSettings = null;
    assert.ok(state('w', pkgOf('w')).refused != null);
  });

  it('a stored key named __proto__ is a stored value like any other: not declared, not applied, said', () => {
    const f = path.join(dir, 'settings.json');
    fs.writeFileSync(f, `{"version": 1, "values": {"module.w5.__proto__": {"units": "imperial"}}}`);
    options.settingsFile = f;
    options.singleIdentity = true;
    options.moduleSettings = null;
    const s = state('w5', pkgOf('w5'));
    assert.strictEqual(s.values.units, 'metric');
    assert.ok(lines.some((l) => /__proto__ not applied/.test(l)), lines.join('\n'));
  });

  it('a kept value over 64 characters is written cut, with the SHA-256 of the whole', () => {
    settingsFile({'module.w.gone': 'v'.repeat(100)});
    state('w', pkgOf('w'));
    const [h] = history();
    assert.strictEqual(h.kept.length, 64);
    assert.strictEqual(h.keptSha256, require('crypto').createHash('sha256').update(JSON.stringify('v'.repeat(100))).digest('hex'));
  });

  it('--moduleSettings: the file\'s entry for the package', () => {
    moduleSettingsFile({'w': {units: 'imperial', defaultRepo: 'acme/api'}, 'other': {units: 'x'}});
    const s = state('w', pkgOf('w'));
    assert.strictEqual(s.refused, null);
    assert.deepStrictEqual(Object.assign({}, s.values), {units: 'imperial', maxResults: 20, defaultRepo: 'acme/api'});
    assert.deepStrictEqual(history(), [], 'the runtime writes no history for an operator\'s file');
  });

  it('--moduleSettings: a required setting it leaves unset refuses the load, for the operator', () => {
    moduleSettingsFile({'w': {}});
    const s = state('w', pkgOf('w', Object.assign({}, DECL, {region: {type: 'string', required: true}})));
    assert.ok(s.refused != null && s.refused.code === 'LOAD_MODULE_FAIL', String(s.refused && s.refused.code));
    assert.match(s.refused.message, /region/);
    assert.match(s.refused.message, /--moduleSettings/);
  });

  it('--moduleSettings that cannot be read, or is not an object of objects: the load is refused', () => {
    for (const bad of ['{not json', '[]', '{"w": 3}']) {
      moduleSettingsFile(bad);
      const s = state('w', pkgOf('w'));
      assert.ok(s.refused != null && s.refused.code === 'LOAD_MODULE_FAIL', `${bad}: ${String(s.refused && s.refused.code)}`);
      assert.match(s.refused.message, /--moduleSettings/);
    }
  });

  it('a settings file that is not valid refuses the load (fail closed)', () => {
    const f = path.join(dir, 'settings.json');
    fs.writeFileSync(f, '{not json');
    options.settingsFile = f;
    options.singleIdentity = true;
    options.moduleSettings = null;
    const s = state('w', pkgOf('w'));
    assert.ok(s.refused != null, 'refused');
  });

  it('a hostname value is checked against the net given (the module\'s granted net)', () => {
    settingsFile({'module.w.api': 'api.example.org'});
    const decl = {api: {type: 'string', format: 'hostname'}};
    assert.strictEqual(state('w', pkgOf('w', decl), {net: [{host: 'api.example.org', ports: null}]}).values.api, 'api.example.org');
    lines = [];
    assert.strictEqual('api' in state('w', pkgOf('w', decl), {net: []}).values, false);
    assert.ok(lines.some((l) => /api/.test(l) && /not applied/.test(l)), lines.join('\n'));
  });
});

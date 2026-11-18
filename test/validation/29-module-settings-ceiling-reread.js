'use strict';
// The operator's ceiling over module settings, and reread (the module-level
// configuration design, sections 4.3, 7.3 and 8; M2a). Server-free.
// - The ceiling's moduleSettings (lib/settings-ceiling.js parse): per
//   "<package>.<setting>" one of {"fixed": v}, {"confirm": true},
//   {"conversation": false}; a bare "conversation": false makes every module
//   setting terminal-only; any other shape makes the ceiling untrusted.
// - A fixed value (lib/module-settings.js stateFor, given the ceiling): over
//   the file's; one the declaration rejects refuses the load; a ceiling that
//   cannot be trusted refuses an operator's load of a module that declares
//   settings (a supervised restart keeps what it ran with).
// - reread (lib/settings-reread.js): each loaded module's state again, with
//   a new version, on its worker's proxy, its per-session record, every
//   session's worker and the restart's copy; atomic
//   per module (any refused value: that module keeps ALL its old values,
//   the others apply); a refusal is a notice and a history line; a settings
//   change never unloads.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ceiling = require('../../lib/settings-ceiling');
const ms = require('../../lib/module-settings');
const options = require('../../lib/cli-options');

const trusted = (c) => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: c});
const parsed = (obj) => ceiling.parse(JSON.stringify(Object.assign({version: 1}, obj)));

describe('validation 29: the ceiling\'s moduleSettings and reread', () => {
  describe('the ceiling\'s moduleSettings', () => {
    it('absent: null', () => {
      assert.strictEqual(parsed({}).ceiling.moduleSettings, null);
    });

    it('fixed, confirm and conversation:false per <package>.<setting>, scoped packages and dotted names too', () => {
      const r = parsed({moduleSettings: {
        '@acme/weather-tool.shareStats': {fixed: false},
        '@acme/weather-tool.units': {confirm: true},
        '@acme/repo-helper.defaultRepo': {conversation: false},
        'plain.tool.maxResults': {fixed: 20},
        'plain.tool.label': {fixed: ''}}});
      assert.strictEqual(r.problem, undefined, r.problem);
      const m = r.ceiling.moduleSettings;
      assert.strictEqual(m.conversation, true);
      assert.deepStrictEqual(Object.assign({}, m.byModule['@acme/weather-tool'].shareStats), {fixed: false});
      assert.deepStrictEqual(Object.assign({}, m.byModule['@acme/weather-tool'].units), {confirm: true});
      assert.deepStrictEqual(Object.assign({}, m.byModule['@acme/repo-helper'].defaultRepo), {conversation: false});
      // the last dot splits the setting from the package
      assert.deepStrictEqual(Object.assign({}, m.byModule['plain.tool'].maxResults), {fixed: 20});
      assert.ok(Object.isFrozen(m) && Object.isFrozen(m.byModule) && Object.isFrozen(m.byModule['plain.tool']));
      assert.strictEqual(Object.getPrototypeOf(m.byModule), null);
    });

    it('a bare "conversation": false makes every module setting terminal-only', () => {
      const m = parsed({moduleSettings: {conversation: false, 'a.b': {fixed: 1}}}).ceiling.moduleSettings;
      assert.strictEqual(m.conversation, false);
      assert.deepStrictEqual(Object.assign({}, ceiling.moduleSettingRule(trusted({moduleSettings: m}), 'x', 'y')), {conversation: false});
      assert.deepStrictEqual(Object.assign({}, ceiling.moduleSettingRule(trusted({moduleSettings: m}), 'a', 'b')), {fixed: 1}, 'a fixed value still binds');
    });

    it('moduleSettingRule: the rule, or null; none under no ceiling', () => {
      const c = trusted(parsed({moduleSettings: {'w.units': {confirm: true}}}).ceiling);
      assert.deepStrictEqual(Object.assign({}, ceiling.moduleSettingRule(c, 'w', 'units')), {confirm: true});
      assert.strictEqual(ceiling.moduleSettingRule(c, 'w', 'other'), null);
      assert.strictEqual(ceiling.moduleSettingRule({state: 'none'}, 'w', 'units'), null);
      assert.strictEqual(ceiling.moduleSettingRule(null, 'w', 'units'), null);
    });

    it('fixedOf (lib/module-settings.js): a module\'s fixed values, null-prototype, or null', () => {
      const c = trusted(parsed({moduleSettings: {'w.units': {fixed: 'metric'}, 'w.n': {confirm: true}, 'v.x': {fixed: 1}}}).ceiling);
      assert.deepStrictEqual(Object.assign({}, ms.fixedOf(c, 'w')), {units: 'metric'});
      assert.strictEqual(Object.getPrototypeOf(ms.fixedOf(c, 'w')), null);
      assert.strictEqual(ms.fixedOf(c, 'none'), null);
      assert.strictEqual(ms.fixedOf({state: 'none'}, 'w'), null);
    });

    it('any other shape fails closed: the ceiling is not trusted', () => {
      const bad = [
        [],
        'x',
        {conversation: true},
        {conversation: 'false'},
        {'w.units': {}},
        {'w.units': {fixed: 1, confirm: true}},
        {'w.units': {confirm: false}},
        {'w.units': {conversation: true}},
        {'w.units': {fixed: null}},
        {'w.units': {fixed: {a: 1}}},
        {'w.units': {fixed: [1]}},
        {'w.units': {fixed: Infinity}},
        {'w.units': {other: 1}},
        {'w.units': true},
        {'nodot': {fixed: 1}},
        {'w.': {fixed: 1}},
        {'.units': {fixed: 1}},
        {'W.units': {fixed: 1}},
        {'w.Units': {fixed: 1}},
        {'w.units-x': {fixed: 1}},
        {[`${'a'.repeat(215)}.units`]: {fixed: 1}},
        {'__proto__.units': {fixed: 1}},
      ];
      for (const b of bad) {
        const r = ceiling.parse(`{"version": 1, "moduleSettings": ${JSON.stringify(b).replace('"Infinity"', '1e999')}}`);
        assert.ok(r.problem != null, JSON.stringify(b).slice(0, 80));
        assert.match(r.problem, /moduleSettings/, r.problem);
      }
    });

    it('a ceiling reader without the key fails closed on it (an unknown key is untrusted)', () => {
      // the rule every reader has kept (stdio 17): what lets this key be added
      // without an older ch-local or runtime reading it as no restriction
      assert.match(ceiling.parse('{"version": 1, "moduleSettingz": {}}').problem, /holds/);
    });
  });

  describe('a fixed value at stateFor', () => {
    let dir = null;
    let saved = null;
    const pkg = {name: 'w', version: '1.0.0', countinghouse: {settings: {
      units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric'},
      n: {type: 'integer', min: 1, max: 9, default: 2}}}};
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-validation-29-'));
      saved = {settingsFile: options.settingsFile, moduleSettings: options.moduleSettings};
      options.settingsFile = path.join(dir, 'settings.json');
      options.moduleSettings = null;
      fs.writeFileSync(options.settingsFile, JSON.stringify({version: 1, values: {'module.w.units': 'imperial', 'module.w.n': 5}}));
    });
    after(() => { Object.assign(options, saved); fs.rmSync(dir, {recursive: true, force: true}); });

    it('over the file\'s value; no ceiling, or none for this module: the file\'s', () => {
      const c = trusted(parsed({moduleSettings: {'w.units': {fixed: 'metric'}}}).ceiling);
      assert.deepStrictEqual(Object.assign({}, ms.stateFor('w', pkg, {operator: true, ceiling: c}).values), {units: 'metric', n: 5});
      assert.deepStrictEqual(Object.assign({}, ms.stateFor('w', pkg, {operator: true, ceiling: {state: 'none'}}).values), {units: 'imperial', n: 5});
      assert.deepStrictEqual(Object.assign({}, ms.stateFor('w', pkg, {operator: true}).values), {units: 'imperial', n: 5});
    });

    it('one the declaration rejects refuses the load, with the ceiling\'s reason', () => {
      const c = trusted(parsed({moduleSettings: {'w.n': {fixed: 50}}}).ceiling);
      const st = ms.stateFor('w', pkg, {operator: true, ceiling: c});
      assert.ok(st.refused != null);
      assert.match(st.refused.message, /ceiling fixes n/);
      assert.deepStrictEqual(st.refusedBy, {code: 'SETTING_INVALID', setting: 'n', ceiling: true});
    });

    it('a ceiling that cannot be trusted: an operator\'s load refused; a supervised restart keeps what it ran with', () => {
      const c = {state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: 'it is a symbolic link'};
      const st = ms.stateFor('w', pkg, {operator: true, ceiling: c});
      assert.ok(st.refused != null);
      assert.match(st.refused.message, /ceiling/);
      assert.deepStrictEqual(st.refusedBy, {code: 'SETTING_CEILING_UNTRUSTED', setting: null});
      const last = {values: Object.freeze({units: 'metric', n: 3})};
      const restart = ms.stateFor('w', pkg, {operator: false, ceiling: c, last});
      assert.strictEqual(restart.refused, null);
      assert.deepStrictEqual(Object.assign({}, restart.values), {units: 'metric', n: 3});
    });

    it('a fixed name this version does not declare refuses the load, naming the entry (a typo fails closed)', () => {
      const c = trusted(parsed({moduleSettings: {'w.sharestats': {fixed: false}}}).ceiling);
      const st = ms.stateFor('w', pkg, {operator: true, ceiling: c});
      assert.ok(st.refused != null);
      assert.match(st.refused.message, /moduleSettings "w\.sharestats", which this version does not declare; update the ceiling/);
      assert.deepStrictEqual(st.refusedBy, {code: 'SETTING_UNKNOWN', setting: 'sharestats', ceiling: true});
    });

    it('a state carries what it was made from (not enumerable)', () => {
      const st = ms.stateFor('w', pkg, {operator: true, net: []});
      assert.strictEqual(st.made.pkg, pkg);
      assert.deepStrictEqual(st.made.net, []);
      assert.ok(!Object.keys(st).includes('made'));
    });

    it('a module that declares no settings is never refused by the ceiling', () => {
      const c = {state: 'untrusted', file: '/x', problem: 'p'};
      assert.strictEqual(ms.stateFor('v', {name: 'v', version: '1.0.0'}, {operator: true, ceiling: c}).refused, null);
    });

    it('the state says what was not applied, by code', () => {
      fs.writeFileSync(options.settingsFile, JSON.stringify({version: 1, values: {'module.w.units': 'kelvin', 'module.w.gone': 1}}));
      const st = ms.stateFor('w', pkg, {operator: false});
      assert.deepStrictEqual(st.notApplied.map((n) => [n.setting, n.code]), [['units', 'SETTING_INVALID'], ['gone', 'SETTING_UNKNOWN']]);
    });
  });

  describe('reread', () => {
    let reread = null;
    before(() => { require('../../lib/logger').createLogger(); reread = require('../../lib/settings-reread'); });
    const notices = require('../../lib/notices');
    const WorkerMessage = require('../../lib/worker-message');
    let dir = null;
    let saved = null;
    const pkgOf = (name, settings) => ({name, version: '1.0.0', countinghouse: {settings}});
    const W = pkgOf('w', {units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric'}, n: {type: 'integer', min: 1, max: 9, default: 2}});
    const R = pkgOf('r', {region: {type: 'string', required: true}, tag: {type: 'string'}});
    const write = (values) => fs.writeFileSync(options.settingsFile, JSON.stringify({version: 1, values}));
    const proxy = (name) => Object.assign(Object.create(WorkerMessage.prototype), {hostModuleName: name});
    // the same values and version: what a call is sent (what was not applied may be made again)
    const sameRun = (a, b, msg) => { assert.strictEqual(a.version, b.version, msg); assert.strictEqual(a.values, b.values, msg); };
    // a manager as reread reads one: each loaded module's proxy (or its
    // per-session record) with the state it runs with (which carries what it
    // was made from), the restart's copy, and each session's worker
    function manager() {
      const mm = {modules: {}, lastSettings: new Map(), unloads: [],
        sessionWorkers: {list: [], all() { return this.list; }},
        unloadModule(name) { this.unloads.push(name); }, unloadModuleExternal(name) { this.unloads.push(name); }};
      for (const pkg of [W, R]) {
        mm.lastSettings.set(pkg.name, ms.stateFor(pkg.name, pkg, {operator: true, net: []}));
      }
      mm.modules.w = proxy('w');
      mm.modules.w.settings = mm.lastSettings.get('w');
      // r keeps state per session: its record, and one session's worker
      mm.modules.r = Object.assign(Object.create(require('../../lib/session-module-record').SessionModuleRecord.prototype), {name: 'r'});
      mm.modules.r.settings = mm.lastSettings.get('r');
      const sw = proxy('r');
      sw.settings = mm.modules.r.settings;
      mm.sessionWorkers.list.push({name: 'r', sid: 's1', wm: sw});
      // a module that declares none
      mm.modules.plain = proxy('plain');
      return mm;
    }

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-validation-29r-'));
      saved = {settingsFile: options.settingsFile, moduleSettings: options.moduleSettings};
      options.settingsFile = path.join(dir, 'settings.json');
      options.moduleSettings = null;
      notices.resetForTests();
      write({'module.w.units': 'imperial', 'module.r.region': 'eu'});
    });
    afterEach(() => { Object.assign(options, saved); fs.rmSync(dir, {recursive: true, force: true}); });

    it('applies a changed value on every proxy, record and session worker, with a new version', async () => {
      const mm = manager();
      const before = {w: mm.modules.w.settings, r: mm.modules.r.settings};
      write({'module.w.units': 'metric', 'module.w.n': 7, 'module.r.region': 'us'});
      const reply = await reread.reread(mm, {type: 'reread', what: 'module-settings'}, {ceiling: () => ({state: 'none'})});
      assert.deepStrictEqual(reply, {applied: 2, refused: []});
      assert.deepStrictEqual(Object.assign({}, mm.modules.w.settings.values), {units: 'metric', n: 7});
      assert.ok(mm.modules.w.settings.version > before.w.version, 'a new version');
      assert.strictEqual(mm.lastSettings.get('w'), mm.modules.w.settings, 'the restart\'s copy');
      assert.deepStrictEqual(Object.assign({}, mm.modules.r.settings.values), {region: 'us'});
      assert.strictEqual(mm.sessionWorkers.list[0].wm.settings, mm.modules.r.settings, 'each session\'s worker');
      assert.strictEqual(mm.modules.plain.settings, undefined, 'a module that declares none: untouched');
      // what a call already sent keeps: the old state object is unchanged
      assert.strictEqual(before.w.values.units, 'imperial');
    });

    it('a module whose values did not change keeps its state (no new version)', async () => {
      const mm = manager();
      const w = mm.modules.w.settings;
      write({'module.w.units': 'imperial', 'module.r.region': 'asia'});
      const reply = await reread.reread(mm, {type: 'reread', what: 'module-settings'}, {ceiling: () => ({state: 'none'})});
      assert.deepStrictEqual(reply, {applied: 1, refused: []});
      sameRun(mm.modules.w.settings, w);
    });

    it('atomic per module: any refused value keeps ALL of that module\'s old values; the others apply', async () => {
      const mm = manager();
      const w = mm.modules.w.settings;
      // w: n is valid, units is not -> w keeps imperial and n 2; r applies
      write({'module.w.units': 'kelvin', 'module.w.n': 7, 'module.r.region': 'us'});
      const reply = await reread.reread(mm, {type: 'reread', what: 'module-settings'}, {ceiling: () => ({state: 'none'})});
      assert.deepStrictEqual(reply, {applied: 1, refused: [{name: 'module.w.units', code: 'SETTING_INVALID'}]});
      sameRun(mm.modules.w.settings, w, 'w: the state it had, whole');
      assert.deepStrictEqual(Object.assign({}, mm.modules.w.settings.values), {units: 'imperial', n: 2});
      sameRun(mm.lastSettings.get('w'), w);
      assert.deepStrictEqual(Object.assign({}, mm.modules.r.settings.values), {region: 'us'});
      // a notice to w's sessions, naming the setting, never the value
      const said = notices.take('w').map((n) => (typeof(n) === 'string' ? n : n.text)).join('\n');
      assert.match(said, /units/);
      assert.match(said, /not applied/);
      assert.ok(!/kelvin/.test(said), said);
      // and a history line
      const history = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(history.some((h) => h.by === 'runtime' && h.setting === 'module.w.units' && /not applied/.test(h.change)), JSON.stringify(history));
    });

    it('a stored name this version does not declare is not a refusal (it stays in the file, unread)', async () => {
      const mm = manager();
      write({'module.w.units': 'metric', 'module.w.gone': 1, 'module.r.region': 'eu'});
      const reply = await reread.reread(mm, {type: 'reread', what: 'module-settings'}, {ceiling: () => ({state: 'none'})});
      assert.deepStrictEqual(reply, {applied: 1, refused: []});
      assert.strictEqual(mm.modules.w.settings.values.units, 'metric');
    });

    it('a required setting newly unset applies, and nothing is unloaded (its calls answer SETTING_REQUIRED)', async () => {
      const mm = manager();
      write({'module.w.units': 'imperial'});
      const reply = await reread.reread(mm, {type: 'reread', what: 'module-settings'}, {ceiling: () => ({state: 'none'})});
      assert.deepStrictEqual(reply, {applied: 1, refused: []});
      assert.deepStrictEqual(ms.unsetRequired(mm.modules.r.settings.settings, mm.modules.r.settings.values), ['region']);
      assert.deepStrictEqual(mm.unloads, [], 'never unloaded');
    });

    it('the ceiling: a fixed value applies over the file; one rejected keeps the module whole; untrusted keeps every module', async () => {
      let mm = manager();
      write({'module.w.units': 'imperial', 'module.w.n': 7, 'module.r.region': 'eu'});
      let reply = await reread.reread(mm, {type: 'reread', what: 'module-settings'},
        {ceiling: () => trusted(parsed({moduleSettings: {'w.units': {fixed: 'metric'}}}).ceiling)});
      assert.deepStrictEqual(reply, {applied: 1, refused: []});
      assert.deepStrictEqual(Object.assign({}, mm.modules.w.settings.values), {units: 'metric', n: 7});

      mm = manager();
      const w = mm.modules.w.settings;
      reply = await reread.reread(mm, {type: 'reread', what: 'module-settings'},
        {ceiling: () => trusted(parsed({moduleSettings: {'w.n': {fixed: 50}}}).ceiling)});
      assert.deepStrictEqual(reply.refused, [{name: 'module.w.n', code: 'SETTING_INVALID'}]);
      sameRun(mm.modules.w.settings, w);

      mm = manager();
      const kept = {w: mm.modules.w.settings, r: mm.modules.r.settings};
      reply = await reread.reread(mm, {type: 'reread', what: 'module-settings'},
        {ceiling: () => ({state: 'untrusted', file: '/x', problem: 'p'})});
      assert.deepStrictEqual(reply, {applied: 0, refused: [{name: 'module.w', code: 'SETTING_CEILING_UNTRUSTED'}, {name: 'module.r', code: 'SETTING_CEILING_UNTRUSTED'}]});
      sameRun(mm.modules.w.settings, kept.w);
      sameRun(mm.modules.r.settings, kept.r);
      assert.deepStrictEqual(mm.unloads, []);
    });

    it('a value already not applied in the running state, the same value, holds nothing back; a new bad one does', async () => {
      write({'module.w.units': 'kelvin', 'module.r.region': 'eu'});
      const mm = manager();
      assert.deepStrictEqual(mm.modules.w.settings.notApplied.map((n) => n.setting), ['units'], 'kelvin was not applied at the load');
      write({'module.w.units': 'kelvin', 'module.w.n': 7, 'module.r.region': 'eu'});
      let reply = await reread.reread(mm, {type: 'reread', what: 'module-settings'}, {ceiling: () => ({state: 'none'})});
      assert.deepStrictEqual(reply, {applied: 1, refused: []});
      assert.deepStrictEqual(Object.assign({}, mm.modules.w.settings.values), {units: 'metric', n: 7});
      write({'module.w.units': 'celsius', 'module.w.n': 8, 'module.r.region': 'eu'});
      reply = await reread.reread(mm, {type: 'reread', what: 'module-settings'}, {ceiling: () => ({state: 'none'})});
      assert.deepStrictEqual(reply.refused, [{name: 'module.w.units', code: 'SETTING_INVALID'}]);
      assert.strictEqual(mm.modules.w.settings.values.n, 7, 'kept whole');
    });

    it('made from the state the worker runs with: a reload whose worker failed leaves the old one\'s package.json', async () => {
      const mm = manager();
      // the restart's copy is a newer version's (its spawn failed); the proxy runs the old
      const W2 = pkgOf('w', {other: {type: 'string', default: 'x'}});
      mm.lastSettings.set('w', ms.stateFor('w', W2, {operator: true}));
      write({'module.w.units': 'metric', 'module.r.region': 'eu'});
      await reread.reread(mm, {type: 'reread', what: 'module-settings'}, {ceiling: () => ({state: 'none'})});
      assert.deepStrictEqual(Object.keys(mm.modules.w.settings.settings).sort(), ['n', 'units']);
      assert.strictEqual(mm.modules.w.settings.made.pkg, W);
    });

    it('a refusal\'s notice is in its own words: a fixed value rejected names the ceiling (and a history line); values over 32 KiB do not', async () => {
      const mm = manager();
      const decl = {};
      for (let i = 0; i < 32; i += 1) decl[`s${i}`] = {type: 'string', maxLength: 1024};
      const big = pkgOf('big', decl);
      mm.modules.big = proxy('big');
      mm.modules.big.settings = ms.stateFor('big', big, {operator: true});
      const values = {'module.w.units': 'metric', 'module.r.region': 'eu'};
      for (let i = 0; i < 32; i += 1) values[`module.big.s${i}`] = 'a'.repeat(1024);
      write(values);
      const reply = await reread.reread(mm, {type: 'reread', what: 'module-settings'},
        {ceiling: () => trusted(parsed({moduleSettings: {'w.n': {fixed: 50}}}).ceiling)});
      assert.deepStrictEqual(reply.refused, [{name: 'module.w.n', code: 'SETTING_INVALID'}, {name: 'module.big', code: 'SETTING_INVALID'}]);
      assert.match(notices.take('w').join('\n'), /ceiling fixes a value this version does not accept/);
      const saidBig = notices.take('big').join('\n');
      assert.match(saidBig, /over 32 KiB/);
      assert.ok(!/ceiling/.test(saidBig), saidBig);
      const history = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8');
      assert.match(history, /"setting":"module\.w\.n"[^\n]*not applied/);
    });

    it('a stored name this version does not declare writes no history line at a reread', async () => {
      const mm = manager();
      write({'module.w.units': 'metric', 'module.w.gone': 1, 'module.r.region': 'eu'});
      await reread.reread(mm, {type: 'reread', what: 'module-settings'}, {ceiling: () => ({state: 'none'})});
      const file = path.join(dir, 'history.jsonl');
      const history = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      assert.ok(!/module\.w\.gone/.test(history), history);
    });

    it('a runtime with no --settingsFile: refused whole, and under --moduleSettings saying why', async () => {
      const mm = manager();
      options.settingsFile = null;
      await assert.rejects(reread.reread(mm, {type: 'reread', what: 'module-settings'}, {ceiling: () => ({state: 'none'})}), (e) => e.code === 'CONTROL_FAILED');
      // under --moduleSettings, saying why
      options.moduleSettings = path.join(dir, 'operator.json');
      await assert.rejects(reread.reread(mm, {type: 'reread', what: 'module-settings'}, {ceiling: () => ({state: 'none'})}),
        (e) => e.code === 'CONTROL_FAILED' && /--settingsFile only/.test(e.message) && /--moduleSettings/.test(e.message));
    });

    const rr = (mm, opts = {}) => reread.reread(mm, {type: 'reread', what: 'module-settings'}, Object.assign({ceiling: () => ({state: 'none'})}, opts));

    it('a refused value is said once (recorded as not applied), and blocks no later change; one removed and written back is new again', async () => {
      const mm = manager();
      write({'module.w.units': 'kelvin', 'module.w.n': 7, 'module.r.region': 'eu'});
      assert.deepStrictEqual((await rr(mm)).refused, [{name: 'module.w.units', code: 'SETTING_INVALID'}]);
      notices.take('w');
      const lines = () => fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').filter((l) => /module\.w\.units/.test(l)).length;
      const once = lines();
      // the same file again: no refusal, no second notice or line; n applies
      let reply = await rr(mm);
      assert.deepStrictEqual(reply, {applied: 1, refused: []});
      assert.deepStrictEqual(notices.take('w'), ['w\'s settings changed: n; still not applied: units'], 'the change said; the refusal not again');
      assert.strictEqual(lines(), once);
      assert.strictEqual(mm.modules.w.settings.values.n, 7);
      assert.strictEqual(mm.modules.w.settings.values.units, 'imperial', 'the value it ran with, not the default');
      // never silent: the change is said, with what is still not applied
      const said = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        .filter((h) => h.setting === 'module.w' && /^applied/.test(h.change));
      assert.deepStrictEqual(said.map((h) => h.change), ['applied: n; still not applied: units'], JSON.stringify(said));
      assert.ok(!said.some((h) => 'new' in h || 'kept' in h), 'no value');
      // removed, then written back: refused again
      write({'module.w.n': 7, 'module.r.region': 'eu'});
      await rr(mm);
      write({'module.w.units': 'kelvin', 'module.w.n': 8, 'module.r.region': 'eu'});
      reply = await rr(mm);
      assert.deepStrictEqual(reply.refused, [{name: 'module.w.units', code: 'SETTING_INVALID'}]);
      assert.strictEqual(mm.modules.w.settings.values.n, 7, 'kept whole');
    });

    it('a fixed value refused is the ceiling\'s line in the history, blaming no stored value', async () => {
      const mm = manager();
      write({'module.w.units': 'metric', 'module.w.n': 3, 'module.r.region': 'eu'});
      await rr(mm, {ceiling: () => trusted(parsed({moduleSettings: {'w.n': {fixed: 50}}}).ceiling)});
      const line = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((h) => h.setting === 'module.w.n');
      assert.ok(line != null && /ceiling/.test(line.problem), JSON.stringify(line));
      assert.ok(!('kept' in line) && !('new' in line), JSON.stringify(line));
    });

    it('a part\'s refusal is said on its top-level module, never naming the part; keyed by the friendlyName a result takes, for scoped packages too', async () => {
      const callAddress = require('../../lib/call-address');
      // packages named apart from their friendlyNames
      const PART = pkgOf('@acme/region-part', {region: {type: 'string', maxLength: 4}});
      PART.countinghouse.role = 'part';
      const MID = {name: '@acme/mid', version: '1.0.0', countinghouse: {role: 'part', calls: ['region-part/partService.run']}};
      const TOP = {name: '@acme/hopper', version: '1.0.0', countinghouse: {calls: ['mid/midService.run']}};
      const devices = {'region-part': '@acme/region-part', mid: '@acme/mid', hopper: '@acme/hopper', weather: 'w', regions: 'r'};
      const deviceMap = {};
      const owner = {};
      for (const [friendly, pkg] of Object.entries(devices)) {
        const id = callAddress.deviceIDForName(friendly);
        deviceMap[id] = {spec: {device: {friendlyName: friendly}}};
        owner[id] = pkg;
      }
      const dm = {deviceMap, moduleOfDevice: (id) => owner[id] || null};
      const mm = manager();
      mm.unlisted = new Set(['@acme/region-part', '@acme/mid']);
      mm.manifestPins = {pinnedOf: (n) => ({'@acme/region-part': PART, '@acme/mid': MID, '@acme/hopper': TOP, w: W, r: R})[n] || null};
      mm.modules['@acme/region-part'] = proxy('@acme/region-part');
      mm.modules['@acme/region-part'].settings = ms.stateFor('@acme/region-part', PART, {operator: true});
      mm.modules['@acme/mid'] = proxy('@acme/mid');
      mm.modules['@acme/hopper'] = proxy('@acme/hopper');
      write({'module.w.units': 'kelvin', 'module.w.n': 3, 'module.r.region': 'eu', 'module.@acme/region-part.region': 'toolong'});
      await rr(mm, {dm});
      // two hops down, by the device manager's package for each friendlyName
      const said = notices.take('hopper').join('\n');
      assert.match(said, /a part of @acme\/hopper/);
      assert.ok(!/region/.test(said), said);
      assert.deepStrictEqual(notices.take('@acme/hopper'), [], 'keyed by the friendlyName, as take() reads it');
      // a top-level module's, by its friendlyName too: one notice
      const w = notices.take('weather');
      assert.strictEqual(w.length, 1, JSON.stringify(w));
      assert.match(w[0], /units not applied/);
      notices.take('w');
      // a ceiling that cannot be trusted: its problem is the log's only
      const logged = [];
      await rr(mm, {ceiling: () => ({state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: 'it is owned by uid 1000'}), log: (l) => logged.push(l)});
      const told = notices.take('w').join('\n');
      assert.match(told, /cannot be trusted/);
      assert.ok(!/uid 1000|\/etc/.test(told), told);
      assert.ok(logged.some((l) => /uid 1000/.test(l)), logged.join('\n'));
    });

    it('a restart keeps no value outside the net granted now, and is made from it afterwards', () => {
      const reread_ = require('../../lib/settings-reread');
      const U = pkgOf('u', {api: {type: 'string', format: 'url'}, n: {type: 'integer', default: 1}});
      write({'module.u.api': 'https://api.example.com/v1', 'module.u.n': 2});
      const wide = [{host: 'api.example.com', ports: [443]}];
      const ran = reread_.next('u', {pkg: U, net: wide}, {ceiling: {state: 'none'}}).state;
      assert.strictEqual(ran.values.api, 'https://api.example.com/v1');
      // the restart: the file can no longer be read, and the net was narrowed
      fs.writeFileSync(options.settingsFile, '{not json');
      const r = reread_.next('u', {pkg: U, net: []}, {previous: ran, ceiling: {state: 'none'}, ceilingRefuses: true});
      assert.ok(r.state != null);
      assert.strictEqual(r.state.values.api, undefined, 'outside the net granted now: unset');
      assert.strictEqual(r.state.values.n, 2, 'the rest kept');
      assert.deepStrictEqual(r.state.made.net, [], 'made from the net granted now');
      assert.ok(r.state.version > ran.version);
    });

    it('a restart never writes a load\'s history lines, its previous state set aside or not', () => {
      const reread_ = require('../../lib/settings-reread');
      write({'module.w.units': 'kelvin', 'module.r.region': 'eu'});
      const file = path.join(dir, 'history.jsonl');
      const lines = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter((l) => /no longer valid/.test(l)).length : 0);
      const before = lines();
      // a previous state of another declaration (a failed reload's): set aside
      const other = ms.stateFor('w', pkgOf('w', {z: {type: 'boolean', default: true}}), {operator: false});
      reread_.next('w', {pkg: W, net: []}, {previous: other, ceiling: {state: 'none'}, ceilingRefuses: true});
      assert.strictEqual(lines(), before, 'a restart wrote none');
      reread_.next('w', {pkg: W, net: []}, {load: true, ceiling: {state: 'none'}});
      assert.strictEqual(lines(), before + 1, 'an operator\'s load writes its line');
    });

    it('a restart the ceiling refuses is suspended at once, with the ceiling\'s reason (no crash loop); another failure is retried', () => {
      const reread_ = require('../../lib/settings-reread');
      const {restartFailed} = require('../../lib/module-manager');
      const c = trusted(parsed({moduleSettings: {'w.sharestats': {fixed: false}}}).ceiling);
      const load = reread_.next('w', {pkg: W, net: []}, {ceiling: {state: 'none'}});
      const r = reread_.next('w', {pkg: W, net: []}, {previous: load.state, ceiling: c, ceilingRefuses: true});
      assert.ok(reread_.isCeilingRefusal(r.refusal));
      const calls = [];
      const record = {specs: null};
      const mm = {supervisor: {isCurrent: () => true, suspend: (n, why) => calls.push(['suspend', n, why]),
        exited: () => { calls.push(['exited']); return {action: 'restart', delayMs: 1}; }, status: () => ({exits: []})},
      givenUp: (n, code) => calls.push(['givenUp', n, code])};
      restartFailed(mm, 'w', record, r.refusal);
      assert.deepStrictEqual(calls.map((x) => x[0]), ['suspend', 'givenUp']);
      assert.match(calls[0][2], /moduleSettings "w\.sharestats".*update the ceiling/);
      assert.strictEqual(calls[1][2], 'MODULE_SUSPENDED');
      calls.length = 0;
      restartFailed(mm, 'w', record, new Error('a crash'));
      assert.deepStrictEqual(calls.map((x) => x[0]), ['exited'], 'any other failure: the supervisor\'s retry');
    });

    it('a call\'s package needs the device manager: without one nothing is resolved', () => {
      const reread_ = require('../../lib/settings-reread');
      assert.strictEqual(reread_.calleeOf('region-part/partService.run', null), null);
    });

    it('a part still spawning (no device registered) is found by its pinned device IDs', () => {
      const reread_ = require('../../lib/settings-reread');
      const callAddress = require('../../lib/call-address');
      // the device manager's own lookup, over the manager's pins
      const dm = {deviceMap: {}, moduleManager: {modules: {}, pinnedDevicePackages: new Map([[callAddress.deviceIDForName('region-part'), '@acme/region-part']])}};
      dm.moduleOfDevice = require('../../lib/device-manager').prototype.moduleOfDevice.bind(dm);
      assert.strictEqual(reread_.calleeOf('region-part/partService.run', dm), '@acme/region-part');
    });

    it('a notice is keyed by the friendlyName the module\'s own api.json gives, before its devices register', async () => {
      const mm = manager();
      mm.pinnedFriendlyNames = {w: 'weather'};
      write({'module.w.units': 'kelvin', 'module.w.n': 3, 'module.r.region': 'eu'});
      // no device of w registered: an empty device map
      await rr(mm, {dm: {deviceMap: {}, moduleOfDevice: () => null}});
      assert.strictEqual(notices.take('weather').filter((t) => /units not applied/.test(t)).length, 1);
      assert.deepStrictEqual(notices.take('w'), []);
    });

    it('a module coming up (not in the map yet) takes its state as it registers, by the one rule, from its own pinned package.json and net', async () => {
      const mm = manager();
      const mmLib = require('../../lib/module-manager');
      // w restarting: its spawn made its state before the file changed
      const spawned = ms.stateFor('w', W, {operator: true, net: []});
      delete mm.modules.w;
      write({'module.w.units': 'metric', 'module.w.n': 9, 'module.r.region': 'eu'});
      await rr(mm);
      const wm = proxy('w');
      wm.settings = spawned;
      mm.modules.w = wm;   // registered first, as the module manager does
      mmLib.settleSettings(mm, 'w', wm);
      assert.deepStrictEqual(Object.assign({}, wm.settings.values), {units: 'metric', n: 9});
      assert.strictEqual(mm.lastSettings.get('w'), wm.settings, 'the restart\'s copy too');
      // made from the file as it is: kept as it is
      const fresh = wm.settings;
      const wm2 = proxy('w');
      wm2.settings = fresh;
      mm.modules.w = wm2;   // registered first, as the module manager does
      mmLib.settleSettings(mm, 'w', wm2);
      assert.strictEqual(wm2.settings, fresh);
      // a new version (another declaration): made from its own package.json, never the old state's
      const W2 = pkgOf('w', {units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric'}, extra: {type: 'boolean', default: true}});
      const wm3 = proxy('w');
      wm3.settings = ms.stateFor('w', W2, {operator: true, net: []});
      mm.modules.w = wm3;   // registered first, as the module manager does
      mmLib.settleSettings(mm, 'w', wm3);
      assert.deepStrictEqual(Object.keys(wm3.settings.settings).sort(), ['extra', 'units']);
      assert.strictEqual(wm3.settings.made.pkg, W2);
      // a value refused while it came up: the rule's, as a running sibling's (kept whole, recorded)
      write({'module.w.units': 'kelvin', 'module.w.n': 4, 'module.r.region': 'eu'});
      const wm4 = proxy('w');
      wm4.settings = fresh;
      mm.modules.w = wm4;   // registered first, as the module manager does
      mmLib.settleSettings(mm, 'w', wm4);
      assert.deepStrictEqual(Object.assign({}, wm4.settings.values), {units: 'metric', n: 9}, 'kept whole, as reread keeps it');
    });

    it('a worker registering with a state made under the settings file and ceiling as they are takes it as it is (no second read)', () => {
      const reread_ = require('../../lib/settings-reread');
      const mmLib = require('../../lib/module-manager');
      const mm = manager();
      const made = reread_.next('w', {pkg: W, net: []}, {load: true}).state;
      const wm = proxy('w');
      wm.settings = made;
      mm.modules.w = wm;
      // counted where it reads the file: stateFor
      const real = ms.stateFor;
      let called = 0;
      ms.stateFor = (...a) => { called += 1; return real(...a); };
      try {
        mmLib.settleSettings(mm, 'w', wm);
        assert.strictEqual(called, 0, 'unchanged: not made again');
        write({'module.w.units': 'metric', 'module.r.region': 'eu'});
        mmLib.settleSettings(mm, 'w', wm);
        assert.strictEqual(called, 1, 'the file changed: made again');
        assert.strictEqual(wm.settings.values.units, 'metric');
        // the same ceiling read again (a new object, as on Windows): unchanged
        const before = called;
        mmLib.settleSettings(mm, 'w', wm);
        assert.strictEqual(called, before);
      } finally { ms.stateFor = real; }
    });

    it('next: a load (no previous) is stateFor\'s; a restart under a ceiling refusal refuses (ceilingRefuses); a running module keeps its state', () => {
      const reread_ = require('../../lib/settings-reread');
      const c = trusted(parsed({moduleSettings: {'w.n': {fixed: 50}}}).ceiling);
      const load = reread_.next('w', {pkg: W, net: []}, {ceiling: {state: 'none'}});
      assert.strictEqual(load.refusal, null);
      const restart = reread_.next('w', {pkg: W, net: []}, {previous: load.state, ceiling: c, ceilingRefuses: true});
      assert.strictEqual(restart.state, null);
      assert.match(restart.refusal.message, /ceiling fixes n/);
      const running = reread_.next('w', {pkg: W, net: []}, {previous: load.state, ceiling: c});
      assert.strictEqual(running.state.values, load.state.values);
    });

    it('a refusal of the whole module is said once while it stays the same', async () => {
      const mm = manager();
      const c = () => trusted(parsed({moduleSettings: {'w.n': {fixed: 50}}}).ceiling);
      const lines = () => (fs.existsSync(path.join(dir, 'history.jsonl')) ? fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').filter((l) => /module\.w\.n/.test(l)).length : 0);
      let reply = await rr(mm, {ceiling: c});
      assert.deepStrictEqual(reply.refused, [{name: 'module.w.n', code: 'SETTING_INVALID'}]);
      assert.strictEqual(notices.take('w').length, 1);
      const once = lines();
      reply = await rr(mm, {ceiling: c});
      assert.deepStrictEqual(reply.refused, [{name: 'module.w.n', code: 'SETTING_INVALID'}], 'still refused');
      assert.deepStrictEqual(notices.take('w'), [], 'not said again');
      assert.strictEqual(lines(), once);
    });

    it('a reread\'s shape is the module messages\' (moduleMessageProblem)', async () => {
      await assert.rejects(reread.reread(manager(), {type: 'reread', what: 'everything'}), (e) => e.code === 'CONTROL_FAILED' && /reread names what it reads/.test(e.message));
      await assert.rejects(reread.reread(manager(), null), (e) => e.code === 'CONTROL_FAILED');
    });

    it('the user\'s file unusable: the operator\'s ceiling binds all the same (its fixed values over the running ones), the problem said once, the request refused', async () => {
      const mm = manager();
      fs.writeFileSync(options.settingsFile, '{not json');
      const logged = [];
      const c = () => trusted(parsed({moduleSettings: {'w.units': {fixed: 'metric'}}}).ceiling);
      await assert.rejects(rr(mm, {ceiling: c, log: (l) => logged.push(l)}), (e) => e.code === 'CONTROL_FAILED' && e.fileProblem === true && e.appliedByCeiling === 1 &&
        /the operator's ceiling was applied \(1 module changed\)/.test(e.message));
      assert.strictEqual(mm.modules.w.settings.values.units, 'metric', 'the fixed value binds');
      // never silent: a history line and a notice naming what changed
      const lines = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(lines.some((h) => h.setting === 'module.w' && h.change === 'applied by the operator\'s ceiling: units'), JSON.stringify(lines));
      assert.ok(notices.take('w').some((t) => /changed by the operator's ceiling: units/.test(t)));
      assert.strictEqual(mm.modules.r.settings.values.region, 'eu', 'nothing else changed');
      await assert.rejects(rr(mm, {ceiling: c, log: (l) => logged.push(l)}), (e) => e.appliedByCeiling === 0);
      assert.strictEqual(logged.filter((l) => /only the operator's ceiling is applied/.test(l)).length, 1, 'said once');
      // and each module's: once, named in what was refused
      assert.strictEqual(logged.filter((l) => /^module settings: w: the settings file cannot be read/.test(l)).length, 1, 'w\'s said once');
    });

    it('one ceiling rule: any caller of next() with the file unreadable takes the ceiling\'s fixed values (a registration too)', () => {
      const reread_ = require('../../lib/settings-reread');
      const ran = reread_.next('w', {pkg: W, net: []}, {load: true, ceiling: {state: 'none'}}).state;
      fs.writeFileSync(options.settingsFile, '{not json');
      const r = reread_.next('w', {pkg: W, net: []}, {previous: ran, ceiling: trusted(parsed({moduleSettings: {'w.n': {fixed: 5}}}).ceiling)});
      assert.ok(r.applied);
      assert.strictEqual(r.state.values.n, 5, 'the new fixed value binds though the file cannot be read');
      assert.strictEqual(r.state.values.units, ran.values.units, 'nothing else changed');
    });

    it('the file unreadable: a restart (ceilingRefuses) under a rejected fixed value is refused, marked the ceiling\'s; a running module says it once but always names it', () => {
      const reread_ = require('../../lib/settings-reread');
      const ran = reread_.next('w', {pkg: W, net: []}, {load: true, ceiling: {state: 'none'}}).state;
      fs.writeFileSync(options.settingsFile, '{not json');
      const bad = trusted(parsed({moduleSettings: {'w.n': {fixed: 500}}}).ceiling);
      const restart = reread_.next('w', {pkg: W, net: []}, {previous: ran, ceiling: bad, ceilingRefuses: true});
      assert.strictEqual(restart.state, null);
      assert.ok(reread_.isCeilingRefusal(restart.refusal));
      const a = reread_.next('w', {pkg: W, net: []}, {previous: ran, ceiling: bad});
      const b = reread_.next('w', {pkg: W, net: []}, {previous: a.state, ceiling: bad});
      assert.deepStrictEqual(b.refused.map((r) => r.code), ['SETTING_INVALID', 'SETTING_NOT_APPLIED'], 'said already, still in the reply');
    });

    it('a refusal said while the file is unreadable is cleared by a success, so a later one is said again', () => {
      const reread_ = require('../../lib/settings-reread');
      const ran = reread_.next('w', {pkg: W, net: []}, {load: true, ceiling: {state: 'none'}}).state;
      fs.writeFileSync(options.settingsFile, '{not json');
      const lines = [];
      const bad = trusted(parsed({moduleSettings: {'w.n': {fixed: 500}}}).ceiling);
      const a = reread_.next('w', {pkg: W, net: []}, {previous: ran, ceiling: bad, log: (l) => lines.push(l)});
      const b = reread_.next('w', {pkg: W, net: []}, {previous: a.state, ceiling: bad, log: (l) => lines.push(l)});
      assert.strictEqual(lines.filter((l) => /does not accept/.test(l)).length, 1, 'said once');
      const ok = reread_.next('w', {pkg: W, net: []}, {previous: b.state, ceiling: {state: 'none'}, log: (l) => lines.push(l)});
      reread_.next('w', {pkg: W, net: []}, {previous: ok.state, ceiling: bad, log: (l) => lines.push(l)});
      assert.strictEqual(lines.filter((l) => /does not accept/.test(l)).length, 2, 'said again after a success');
    });

    it('a reread refused for its file carries the stamp taken before the read (the watch compares that)', async () => {
      const mm = manager();
      fs.writeFileSync(options.settingsFile, '{not json');
      let stamp = null;
      await assert.rejects(rr(mm), (e) => { stamp = e.stamp; return e.fileProblem === true; });
      assert.ok(typeof(stamp) === 'string' && stamp.includes(options.settingsFile), String(stamp));
    });

    it('a ceiling that cannot be read when a state is made binds as untrusted, never a throw', () => {
      const reread_ = require('../../lib/settings-reread');
      const tool = require('../../lib/settings-tool');
      const saved3 = options.settingsTool;
      options.settingsTool = true;
      tool.ceilingForControl(() => { throw Object.assign(new Error('EIO'), {code: 'EIO'}); });
      try {
        const ran = ms.stateFor('w', W, {operator: true});
        let r = null;
        assert.doesNotThrow(() => { r = reread_.settle({modules: {}}, 'w', ran); });
        assert.ok(r != null);
      } finally {
        options.settingsTool = saved3;
        tool.ceilingForControl(() => tool.cachedCeiling(() => require('../../lib/settings-ceiling').readCeiling()));
      }
    });

    it('refused whole, nothing changed: another "what", or a settings file that cannot be read', async () => {
      const mm = manager();
      const w = mm.modules.w.settings;
      await assert.rejects(reread.reread(mm, {type: 'reread', what: 'everything'}, {ceiling: () => ({state: 'none'})}), (e) => e.code === 'CONTROL_FAILED');
      fs.writeFileSync(options.settingsFile, '{not json');
      await assert.rejects(reread.reread(mm, {type: 'reread', what: 'module-settings'}, {ceiling: () => ({state: 'none'})}), (e) => e.code === 'CONTROL_FAILED' && /settings file/.test(e.message));
      sameRun(mm.modules.w.settings, w);
    });
  });

  describe('a ceiling that changed is told (lib/settings-tool.js onCeilingChange)', () => {
    const tool = require('../../lib/settings-tool');
    after(() => tool.resetForTests());
    it('once per change, never for the first read or the same ceiling again', () => {
      tool.resetForTests();
      const seen = [];
      const stop = tool.onCeilingChange((c) => seen.push(c));
      let t = 0;
      let value = {state: 'none'};
      // win32's age rule makes every read past it stale
      const read = (v) => tool.cachedCeiling(() => v, {platform: 'win32', now: () => t});
      read(value);
      t += 10 * 60 * 1000; read(value);
      assert.deepStrictEqual(seen, [], 'the first read, then the same ceiling');
      value = trusted(parsed({moduleSettings: {'w.units': {fixed: 'metric'}}}).ceiling);
      t += 10 * 60 * 1000; read(value);
      assert.strictEqual(seen.length, 1);
      stop();
    });
  });

  describe('the ceiling watched for the modules\' settings (ceilingWatcher)', () => {
    const reread_ = require('../../lib/settings-reread');
    let dir2 = null;
    let saved2 = null;
    before(() => {
      dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-validation-29w-'));
      saved2 = {settingsFile: options.settingsFile};
      options.settingsFile = path.join(dir2, 'settings.json');
      fs.writeFileSync(options.settingsFile, JSON.stringify({version: 1, values: {}}));
    });
    after(() => { Object.assign(options, saved2); fs.rmSync(dir2, {recursive: true, force: true}); });

    it('rereads only for a change of its moduleSettings or of its trust; a failure is said once, and retried', async () => {
      const queued = [];
      const lines = [];
      const timers = [];
      const base = parsed({maxOutputBytes: 1048576}).ceiling;
      const listen = reread_.ceilingWatcher({modules: {}}, {enqueue: (fn) => queued.push(fn), now: () => trusted(base),
        log: (l) => lines.push(l), later: (fn) => { timers.push(fn); return 1; }});
      listen(trusted(parsed({maxOutputBytes: 2097152}).ceiling));
      assert.strictEqual(queued.length, 0, 'the caps changed only: no reread');
      listen(trusted(parsed({maxOutputBytes: 2097152, moduleSettings: {'w.units': {fixed: 'metric'}}}).ceiling));
      listen(trusted(parsed({maxOutputBytes: 2097152, moduleSettings: {'w.units': {fixed: 'imperial'}}}).ceiling));
      assert.strictEqual(queued.length, 1, 'one waits at a time');
      await queued.shift()();
      assert.ok(lines.some((l) => /re-read \(0 applied/.test(l)), lines.join('\n'));
      listen({state: 'untrusted', file: '/x', problem: 'p'});
      assert.strictEqual(queued.length, 1, 'trust changed: a reread');
      // the settings file mid-write: its stamp watched, read again once it changes
      fs.writeFileSync(options.settingsFile, '{not json');
      await queued.shift()();
      assert.strictEqual(timers.length, 1);
      timers.shift()();
      assert.strictEqual(queued.length, 0, 'unchanged: not read again');
      assert.strictEqual(timers.length, 1, 'still watched');
      assert.ok(!lines.some((l) => /re-read failed/.test(l)), 'reread said it; the watcher says nothing more');
      // fixed by hand: read again, and the watch stops
      fs.writeFileSync(options.settingsFile, JSON.stringify({version: 1, values: {}}));
      timers.shift()();
      assert.strictEqual(queued.length, 1);
      await queued.shift()();
      assert.ok(/re-read \(/.test(lines[lines.length - 1]), lines.join('\n'));
      assert.strictEqual(timers.length, 0);
      // a failure that would last (no --settingsFile): said, never retried
      const file = options.settingsFile;
      options.settingsFile = null;
      listen(trusted(parsed({moduleSettings: {'w.units': {fixed: 'metric'}}}).ceiling));
      await queued.shift()();
      options.settingsFile = file;
      assert.strictEqual(timers.length, 0, 'not retried');
      assert.match(lines[lines.length - 1], /no --settingsFile/);
    });
  });
});

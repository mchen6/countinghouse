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
const {EventEmitter} = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
const settingsTool = require('../../lib/settings-tool');
const ms = require('../../lib/module-settings');
const ceilingLib = require('../../lib/settings-ceiling');
const sessions = require('../../lib/sessions');
const confirmLib = require('../../lib/settings-confirm');

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
  const make = (extra = {}) => settingsTool.create(Object.assign({file, lockWaitMs: 200, ceiling: () => ceiling,
    moduleStates: () => modules, applyModuleSettings: async (pkg) => { applied += 1; reapply(pkg); return {applied: 1, refused: []}; }}, extra));
  // what a reread of one module does: its state made again from the file
  const reapply = (pkg) => {
    modules = modules.map((m) => (m.name === pkg && m.pkg != null ? Object.assign({}, m, {state: ms.stateFor(m.name, m.pkg, {operator: false, net: []})}) : m));
  };
  // a client that may show a form (a tested one, its conditions met)
  const formClient = {mayElicit: async () => ({ok: true, client: {name: 'tested-client', version: '1.0.0'}})};
  const loadedWith = (values) => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values}));
    modules = [{name: W.name, version: W.version, part: false, pkg: W, state: ms.stateFor(W.name, W, {operator: false, net: []})},
      {name: P.name, version: P.version, part: true, state: ms.stateFor(P.name, P, {operator: false, net: []})}];
  };

  before(() => { saved = {settingsFile: options.settingsFile}; });
  after(() => Object.assign(options, saved));
  beforeEach(() => {
    require('../../lib/settings-confirm').resetForTests();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-validation-30-'));
    file = path.join(home, 'settings.json');
    options.settingsFile = file;
    applied = 0;
    ceiling = {state: 'none'};
    loadedWith({'module.@acme/weather-tool.units': 'imperial', 'other.kept': 1});
  });
  afterEach(() => { sessions.resetForTests(); fs.rmSync(home, {recursive: true, force: true}); });
  // a shared runtime with these sessions open (as sessions 21 opens them):
  // id -> the session, whose 'end' closes it. One registry for the file
  // (attach registers its listeners once per registry; nothing leaks into
  // the files CI runs after this one in the same process)
  const reg = new EventEmitter();
  const openShared = (...ids) => {
    sessions.attach(reg);
    const out = {};
    for (const id of ids) {
      const s = new EventEmitter();
      Object.assign(s, {id, client: {status: 'ok', conditions: 'yes', repo: null}, notify: () => {}});
      reg.emit('session', s);
      out[id] = s;
    }
    return out;
  };
  const sharedClient = {sessionClient: () => ({ok: true, client: {name: 'tested-client', version: '1.0.0'}})};

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

    it('during startup it says some modules may not be listed yet', async () => {
      assert.strictEqual((await make({startingUp: () => true}).get()).starting, 'still starting: some modules may not be listed yet');
      assert.strictEqual((await make({startingUp: () => false}).get()).starting, undefined);
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
      assert.strictEqual(second.settings.length, 26, 'a later page: the module rows alone');
      assert.strictEqual(second.history, undefined);
      assert.strictEqual(second.nextCursor, undefined);
      assert.strictEqual(new Set([...firstRows, ...secondRows].map((s) => s.name)).size, 90);
      await refused(tool.get({}, {cursor: 'not-a-cursor'}), 'SETTING_CURSOR_INVALID');
      // checked before the file and the ceiling are read
      fs.writeFileSync(file, '{not json');
      let read = 0;
      await refused(make({ceiling: () => { read += 1; return ceiling; }}).get({}, {cursor: 'not-a-cursor'}), 'SETTING_CURSOR_INVALID');
      assert.strictEqual(read, 0);
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

  describe('the form, for a client that may show one', () => {
    const accept = {approve: {action: 'accept', content: {approve: true}}};
    const decline = {approve: {action: 'decline'}};

    it('the runtime\'s sentence: the package and version, the key, the values quoted, the author\'s title as the module\'s words; a yes writes it, its version confirmed', async () => {
      const tool = make(formClient);
      const ctx = {session: 'form-1'};
      const asked = await tool.set('module.@acme/weather-tool.defaultRepo', 'acme/repo', 'settings tool', ctx);
      assert.ok(asked.inputRequired != null, JSON.stringify(asked));
      const message = asked.inputRequired.inputRequests.approve.params.message;
      assert.match(message, /@acme\/weather-tool 1\.2\.0's setting defaultRepo from "" to "acme\/repo"\?/);
      assert.match(message, /every session of this user/);
      assert.match(message, /in its own words, as: "Default repository"/);
      assert.strictEqual(applied, 0, 'nothing applied before the answer');
      const done = await tool.confirm('module.@acme/weather-tool.defaultRepo', 'acme/repo', {requestState: asked.inputRequired.requestState, inputResponses: accept}, ctx);
      assert.strictEqual(done.applies, 'now');
      assert.strictEqual(stored()['module.@acme/weather-tool.defaultRepo'], 'acme/repo');
      assert.ok(history().some((h) => h.setting === 'module.@acme/weather-tool.defaultRepo' && h.confirmed === '1.2.0'), JSON.stringify(history()));
      assert.strictEqual(applied, 1);
    });

    it('a decline writes nothing and locks the kind for this start: a second asks at the terminal', async () => {
      const tool = make(formClient);
      const ctx = {session: 'form-2'};
      const asked = await tool.set('module.@acme/weather-tool.shareStats', 'on', 'settings tool', ctx);
      const done = await tool.confirm('module.@acme/weather-tool.shareStats', 'on', {requestState: asked.inputRequired.requestState, inputResponses: decline}, ctx);
      assert.strictEqual(done.applies, 'declined');
      assert.strictEqual(stored()['module.@acme/weather-tool.shareStats'], undefined);
      await refused(tool.set('module.@acme/weather-tool.defaultRepo', 'acme/x', 'settings tool', ctx), 'SETTING_MODULE_NEEDS_CONFIRMATION');
    });

    it('the module at another version when the answer comes: SETTING_CHANGED_MEANWHILE, nothing written', async () => {
      const tool = make(formClient);
      const ctx = {session: 'form-3'};
      const asked = await tool.set('module.@acme/weather-tool.defaultRepo', 'acme/repo', 'settings tool', ctx);
      modules[0] = Object.assign({}, modules[0], {version: '1.3.0'});
      await refused(tool.confirm('module.@acme/weather-tool.defaultRepo', 'acme/repo', {requestState: asked.inputRequired.requestState, inputResponses: accept}, ctx), 'SETTING_CHANGED_MEANWHILE');
      assert.strictEqual(stored()['module.@acme/weather-tool.defaultRepo'], undefined);
    });
  });

  describe('the session\'s budget', () => {
    it('a shared runtime session\'s changes on request count against its 32; past them, the terminal', async () => {
      const tool = make();
      const ctx = {shared: true, session: 'budget-1'};
      for (let i = 0; i < 32; i += 1) await tool.set('module.@acme/weather-tool.maxResults', String(10 + i), 'settings tool', ctx);
      await refused(tool.set('module.@acme/weather-tool.maxResults', '99', 'settings tool', ctx), 'SETTING_MODULE_NEEDS_CONFIRMATION');
      // another session's are its own
      await tool.set('module.@acme/weather-tool.maxResults', '98', 'settings tool', {shared: true, session: 'budget-2'});
    });
  });

  describe('the form, checked again', () => {
    const accept = {approve: {action: 'accept', content: {approve: true}}};
    const decline = {approve: {action: 'decline'}};

    it('a retry with no answer gets the module\'s own form again', async () => {
      const tool = make(formClient);
      const ctx = {session: 'again-1'};
      const asked = await tool.set('module.@acme/weather-tool.defaultRepo', 'acme/repo', 'settings tool', ctx);
      const again = await tool.confirm('module.@acme/weather-tool.defaultRepo', 'acme/repo', {requestState: asked.inputRequired.requestState}, ctx);
      assert.match(again.inputRequired.inputRequests.approve.params.message, /setting defaultRepo from "" to "acme\/repo"/);
    });

    it('an Allow after the ceiling made the setting terminal-only writes nothing', async () => {
      const tool = make(formClient);
      const ctx = {session: 'again-2'};
      const asked = await tool.set('module.@acme/weather-tool.defaultRepo', 'acme/repo', 'settings tool', ctx);
      ceiling = trusted({moduleSettings: {conversation: false}});
      await refused(tool.confirm('module.@acme/weather-tool.defaultRepo', 'acme/repo', {requestState: asked.inputRequired.requestState, inputResponses: accept}, ctx), 'SETTING_MODULE_NEEDS_CONFIRMATION');
      assert.strictEqual(stored()['module.@acme/weather-tool.defaultRepo'], undefined);
    });

    it('a shared runtime\'s session: its own store, so a decline locks that session only', async () => {
      const sessions = require('../../lib/sessions');
      const real = sessions.askConditions;
      sessions.askConditions = async () => ({status: 'ok', conditions: 'yes'});
      try {
        openShared('shared-form-1', 'shared-form-2');
        const tool = make(sharedClient);
        const s1 = {shared: true, session: 'shared-form-1'};
        const s2 = {shared: true, session: 'shared-form-2'};
        const asked = await tool.set('module.@acme/weather-tool.shareStats', 'on', 'settings tool', s1);
        assert.ok(asked.inputRequired != null, JSON.stringify(asked));
        await tool.confirm('module.@acme/weather-tool.shareStats', 'on', {requestState: asked.inputRequired.requestState, inputResponses: decline}, s1);
        await refused(tool.set('module.@acme/weather-tool.defaultRepo', 'acme/x', 'settings tool', s1), 'SETTING_MODULE_NEEDS_CONFIRMATION');
        const other = await tool.set('module.@acme/weather-tool.defaultRepo', 'acme/x', 'settings tool', s2);
        assert.ok(other.inputRequired != null, 'another session is asked: its own store');
        assert.ok(history().filter((h) => h.setting && h.setting.startsWith('module.')).every((h) => h.session != null), 'every line names its session');
      } finally { sessions.askConditions = real; }
    });

    // (the reviewer's high review of #436)
    const withConditions = async (fn) => {
      const real = sessions.askConditions;
      sessions.askConditions = async () => ({status: 'ok', conditions: 'yes'});
      try { return await fn(); } finally { sessions.askConditions = real; }
    };

    it('a yes after the user\'s window locked module settings (three declined elsewhere) writes nothing', () => withConditions(async () => {
      openShared('win-1');
      const tool = make(sharedClient);
      const ctx = {shared: true, session: 'win-1'};
      const asked = await tool.set('module.@acme/weather-tool.defaultRepo', 'acme/repo', 'settings tool', ctx);
      for (let i = 0; i < 3; i += 1) confirmLib.userWindow().note('module');
      await refused(tool.confirm('module.@acme/weather-tool.defaultRepo', 'acme/repo', {requestState: asked.inputRequired.requestState, inputResponses: accept}, ctx), 'SETTING_MODULE_NEEDS_CONFIRMATION');
      assert.strictEqual(stored()['module.@acme/weather-tool.defaultRepo'], undefined);
      assert.ok(history().some((h) => /too many declined or unanswered forms of module settings/.test(h.change)), JSON.stringify(history()));
      assert.strictEqual(applied, 0);
    }));

    it('a session that ended while its client was asked: MODULE_NOT_LISTED, nothing written, counted or kept', () => withConditions(async () => {
      const open = openShared('gone-1', 'gone-2');
      let ending = null;
      const tool = make({sessionClient: (ctx) => {
        if (ending === ctx.session) open[ctx.session].emit('end', 'closed');
        return {ok: true, client: {name: 'tested-client', version: '1.0.0'}};
      }});
      // the form: the session ends while its conditions are asked
      ending = 'gone-1';
      await refused(tool.set('module.@acme/weather-tool.defaultRepo', 'acme/repo', 'settings tool', {shared: true, session: 'gone-1'}), 'MODULE_NOT_LISTED');
      // the answer: the session ends while its conditions are asked again
      ending = null;
      const ctx = {shared: true, session: 'gone-2'};
      const asked = await tool.set('module.@acme/weather-tool.defaultRepo', 'acme/repo', 'settings tool', ctx);
      ending = 'gone-2';
      await refused(tool.confirm('module.@acme/weather-tool.defaultRepo', 'acme/repo', {requestState: asked.inputRequired.requestState, inputResponses: accept}, ctx), 'MODULE_NOT_LISTED');
      assert.strictEqual(stored()['module.@acme/weather-tool.defaultRepo'], undefined);
      assert.strictEqual(applied, 0);
      const lines = fs.existsSync(path.join(home, 'history.jsonl')) ? history() : [];
      assert.ok(!lines.some((h) => h.change === 'all sessions (a module setting)'), 'nothing written');
    }));

    it('a re-check that refuses still uses the form up and is recorded; a decline locks even when a re-check would refuse', async () => {
      const tool = make(formClient);
      const ctx = {session: 'verify-1'};
      const asked = await tool.set('module.@acme/weather-tool.defaultRepo', 'acme/repo', 'settings tool', ctx);
      ceiling = trusted({moduleSettings: {'@acme/weather-tool.defaultRepo': {fixed: 'acme/fixed'}}});
      await refused(tool.confirm('module.@acme/weather-tool.defaultRepo', 'acme/repo', {requestState: asked.inputRequired.requestState, inputResponses: accept}, ctx), 'SETTING_FIXED_BY_CEILING');
      assert.ok(history().some((h) => h.setting === 'module.@acme/weather-tool.defaultRepo' && /SETTING_FIXED_BY_CEILING/.test(h.change)), JSON.stringify(history()));
      ceiling = {state: 'none'};
      await refused(tool.confirm('module.@acme/weather-tool.defaultRepo', 'acme/repo', {requestState: asked.inputRequired.requestState, inputResponses: accept}, ctx), 'SETTING_CONFIRMATION_USED');
      // a decline, the ceiling refusing meanwhile: still a decline, still locked
      const again = await tool.set('module.@acme/weather-tool.shareStats', 'on', 'settings tool', {session: 'verify-2'});
      ceiling = trusted({moduleSettings: {'@acme/weather-tool.shareStats': {fixed: false}}});
      const done = await tool.confirm('module.@acme/weather-tool.shareStats', 'on', {requestState: again.inputRequired.requestState, inputResponses: decline}, {session: 'verify-2'});
      assert.strictEqual(done.applies, 'declined');
      ceiling = {state: 'none'};
      await refused(tool.set('module.@acme/weather-tool.maxResults', '7', 'settings tool', {session: 'verify-2'}).then(() => tool.set('module.@acme/weather-tool.defaultRepo', 'acme/x', 'settings tool', {session: 'verify-2'})), 'SETTING_MODULE_NEEDS_CONFIRMATION');
    });

    it('a shared session\'s form whose time ran out: one expired line, not two', () => withConditions(async () => {
      openShared('exp-1');
      const tool = make(sharedClient);
      const ctx = {shared: true, session: 'exp-1'};
      const asked = await tool.set('module.@acme/weather-tool.defaultRepo', 'acme/repo', 'settings tool', ctx);
      const store = confirmLib.confirmations('exp-1');
      const realNow = store.now;
      store.now = () => realNow.call(store) + confirmLib.TTL_MS + 1000;
      try {
        await refused(tool.confirm('module.@acme/weather-tool.defaultRepo', 'acme/repo', {requestState: asked.inputRequired.requestState, inputResponses: accept}, ctx), 'SETTING_CONFIRMATION_EXPIRED');
      } finally { store.now = realNow; }
      // the session's next call says what its store queued: still one line
      await tool.set('module.@acme/weather-tool.shareStats', 'on', 'settings tool', ctx);
      assert.strictEqual(history().filter((h) => h.change === 'expired').length, 1, JSON.stringify(history()));
    }));

    it('a module setting\'s change in a session is every session\'s line, naming no session to readers', async () => {
      const tool = make();
      await tool.set('module.@acme/weather-tool.units', 'metric', 'settings tool', {shared: true, session: 'lines-1'});
      const line = history().find((h) => h.setting === 'module.@acme/weather-tool.units');
      assert.strictEqual(line.session, 'lines-1');
      // the marker in its own field; no change label (a real change, as
      // ch-local's outside-edits replays one)
      assert.strictEqual(line.scope, 'every session');
      assert.strictEqual(line.change, undefined);
      // a reader that is not that session (here the runtime's own) sees it
      const seen = (await tool.get()).history;
      assert.ok(seen.some((h) => h.setting === 'module.@acme/weather-tool.units' && h.new === 'metric'), JSON.stringify(seen));
      assert.ok(seen.every((h) => h.session === undefined), 'no session id shown');
    });

    it('each module setting refused at the terminal is its own line (counted per setting, not under the first)', async () => {
      const tool = make();
      await refused(tool.set('module.@acme/weather-tool.defaultRepo', 'acme/repo'), 'SETTING_MODULE_NEEDS_CONFIRMATION');
      await refused(tool.set('module.@acme/weather-tool.shareStats', 'on'), 'SETTING_MODULE_NEEDS_CONFIRMATION');
      const names = history().map((h) => h.setting);
      assert.ok(names.includes('module.@acme/weather-tool.defaultRepo') && names.includes('module.@acme/weather-tool.shareStats'), JSON.stringify(history()));
    });

    it('a value refused when it is applied (the module reloaded, the ceiling changed): said as not applied, never applies now', async () => {
      let asked = null;
      const tool = make({applyModuleSettings: async (pkg) => { asked = pkg; return {applied: 0, refused: [{name: 'module.@acme/weather-tool.units', code: 'SETTING_INVALID'}]}; }});
      const done = await tool.set('module.@acme/weather-tool.units', 'metric');
      assert.strictEqual(asked, '@acme/weather-tool', 'only the module whose value changed');
      assert.deepStrictEqual({applies: done.applies, refused: done.refused, kept: done.kept},
        {applies: 'not applied', refused: {setting: 'module.@acme/weather-tool.units', code: 'SETTING_INVALID'}, kept: undefined});
    });

    it('another setting of the module refused at the apply: that one named, and the module kept its values', async () => {
      const tool = make({applyModuleSettings: async () => ({applied: 0, refused: [{name: 'module.@acme/weather-tool.maxResults', code: 'SETTING_INVALID'}]})});
      const done = await tool.set('module.@acme/weather-tool.units', 'metric');
      assert.deepStrictEqual({applies: done.applies, refused: done.refused, kept: done.kept},
        {applies: 'not applied', refused: {setting: 'module.@acme/weather-tool.maxResults', code: 'SETTING_INVALID'}, kept: 'the module kept all of its values'});
    });

    it('applied first by another reread (this one\'s count 0): what runs decides, so it applies now', async () => {
      const tool = make({applyModuleSettings: async (pkg) => { reapply(pkg); return {applied: 0, refused: []}; }});
      assert.strictEqual((await tool.set('module.@acme/weather-tool.units', 'metric')).applies, 'now');
    });

    it('a write whose rename fails: the "not made" line is every session\'s, as the change it undoes', async () => {
      const real = fs.renameSync;
      fs.renameSync = () => { throw Object.assign(new Error('no'), {code: 'EACCES'}); };
      try {
        await refused(make().set('module.@acme/weather-tool.units', 'metric', 'settings tool', {shared: true, session: 'rename-1'}), 'SETTINGS_FILE_INVALID');
      } finally { fs.renameSync = real; }
      const lines = history().filter((h) => h.setting === 'module.@acme/weather-tool.units');
      assert.deepStrictEqual(lines.map((h) => [h.change, h.scope, h.session]), [[undefined, 'every session', 'rename-1'], ['not made', 'every session', 'rename-1']]);
      const seen = (await make().get()).history.filter((h) => h.setting === 'module.@acme/weather-tool.units');
      assert.strictEqual(seen.length, 2, 'another reader sees both');
    });

    it('a decline after the module reloaded with another declaration: verified as staged, recorded, and it locks', async () => {
      const tool = make(formClient);
      const ctx = {session: 'reload-decl'};
      const asked = await tool.set('module.@acme/weather-tool.shareStats', 'on', 'settings tool', ctx);
      const W2 = pkgOf('@acme/weather-tool', Object.assign({}, W.countinghouse.settings, {shareStats: {type: 'string'}}));
      W2.version = '1.3.0';
      modules[0] = {name: W2.name, version: W2.version, part: false, pkg: W2, state: ms.stateFor(W2.name, W2, {operator: false, net: []})};
      const done = await tool.confirm('module.@acme/weather-tool.shareStats', 'on', {requestState: asked.inputRequired.requestState, inputResponses: decline}, ctx);
      assert.strictEqual(done.applies, 'declined');
      assert.ok(history().some((h) => h.setting === 'module.@acme/weather-tool.shareStats' && h.change === 'declined'), JSON.stringify(history()));
      await refused(tool.set('module.@acme/weather-tool.defaultRepo', 'acme/x', 'settings tool', ctx), 'SETTING_MODULE_NEEDS_CONFIRMATION');
    });

    it('a lock that comes while the client\'s conditions are asked is still checked: nothing written', async () => {
      openShared('late-lock');
      const real = sessions.askConditions;
      try {
        sessions.askConditions = async () => ({status: 'ok', conditions: 'yes'});
        const tool = make(sharedClient);
        const ctx = {shared: true, session: 'late-lock'};
        const asked = await tool.set('module.@acme/weather-tool.defaultRepo', 'acme/repo', 'settings tool', ctx);
        // three declined elsewhere while this answer's conditions are asked
        sessions.askConditions = async () => { for (let i = 0; i < 3; i += 1) confirmLib.userWindow().note('module'); return {status: 'ok', conditions: 'yes'}; };
        await refused(tool.confirm('module.@acme/weather-tool.defaultRepo', 'acme/repo', {requestState: asked.inputRequired.requestState, inputResponses: accept}, ctx), 'SETTING_MODULE_NEEDS_CONFIRMATION');
        assert.strictEqual(stored()['module.@acme/weather-tool.defaultRepo'], undefined);
      } finally { sessions.askConditions = real; }
    });

    it('a late answer for a session that has ended: MODULE_NOT_LISTED, before its store is made or told', async () => {
      const tool = make(sharedClient);
      const before = confirmLib.held();
      await refused(tool.confirm('module.@acme/weather-tool.defaultRepo', 'acme/repo', {requestState: 'x.y', inputResponses: accept}, {shared: true, session: 'never-open'}), 'MODULE_NOT_LISTED');
      assert.strictEqual(confirmLib.held(), before, 'no store made for it');
    });

    it('an apply that waits too long on the control channel: written, applied at the next re-read', async () => {
      const tool = make({applyWaitMs: 50, applyModuleSettings: () => new Promise(() => {})});
      const done = await tool.set('module.@acme/weather-tool.units', 'metric');
      assert.strictEqual(done.applies, 'next re-read');
      assert.strictEqual(stored()['module.@acme/weather-tool.units'], 'metric');
    });

    it('a change that nothing applied (the module gone meanwhile): written, never applies now', async () => {
      const tool = make({applyModuleSettings: async () => ({applied: 0, refused: []})});
      assert.strictEqual((await tool.set('module.@acme/weather-tool.units', 'metric')).applies, 'next re-read');
    });

    it('a flood of module-setting refusals: at most 8 lines a window for a session, the rest one "and N more" line; a new window has room again', async () => {
      const decl = {pick: {type: 'enum', values: ['a', 'b'], default: 'a'}};
      for (let i = 0; i < 11; i += 1) decl[`s${i}`] = {type: 'string'};
      const many = pkgOf('many-tool', decl);
      modules.push({name: many.name, version: many.version, part: false, pkg: many, state: ms.stateFor(many.name, many, {operator: false, net: []})});
      openShared('flood-1', 'flood-2');
      let now = 1000000;
      const tool = make({clock: () => now});
      const ctx = {shared: true, session: 'flood-1'};
      for (let i = 0; i < 11; i += 1) await refused(tool.set(`module.many-tool.s${i}`, 'x', 'settings tool', ctx), 'SETTING_MODULE_NEEDS_CONFIRMATION');
      // asked again: counted on its own line's group, never another line
      await refused(tool.set('module.many-tool.s0', 'y', 'settings tool', ctx), 'SETTING_MODULE_NEEDS_CONFIRMATION');
      const own = () => history().filter((h) => typeof(h.setting) === 'string' && h.setting.startsWith('module.many-tool.s') && h.asked !== undefined);
      assert.strictEqual(own().length, 8, JSON.stringify(history()));
      // a write: the counts are written, the rest as one line
      await tool.set('module.many-tool.pick', 'b', 'settings tool', ctx);
      const more = history().filter((h) => h.setting === 'module settings');
      assert.deepStrictEqual(more.map((h) => [h.change, h.count, h.session]), [['... and 3 more module settings refused', 3, 'flood-1']]);
      // another session has its own room
      await refused(tool.set('module.many-tool.s10', 'x', 'settings tool', {shared: true, session: 'flood-2'}), 'SETTING_MODULE_NEEDS_CONFIRMATION');
      assert.ok(history().some((h) => h.setting === 'module.many-tool.s10' && h.session === 'flood-2'));
      // a new window: room again
      now += confirmLib.WINDOW_MS + 1;
      await refused(tool.set('module.many-tool.s9', 'x', 'settings tool', ctx), 'SETTING_MODULE_NEEDS_CONFIRMATION');
      assert.ok(history().some((h) => h.setting === 'module.many-tool.s9' && h.session === 'flood-1'));
    });

    it('the budget binds the form too: a session past its 32 is not asked', async () => {
      const tool = make(formClient);
      const ctx = {shared: true, session: 'budget-form'};
      for (let i = 0; i < 32; i += 1) await tool.set('module.@acme/weather-tool.maxResults', String(10 + i), 'settings tool', ctx);
      await refused(tool.set('module.@acme/weather-tool.defaultRepo', 'acme/repo', 'settings tool', ctx), 'SETTING_MODULE_NEEDS_CONFIRMATION');
    });
  });
});

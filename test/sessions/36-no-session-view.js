'use strict';
// M5a (module-level configuration, #413 rev 3, sections 5.4 and 5.5): the
// per-session layer goes. No session lists or hides a module for itself: a
// loaded module is listed to every session, and the one set of modules going
// on or off (lib/module-visibility.js) is all that hides one, for everyone.
// A pack's on/off is never a session's own: a session's override, an
// exported state row and a restore row name the two caps only. In-process.
const assert = require('assert');
const {EventEmitter} = require('events');

describe('sessions 36: no session view (M5a)', () => {
  const visibility = require('../../lib/module-visibility');
  const sessions = require('../../lib/sessions');
  const MODULES = {'dev-a': 'mod-a', 'dev-b': 'mod-b'};
  const reg = new EventEmitter();
  const open = (...ids) => {
    sessions.attach(reg);
    for (const id of ids) {
      const s = new EventEmitter();
      Object.assign(s, {id, client: {status: 'ok', conditions: 'yes', repo: null}, notify: () => {}});
      reg.emit('session', s);
    }
  };
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  // what the per-session layer would have done with these, while it existed:
  // mod-b owned by a pack that is not global (listed to no session)
  const viewWouldHide = () => {
    let packs = null;
    try { packs = require('../../lib/session-packs'); } catch (e) { return; }
    packs.configure({shared: () => true, records: () => [{pack: 'p', modules: ['mod-b']}], moduleOf: (d) => MODULES[d] || null,
      openSessions: () => [A, B]});
  };

  beforeEach(() => {
    visibility.resetForTests();
    visibility.configure({moduleOf: (d) => MODULES[d] || null, isGone: () => false});
  });
  afterEach(() => { visibility.resetForTests(); sessions.resetForTests(); });

  it('lib/session-packs.js is gone', () => {
    assert.throws(() => require('../../lib/session-packs'), (e) => e.code === 'MODULE_NOT_FOUND');
  });

  it('a shared runtime lists a loaded module to every session; only a module going on or off is hidden, for everyone', () => {
    open(A, B);
    viewWouldHide();
    const registry = require('../../lib/mcp/tool-registry');
    // (the one predicate takes no session: there is no view to choose,
    // #447's high review, 6)
    assert.strictEqual(registry.callerSees(null, 'dev-b'), true);
    // (two loaded modules, each its own device)
    const loaded = {deviceManager: {deviceMap: {'dev-a': {packageInfo: {name: 'mod-a'}}, 'dev-b': {packageInfo: {name: 'mod-b'}}}}};
    assert.deepStrictEqual(Object.keys(registry.forCaller(loaded, {t1: {deviceID: 'dev-a'}, t2: {deviceID: 'dev-b'}}, null)), ['t1', 't2']);
    visibility.hide(['mod-a']);
    assert.strictEqual(registry.callerSees(null, 'dev-a'), false, 'hidden from everyone');
    assert.deepStrictEqual(Object.keys(registry.forCaller(loaded, {t1: {deviceID: 'dev-a'}, t2: {deviceID: 'dev-b'}}, null)), ['t2']);
    for (const old of ['sessionLists', 'filterTargetsBySession', 'filterTargetsByAuth']) assert.strictEqual(registry[old], undefined, old);
  });

  it('a session\'s override names the two caps only: pack.* is SETTING_UNKNOWN; the pack API is gone', () => {
    const settings = require('../../lib/session-settings');
    for (const fn of ['packOverridesOf', 'dropPack', 'packOnAllowed']) assert.strictEqual(settings[fn], undefined, fn);
    settings.configure({isLive: () => true});
    try {
      assert.throws(() => settings.set(A, 'pack.weather', false, {version: '1.0.0'}), (e) => e.code === 'SETTING_UNKNOWN');
    } finally { settings.resetForTests(); }
  });

  it('a state or restore row with a pack.* override is refused like any unknown name', () => {
    const state = require('../../lib/session-state');
    const row = {overrides: [{name: 'pack.weather', value: false, loosening: false, over: null, version: '1.0.0'}], locks: [], formsLeft: 3};
    assert.notStrictEqual(state.stateProblem(row), null);
    assert.match(String(state.stateProblem(row)), /name/);
  });

  it('an ended session keeps no packs off for its jobs: packsOffFor is gone', () => {
    const jobs = require('../../lib/job-sessions');
    assert.strictEqual(jobs.packsOffFor, undefined);
  });

  // (M5b: no setting is a pack's; a module's on/off is enabled.<module>, every session's: sessions 37)
  it('the settings tool: a shared session\'s pack.<n> is no setting, never the session\'s own', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const options = require('../../lib/cli-options');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sessions-36-'));
    const saved = options.settingsFile;
    try {
      options.settingsFile = path.join(home, 'settings.json');
      fs.writeFileSync(options.settingsFile, JSON.stringify({version: 1, values: {}}));
      open(A);
      const tool = require('../../lib/settings-tool').create({file: options.settingsFile, ceiling: () => ({state: 'none'})});
      for (const value of [false, true]) {
        let err = null;
        try { await tool.set('pack.weather', value, 'settings tool', {shared: true, session: A}); } catch (e) { err = e; }
        assert.ok(err != null && err.code === 'SETTING_UNKNOWN', String(err && err.code));
      }
      assert.strictEqual(require('../../lib/session-settings').overridesOf(A).length, 0, 'no session override');
    } finally {
      options.settingsFile = saved;
      fs.rmSync(home, {recursive: true, force: true});
    }
  });

  it('module control: a module\'s notice goes to every open session; set pack.<n> true is no session view\'s (applyControlSet\'s)', async () => {
    open(A, B);
    const told = [];
    let applied = null;
    const control = require('../../lib/module-control').createModuleControl({
      shared: () => true, mm: {}, dm: {}, packs: {}, toolsOf: async () => [],
      notices: {add: (module, text, opts) => told.push([module, text, opts && opts.session]), keep: () => {}},
      applyControlSet: async (msg) => { applied = msg; return {}; }});
    // (no type: the handler's own is what the message is judged as)
    await control.notice({module: 'weather-tool', text: 'hello'});
    assert.deepStrictEqual(told.map((t) => [t[1], t[2]]).sort(), [['hello', A], ['hello', B]], 'once to each open session');
    await control.set({name: 'pack.weather', value: true});
    assert.deepStrictEqual(applied, {name: 'pack.weather', value: true});
  });
});

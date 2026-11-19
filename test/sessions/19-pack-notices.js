'use strict';
// Shared runtime B3, Task 6, as M5a leaves it (module-level configuration,
// #413 rev 3, sections 5.4, 5.5 and 7.3): ch-local's pack and module
// messages, and who is told (lib/module-control.js), and a pack's modules
// hidden while they load or unload (lib/modules-in-place.js; the reviewer's
// #340 review, obligation 1). No session has a view of its own: whatever is
// loaded is listed to every session, a notice goes once to every open
// session, and a pack form's `global` decides nothing. Server-free: real
// shared sessions and notices; the packs' loads are stand-ins, except in the
// last block, which drives modules-in-place's loadPack over a stand-in module
// manager and a pack on disk. (The plan names this file 18; 18 is Task 5's.)
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
options.setOptions({redisUrl: 'redis://127.0.0.1:1'});
require('../../lib/logger').createLogger();
const sessions = require('../../lib/sessions');
const settings = require('../../lib/session-settings');
const jobSessions = require('../../lib/job-sessions');
const notices = require('../../lib/notices');
const settingsTool = require('../../lib/settings-tool');
const visibility = require('../../lib/module-visibility');
const {createPackControl} = require('../../lib/module-control');
const {moduleKey} = require('../../lib/modules-in-place');

// What lib/modules-in-place.js asks of a manager for a unit loaded in place:
// ModuleManager's own methods (these fakes' loads never acknowledge, so a
// unit has nothing to wait for).
const MMP = require('../../lib/module-manager').prototype;
const UNITS = {holdDiscovery: MMP.holdDiscovery, releaseDiscovery: MMP.releaseDiscovery, isHeld: MMP.isHeld, unitLoaded: MMP.unitLoaded, unitRegistration: MMP.unitRegistration, unitNote: MMP.unitNote};

describe('sessions 19: ch-local\'s pack and module messages: every session is told (shared runtime B3, Task 6; M5a)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const C = 'c'.repeat(32);
  const SCENARIO = (p) => `@countinghouse/ch-pack-${p}`;
  let reg;
  let records;      // pack -> its modules, as modules-in-place would hold them
  let calls;        // the stand-in packs' calls
  let control;
  const reset = () => { sessions.resetForTests(); settings.resetForTests(); jobSessions.resetForTests(); notices.resetForTests(); settingsTool.resetForTests(); visibility.resetForTests(); };
  const openSession = (id) => {
    const s = new EventEmitter();
    s.id = id;
    s.client = {status: 'ok', conditions: 'yes', repo: null};
    s.notify = () => {};
    reg.emit('session', s);
    sessions.recordClientInfo(id, {name: 'test-client', version: '1.0.0'});
  };
  const packs = {
    loadPack: async(mm, msg) => { calls.push(['load', msg.name]); records.set(msg.pack, [`m-${msg.pack}`]); return {modules: [`m-${msg.pack}`]}; },
    reloadPack: async(mm, msg) => { calls.push(['reload', msg.name]); records.set(msg.pack, [`m-${msg.pack}`]); return {modules: [`m-${msg.pack}`]}; },
    unloadPack: async(mm, msg) => { calls.push(['unload', msg.name]); const p = msg.name.replace('@countinghouse/ch-pack-', ''); records.delete(p); return {modules: [`m-${p}`]}; }
  };
  const queued = (id, p) => notices.take(SCENARIO(p), id);
  // every notice a session has, about the pack or about none
  const all = (id, p) => notices.take(null, id).concat(queued(id, p));

  beforeEach(() => {
    reset();
    reg = new EventEmitter();
    sessions.attach(reg);
    records = new Map();
    calls = [];
    control = createPackControl({mm: {}, dm: {}, packs, toolsOf: async() => [], shared: () => sessions.shared()});
    for (const id of [A, B, C]) openSession(id);
  });
  afterEach(reset);

  const load = (p, global, extra = {}) => control.load(Object.assign({type: 'load', name: SCENARIO(p), scenario: `/x/${p}`, pack: p, global}, extra));

  describe('a pack-form load: its pack checked, its global not read', () => {
    it('in shared mode a load or reload whose pack name is missing or out of pattern is refused and loads nothing', async() => {
      await assert.rejects(control.load({type: 'load', name: SCENARIO('ci'), scenario: '/x/ci', global: true}), (e) => e.code === 'CONTROL_FAILED');
      await assert.rejects(control.load({type: 'load', name: SCENARIO('ci'), scenario: '/x/ci', pack: 'CI!', global: true}), (e) => e.code === 'CONTROL_FAILED');
      await assert.rejects(control.reload({type: 'reload', name: SCENARIO('ci'), scenario: '/x/ci', pack: 'CI!', global: true}), (e) => e.code === 'CONTROL_FAILED');
      assert.deepStrictEqual(calls, []);
    });

    it('a load or reload with no boolean global is taken: global decides nothing', async() => {
      await control.load({type: 'load', name: SCENARIO('ci'), scenario: '/x/ci', pack: 'ci'});
      await control.reload({type: 'reload', name: SCENARIO('ci'), scenario: '/x/ci', pack: 'ci', global: 'yes'});
      assert.deepStrictEqual(calls, [['load', SCENARIO('ci')], ['reload', SCENARIO('ci')]]);
    });
  });

  // M4 Task 5 (#413 section 7.3; section 16 rule 3): a module-form message on a shared runtime
  describe('the module form: under its package name, told to every session', () => {
    const MOD = '@countinghouse/ch-pack-mod';
    const dirsOf = (names) => Object.fromEntries(names.map((n) => [n, `/store/${n}/1.0.0`]));
    const modulePacks = Object.assign({}, packs, {
      // recorded as the runtime records a module-form unit: under its module key
      loadPack: async(mm, msg) => { calls.push(['load', msg.name]); records.set(moduleKey(msg.name), [`m-${msg.name}`]); if (mm.packsInPlace instanceof Map) mm.packsInPlace.set(msg.name, {form: 'module', pack: moduleKey(msg.name)}); return {modules: [`m-${msg.name}`]}; },
      reloadPack: async(mm, msg) => { calls.push(['reload', msg.names.join(',')]); for (const n of msg.names) records.set(moduleKey(n), [`m-${n}`]); return {modules: msg.names.map((n) => `m-${n}`)}; },
      unloadPack: async(mm, msg) => { calls.push(['unload', msg.name]); records.delete(moduleKey(msg.name)); return {modules: [`m-${msg.name}`]}; }
    });
    // the units these loads record, in the module form (module-control asks
    // the record which form an unload is in)
    const units = new Map();
    const moduleControl = () => createPackControl({mm: {packsInPlace: units}, dm: {}, packs: modulePacks, toolsOf: async() => [], shared: () => sessions.shared()});

    it('a load with no pack and no global is taken; the notice reaches each session once', async() => {
      const c = moduleControl();
      await c.load({type: 'load', name: MOD, dirs: dirsOf([MOD]), notice: 'mod added 1.0.0'});
      assert.deepStrictEqual(calls, [['load', MOD]]);
      assert.deepStrictEqual([A, B, C].map((id) => notices.take(MOD, id)), [['mod added 1.0.0'], ['mod added 1.0.0'], ['mod added 1.0.0']]);
    });

    // #429's high review, 5: a message that is not well formed is refused before anything is loaded
    it('a malformed module-form message is refused and loads nothing (#429 high 5)', async() => {
      const c = moduleControl();
      await assert.rejects(c.load({type: 'load', name: '@t/bad', dirs: {'@t/bad': 'relative/path'}}), (e) => e.code === 'CONTROL_FAILED');
      assert.deepStrictEqual(calls, []);
    });

    it('a shared runtime\'s module-form reload files its notice under each name (M4b medium 5)', async() => {
      const c = moduleControl();
      const OTHER = '@countinghouse/ch-pack-other';
      await c.load({type: 'load', name: MOD, dirs: dirsOf([MOD])});
      await c.load({type: 'load', name: OTHER, dirs: dirsOf([OTHER])});
      for (const id of [A, B, C]) { notices.take(MOD, id); notices.take(OTHER, id); }
      await c.reload({type: 'reload', names: [MOD, OTHER], dirs: dirsOf([MOD, OTHER]), notice: 'both upgraded'});
      assert.deepStrictEqual([A, B, C].map((id) => notices.take(OTHER, id)), [['both upgraded'], ['both upgraded'], ['both upgraded']]);
    });

    it('an unload with no pack of a unit not recorded in the module form is refused, as the pack form requires (M4b medium 6)', async() => {
      const c = createPackControl({mm: {packsInPlace: new Map([['@countinghouse/ch-pack-old', {form: undefined, pack: 'old'}]])}, dm: {}, packs: modulePacks,
        toolsOf: async() => [], shared: () => sessions.shared()});
      await assert.rejects(c.unload({type: 'unload', name: '@countinghouse/ch-pack-old'}), (e) => e.code === 'CONTROL_FAILED');
    });

    it('an unload of a module-form unit tells every session once', async() => {
      const c = moduleControl();
      await c.load({type: 'load', name: MOD, dirs: dirsOf([MOD])});
      for (const id of [A, B, C]) notices.take(MOD, id);
      await c.unload({type: 'unload', name: MOD, notice: 'mod turned off'});
      assert.deepStrictEqual(calls, [['load', MOD], ['unload', MOD]]);
      assert.deepStrictEqual([A, B, C].map((id) => notices.take(MOD, id)), [['mod turned off'], ['mod turned off'], ['mod turned off']]);
    });
  });

  // #449's high review, round 4 (the cut): the settings tool tells only the
  // asker, so nothing is a duplicate. Every unload is told once, in its own
  // text, under its own module's key, never held, never silenced. An unload
  // with reason 'off' (ch-local's, explicit) is told the full off text: the
  // callers loaded before it and both ways back
  describe('every unload is told once, under its own key; reason off gives the full off text', () => {
    const MOD = '@countinghouse/ch-pack-mod';
    const CALLER = 'trip-planner';
    const {offNotice} = require('../../lib/settings-tool');
    const units = new Map([[MOD, {form: 'module', pack: moduleKey(MOD)}], [CALLER, {form: 'module', pack: moduleKey(CALLER)}]]);
    let loaded;
    const both = Object.assign({}, packs, {
      unloadPack: async(mm, msg) => { calls.push(['unload', msg.name]); loaded = loaded.filter((t) => t.name !== msg.name); return {modules: [`m-${msg.name}`]}; }
    });
    const c = (o = {}) => createPackControl(Object.assign({mm: {packsInPlace: units}, dm: {}, packs: both, toolsOf: async() => [], shared: () => sessions.shared(),
      settingsServed: () => true, loadedTops: () => loaded}, o));
    const all = (m) => [A, B, C].map((id) => notices.take(m, id));
    const each = (t) => [[t], [t], [t]];
    beforeEach(() => { loaded = [{name: MOD, modules: [MOD], tools: []}, {name: CALLER, modules: [CALLER, MOD], tools: []}]; });

    it('reason off: the full text, naming the callers loaded before it; the caller\'s own unload, in its own words, whichever comes first', async() => {
      for (const order of [[MOD, CALLER], [CALLER, MOD]]) {
        loaded = [{name: MOD, modules: [MOD], tools: []}, {name: CALLER, modules: [CALLER, MOD], tools: []}];
        const control = c();
        for (const name of order) {
          await control.unload(name === MOD ? {type: 'unload', name: MOD, notice: 'ch-pack-mod turned off', reason: 'off'}
            : {type: 'unload', name: CALLER, notice: 'trip-planner unloaded: it calls ch-pack-mod, which is turned off'});
        }
        assert.deepStrictEqual(all(MOD), each(offNotice(MOD, order[0] === MOD ? [CALLER] : [])), order.join(' then '));
        assert.deepStrictEqual(all(CALLER), each('trip-planner unloaded: it calls ch-pack-mod, which is turned off'), order.join(' then '));
      }
    });

    it('no reason (today\'s ch-local), another reason, or no settings tool here: the message\'s own words', async() => {
      await c().unload({type: 'unload', name: MOD, notice: 'ch-pack-mod turned off'});
      assert.deepStrictEqual(all(MOD), each('ch-pack-mod turned off'));
      await c().unload({type: 'unload', name: MOD, notice: 'ch-pack-mod turned off', reason: 'ceiling'});
      assert.deepStrictEqual(all(MOD), each('ch-pack-mod turned off'));
      await c({settingsServed: () => false}).unload({type: 'unload', name: MOD, notice: 'ch-pack-mod turned off', reason: 'off'});
      assert.deepStrictEqual(all(MOD), each('ch-pack-mod turned off'));
    });

    // (the medium review of round 4, 6) served: the settings tool on and a
    // settings file to write
    it('the settings tool served only with --settingsFile: else the message\'s own words', async() => {
      const options = require('../../lib/cli-options');
      const saved = {settingsTool: options.settingsTool, settingsFile: options.settingsFile};
      try {
        for (const [tool, file, full] of [[true, null, false], [false, '/x/settings.json', false], [true, '/x/settings.json', true]]) {
          Object.assign(options, {settingsTool: tool, settingsFile: file});
          loaded = [{name: MOD, modules: [MOD], tools: []}];
          await c({settingsServed: undefined}).unload({type: 'unload', name: MOD, notice: 'ch-pack-mod turned off', reason: 'off'});
          assert.deepStrictEqual(all(MOD), each(full ? offNotice(MOD, []) : 'ch-pack-mod turned off'), `${tool} ${file}`);
        }
      } finally { Object.assign(options, saved); }
    });

    it('many callers: eight named and how many more, the ways back kept whole', async() => {
      loaded = [{name: MOD, modules: [MOD], tools: []}].concat(Array.from({length: 11}, (_, i) => ({name: `caller-${String(i).padStart(2, '0')}-${'x'.repeat(12)}`, modules: [MOD], tools: []})));
      await c().unload({type: 'unload', name: MOD, notice: 'ch-pack-mod turned off', reason: 'off'});
      const [t] = notices.take(MOD, A);
      assert.match(t, /caller-07-x+ and 3 more call it/);
      assert.ok(!/caller-08/.test(t));
      assert.ok(t.endsWith(`\`ch-local settings set enabled.${MOD} on\`.`), t);
    });

    it('the loaded modules unreadable: the message\'s own words', async() => {
      await c({loadedTops: () => { throw new Error('no manager'); }}).unload({type: 'unload', name: MOD, notice: 'ch-pack-mod turned off', reason: 'off'});
      assert.deepStrictEqual(all(MOD), each('ch-pack-mod turned off'));
    });
  });

  describe('a notice about a pack goes to every open session', () => {
    it('load\'s, reload\'s and a notice message\'s, about a pack, whatever its global: each session gets each once', async() => {
      await load('ci', false, {notice: 'ci added 1.0.0'});
      await control.reload({type: 'reload', name: SCENARIO('ci'), scenario: '/x/ci', pack: 'ci', global: true, notice: 'ci upgraded'});
      await control.notice({type: 'notice', module: null, text: 'ci news', pack: 'ci'});
      await control.notice({type: 'notice', module: null, text: 'requestTimeout set to 60 s'});
      for (const id of [A, B, C]) assert.deepStrictEqual(all(id, 'ci').sort(), ['ci added 1.0.0', 'ci news', 'ci upgraded', 'requestTimeout set to 60 s'].sort(), id);
    });

    it('a notice whose pack name is out of pattern is refused, and nobody is told', async() => {
      await assert.rejects(control.notice({type: 'notice', module: null, text: 'x', pack: 'CI!'}), (e) => e.code === 'CONTROL_FAILED');
      assert.deepStrictEqual([A, B, C].map((id) => notices.take(null, id)), [[], [], []]);
    });
  });

  describe('a terminal off is an unload, which tells everyone', () => {
    it('unload of a pack: every open session told once, in the message\'s words; with no notice, the tools were turned off', async() => {
      await load('docs', true);
      await control.unload({type: 'unload', name: SCENARIO('docs'), notice: 'docs turned off', pack: 'docs'});
      assert.deepStrictEqual([A, B, C].map((id) => all(id, 'docs')), [['docs turned off'], ['docs turned off'], ['docs turned off']]);
      await load('ci', false);
      await control.unload({type: 'unload', name: SCENARIO('ci'), pack: 'ci'});
      assert.deepStrictEqual([A, B, C].map((id) => all(id, 'ci')), [['the ci tools were turned off'], ['the ci tools were turned off'], ['the ci tools were turned off']]);
      assert.deepStrictEqual(calls.filter((c) => c[0] === 'unload'), [['unload', SCENARIO('docs')], ['unload', SCENARIO('ci')]]);
    });
  });

  describe('under --stdio, as on master', () => {
    it('a load\'s notice goes to the one queue; pack and global are not read; an unload says its notice', async() => {
      sessions.resetForTests();   // not shared
      const plain = createPackControl({mm: {}, dm: {}, packs, toolsOf: async() => ['t'], shared: () => false});
      assert.deepStrictEqual(await plain.load({type: 'load', name: SCENARIO('ci'), scenario: '/x/ci', notice: 'ci added', pack: 'CI!'}), {tools: ['t']});
      assert.deepStrictEqual(notices.take(SCENARIO('ci')), ['ci added']);
      await plain.unload({type: 'unload', name: SCENARIO('ci'), notice: 'ci turned off'});
      assert.deepStrictEqual(notices.take(SCENARIO('ci')), ['ci turned off']);
    });
  });

  // the reviewer's #340 review, obligation 1, as M4/M5a leave it: while a pack loads or unloads, its modules are
  // hidden from every session (registration and toolschanged come before the load's answer)
  describe('a pack\'s modules are hidden while it loads or unloads (modules-in-place, lib/module-visibility.js)', () => {
    let root;
    let saved;
    beforeEach(() => {
      saved = options.packsRoot;
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-b3-load-')));
      const dir = path.join(root, 'ci', 'node_modules', '@countinghouse', 'ch-pack-ci');
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: '@countinghouse/ch-pack-ci', version: '1.0.0', countinghouse: {role: 'scenario'}}));
      // a second pack, whose scenario calls a part beside it (two modules to load)
      const two = path.join(root, 'two', 'node_modules', '@countinghouse');
      fs.mkdirSync(path.join(two, 'ch-pack-two'), {recursive: true});
      fs.mkdirSync(path.join(two, 'ch-step-x'), {recursive: true});
      fs.writeFileSync(path.join(two, 'ch-pack-two', 'package.json'), JSON.stringify({name: '@countinghouse/ch-pack-two', version: '1.0.0', countinghouse: {role: 'scenario', calls: ['ch-step-x/svc.run']}}));
      fs.writeFileSync(path.join(two, 'ch-pack-two', 'api.json'), JSON.stringify({device: {friendlyName: 'ch-pack-two', serviceList: {'urn:x:serviceID:svc': {actionList: [{name: 'two_tool', description: 'two'}]}}}}));
      fs.writeFileSync(path.join(two, 'ch-step-x', 'package.json'), JSON.stringify({name: '@countinghouse/ch-step-x', version: '1.0.0', countinghouse: {role: 'part'}}));
      fs.writeFileSync(path.join(two, 'ch-step-x', 'api.json'), JSON.stringify({device: {friendlyName: 'ch-step-x', serviceList: {'urn:x:serviceID:svc': {actionList: [{name: 'run', description: 'run'}]}}}}));
      fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'ch-pack-ci', serviceList: {'urn:x:serviceID:svc': {actionList: [{name: 'ci_triage', description: 'triage'}]}}}}));
      options.packsRoot = [root];
    });
    afterEach(() => { options.packsRoot = saved; fs.rmSync(root, {recursive: true, force: true}); });

    // #341 review, 5: the loading record is gone whatever throws, the rollback included
    it('a load whose rollback throws leaves no loading record behind', async() => {
      const packsInPlace = require('../../lib/modules-in-place');
      let loads = 0;
      const mm = {modules: {}, unlisted: new Set(), startScenarios: [], startPlan: null, ...UNITS,
        // the first module loads, the second fails, and the rollback's unload throws
        loadModuleFromPath: (p, name, version, cb) => { loads += 1; if (loads === 1) { mm.modules[name] = {}; return cb(null); } return cb(new Error('no spawn')); },
        unloadModuleExternal: () => { throw new Error('unload threw'); }};
      await assert.rejects(packsInPlace.loadPack(mm, {type: 'load', name: '@countinghouse/ch-pack-two', scenario: path.join(root, 'two', 'node_modules', '@countinghouse', 'ch-pack-two'), pack: 'two', global: false}, {}));
      assert.strictEqual(loads, 2, 'two modules, the rollback ran');
      assert.deepStrictEqual(packsInPlace.packRecords(mm), []);
      assert.strictEqual(mm.packsLoading == null || mm.packsLoading.size === 0, true);
    });

    // the #341 deep review, 1: the mid-UNLOAD side. The record goes only once its modules are unloaded, and its
    // modules are hidden from the start of the unload
    it('no session sees a pack while it unloads', async() => {
      const packsInPlace = require('../../lib/modules-in-place');
      const seenMidUnload = [];
      const mm = {modules: {}, unlisted: new Set(), startScenarios: [], startPlan: null, ...UNITS,
        loadModuleFromPath: (p, name, version, cb) => { mm.modules[name] = {packageInfo: {version}}; cb(null); },
        unloadModuleExternal: (name, cb) => { seenMidUnload.push(visibility.listsModule(name)); delete mm.modules[name]; cb(); }};
      visibility.configure({isGone: (n) => mm.modules[n] == null});
      const scenario = path.join(root, 'ci', 'node_modules', '@countinghouse', 'ch-pack-ci');
      await packsInPlace.loadPack(mm, {type: 'load', name: '@countinghouse/ch-pack-ci', scenario, pack: 'ci', global: false}, {});
      await packsInPlace.unloadPack(mm, {type: 'unload', name: '@countinghouse/ch-pack-ci', pack: 'ci'});
      assert.deepStrictEqual(seenMidUnload, [false], 'hidden while it unloads');
      assert.deepStrictEqual(packsInPlace.packRecords(mm), [], 'and gone once unloaded');
      assert.strictEqual(visibility.none(), true, 'nothing left hidden once it is out of the module map');
    });

    it('no session sees a pack between its devices\' registration and the load\'s answer', async() => {
      const packsInPlace = require('../../lib/modules-in-place');
      const seenMidLoad = [];
      const mm = {modules: {}, unlisted: new Set(), startScenarios: [], startPlan: null, ...UNITS,
        loadModuleFromPath: (p, name, version, cb) => {
          // the module's devices register now (toolschanged): what every session sees at this moment
          mm.modules[name] = {packageInfo: {version}};
          seenMidLoad.push({records: packsInPlace.packRecords(mm), listed: visibility.listsModule(name)});
          cb(null);
        },
        unloadModuleExternal: (name, cb) => { delete mm.modules[name]; cb(); }};
      await packsInPlace.loadPack(mm, {type: 'load', name: '@countinghouse/ch-pack-ci', scenario: path.join(root, 'ci', 'node_modules', '@countinghouse', 'ch-pack-ci'), pack: 'ci', global: false}, {});
      // M4 (#413 section 5.5): what a load newly brings in is hidden from
      // every session until the load has completed
      assert.deepStrictEqual(seenMidLoad, [{records: [{pack: 'ci', modules: ['@countinghouse/ch-pack-ci']}], listed: false}]);
      assert.strictEqual(visibility.listsModule('@countinghouse/ch-pack-ci'), true, 'and listed to every session once loaded');
      assert.deepStrictEqual(packsInPlace.packRecords(mm), [{pack: 'ci', modules: ['@countinghouse/ch-pack-ci']}]);
      // and a pack loaded at runtime keeps its prompt names for the next load's check (a fix to fd2bfc62)
      assert.ok(mm.packsInPlace.get('@countinghouse/ch-pack-ci').prompts instanceof Set);
    });

    // F1-3 (the Fable security pass): a pack turned off, or reloaded without a part, while that part restarts after a
    // crash. Its unload used to skip a module out of the module map, so the supervisor's record survived and its
    // restart registered the part with no pack owning it: listed to every session. Over the real supervisor (a fake
    // clock) and the module manager's real unloadModuleExternal, the rest of the module manager stood in.
    describe('a part restarting after a crash when its pack goes (F1-3)', () => {
      const ModuleManager = require('../../lib/module-manager');
      const ModuleSupervisor = require('../../lib/module-supervisor');
      const PART = '@countinghouse/ch-step-x';
      function crashedPartRuntime() {
        const h = {timers: [], restarts: []};
        const supervisor = new ModuleSupervisor({now: () => 0,
          setTimer: (fn) => { const timer = {fn, cancelled: false}; h.timers.push(timer); return timer; },
          clearTimer: (timer) => { if (timer != null) timer.cancelled = true; },
          restart: (name, record) => h.restarts.push({name, record})});
        h.mm = Object.assign(Object.create(ModuleManager.prototype), {modules: {}, unlisted: new Set(), startScenarios: [], startPlan: null,
          generations: {}, endedDevices: {}, spawnsPending: {}, lifecycle: {live: () => null}, supervisor,
          loadModuleFromPath: (p, name, version, cb) => { h.mm.modules[name] = {packageInfo: {name, version}}; supervisor.track(name, {modulePath: p, version}); cb(null); },
          unloadModule: (name, why, cb) => { delete h.mm.modules[name]; cb(); }});
        h.crash = () => { delete h.mm.modules[PART]; supervisor.exited(PART, 'exit code 1', {}); };
        h.backoffEnds = () => h.timers.filter((x) => !x.cancelled).forEach((x) => { x.cancelled = true; x.fn(); });
        return h;
      }
      const scenario = () => path.join(root, 'two', 'node_modules', '@countinghouse', 'ch-pack-two');
      const load = (h) => require('../../lib/modules-in-place').loadPack(h.mm, {type: 'load', name: '@countinghouse/ch-pack-two', scenario: scenario(), pack: 'two', global: false}, {});

      it('turned off inside the backoff: the restart never runs, and nothing of the part is left', async() => {
        const packsInPlace = require('../../lib/modules-in-place');
        const h = crashedPartRuntime();
        await load(h);
        h.crash();
        assert.strictEqual(h.mm.supervisor.status(PART).state, 'restarting', 'premise: its restart is pending');
        await packsInPlace.unloadPack(h.mm, {type: 'unload', name: '@countinghouse/ch-pack-two', pack: 'two'});
        h.backoffEnds();
        assert.deepStrictEqual(h.restarts, [], 'its restart never runs');
        assert.strictEqual(h.mm.supervisor.status(PART), null, 'its supervisor\'s record is gone');
        assert.deepStrictEqual(packsInPlace.packRecords(h.mm), []);
      });

      // (that a spawn no longer current terminates its worker rather than registering it is the module
      // manager's own, sandbox 07: an operator restart racing the supervisor restart leaves one worker)
      it('turned off while its restart\'s spawn is under way: that spawn\'s record is no longer current', async() => {
        const packsInPlace = require('../../lib/modules-in-place');
        const h = crashedPartRuntime();
        await load(h);
        h.crash();
        h.backoffEnds();
        assert.strictEqual(h.restarts.length, 1, 'premise: the restart\'s spawn started');
        await packsInPlace.unloadPack(h.mm, {type: 'unload', name: '@countinghouse/ch-pack-two', pack: 'two'});
        // lib/module-manager.js: a restart spawn whose record is no longer current terminates its worker
        assert.strictEqual(h.mm.supervisor.isCurrent(PART, h.restarts[0].record), false);
      });

      it('reloaded without the part inside the backoff: the restart never runs either', async() => {
        const packsInPlace = require('../../lib/modules-in-place');
        const h = crashedPartRuntime();
        await load(h);
        h.crash();
        fs.writeFileSync(path.join(scenario(), 'package.json'), JSON.stringify({name: '@countinghouse/ch-pack-two', version: '1.0.0', countinghouse: {role: 'scenario'}}));
        await packsInPlace.reloadPack(h.mm, {type: 'reload', name: '@countinghouse/ch-pack-two', scenario: scenario(), pack: 'two', global: false}, {});
        h.backoffEnds();
        assert.deepStrictEqual(h.restarts, [], 'its restart never runs');
        assert.strictEqual(h.mm.supervisor.status(PART), null);
        assert.deepStrictEqual(packsInPlace.packRecords(h.mm), [{pack: 'two', modules: ['@countinghouse/ch-pack-two']}]);
      });

      it('a part that crashed with no supervisor (sandbox off) is unloaded with no warning: nothing of it is known', async() => {
        const packsInPlace = require('../../lib/modules-in-place');
        const LOG = require('../../lib/logger');
        const h = crashedPartRuntime();
        h.mm.supervisor = null;
        await load(h);
        delete h.mm.modules[PART];
        const warned = [];
        const W = LOG.W;
        LOG.W = (m) => warned.push(m);
        try {
          await packsInPlace.unloadPack(h.mm, {type: 'unload', name: '@countinghouse/ch-pack-two', pack: 'two'});
        } finally { LOG.W = W; }
        assert.deepStrictEqual(warned, []);
      });

      // F3-5 with F1-3: the part's spec, kept by its supervisor while it is down, is no tool before its pack goes,
      // and gone with it after; it never comes back
      it('restarting or suspended, its spec kept: no tool while down, gone with its pack, never respawned (F3-5)', async() => {
        const packsInPlace = require('../../lib/modules-in-place');
        const toolRegistry = require('../../lib/mcp/tool-registry');
        const DeviceManager = require('../../lib/device-manager');
        const spec = {device: {friendlyName: 'ch-step-x', serviceList: {'urn:x:serviceID:svc': {actionList: [{name: 'run', description: 'run'}]}}}};
        const tools = (ci) => Object.keys(toolRegistry.buildToolTargets(ci));
        for (const exits of [1, 3]) {
          const h = crashedPartRuntime();
          await load(h);
          const dm = Object.assign(Object.create(DeviceManager.prototype), {moduleManager: h.mm, deviceMap: {}, deviceOwners: new Map([['dx', PART]])});
          const ci = {deviceManager: dm};
          // its worker exits: its device out of the map, its spec and package.json with the supervisor
          delete h.mm.modules[PART];
          for (let i = 0; i < exits; i++) h.mm.supervisor.exited(PART, 'exit code 1', {dx: spec}, {name: PART, version: '1.0.0', countinghouse: {role: 'part'}});
          assert.strictEqual(h.mm.supervisor.status(PART).state, exits === 3 ? 'suspended' : 'restarting');
          assert.ok(dm.getAllDeviceSpecs().dx != null, 'premise: its spec kept');
          assert.ok(Object.keys(toolRegistry.buildToolTargets(ci, {includeUnlisted: true})).includes('ch_step_x_svc_run'), 'premise: a tool, but for its listing');
          assert.ok(!tools(ci).includes('ch_step_x_svc_run'), `no tool while down (${exits} exit(s))`);
          await packsInPlace.unloadPack(h.mm, {type: 'unload', name: '@countinghouse/ch-pack-two', pack: 'two'});
          h.backoffEnds();
          assert.deepStrictEqual(h.restarts, [], 'never respawned');
          assert.strictEqual(dm.getAllDeviceSpecs().dx, undefined, 'its spec gone with the pack');
          assert.ok(!tools(ci).includes('ch_step_x_svc_run'));
        }
      });

      it('pack operations run one at a time: one arriving while another is under way is refused, and changes nothing', async() => {
        const packsInPlace = require('../../lib/modules-in-place');
        const h = crashedPartRuntime();
        await load(h);
        h.mm.packsLoading.set('@countinghouse/ch-pack-ci', {pack: 'ci', modules: ['@countinghouse/ch-pack-ci']});
        try {
          await assert.rejects(packsInPlace.unloadPack(h.mm, {type: 'unload', name: '@countinghouse/ch-pack-two', pack: 'two'}),
            (e) => e.code === 'CONTROL_FAILED' && /serialised/.test(e.message));
        } finally { h.mm.packsLoading.delete('@countinghouse/ch-pack-ci'); }
        assert.deepStrictEqual(packsInPlace.packRecords(h.mm), [{pack: 'two', modules: ['@countinghouse/ch-pack-two', PART]}]);
        // and nothing left for the next test
        await packsInPlace.unloadPack(h.mm, {type: 'unload', name: '@countinghouse/ch-pack-two', pack: 'two'});
        assert.deepStrictEqual(packsInPlace.packRecords(h.mm), []);
      });
    });
  });
});

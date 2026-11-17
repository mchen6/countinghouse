'use strict';
// Shared runtime B3, Task 6: ch-local's pack messages, who a load is for and
// who is told (lib/pack-control.js), and a pack's modules owned while they
// load (lib/packs-in-place.js packRecords; the reviewer's #340 review,
// obligation 1). Server-free: real shared sessions, notices, session
// settings and session-packs; the packs' loads are stand-ins, except in the
// last block, which drives packs-in-place's loadPack over a stand-in module
// manager and a pack on disk. (The plan names this file 18; 18 is Task 5's.)
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
options.setOptions({redisUrl: 'redis://127.0.0.1:1'});
require('../../lib/logger').createLogger(false);
const sessions = require('../../lib/sessions');
const settings = require('../../lib/session-settings');
const jobSessions = require('../../lib/job-sessions');
const notices = require('../../lib/notices');
const settingsTool = require('../../lib/settings-tool');
const sessionPacks = require('../../lib/session-packs');
const {createHub, SUBSCRIPTION_ID_KEY} = require('../../lib/mcp/subscriptions');
const {createPackControl} = require('../../lib/pack-control');

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 3000) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await tick(10);
  return test();
};

describe('sessions 19: ch-local\'s pack messages: who a load is for, and who is told (shared runtime B3, Task 6)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const C = 'c'.repeat(32);
  const SCENARIO = (p) => `@countinghouse/ch-pack-${p}`;
  let reg;
  let open;
  let records;      // pack -> its modules, as packs-in-place would hold them
  let calls;        // the stand-in packs' calls
  let control;
  let hub;
  let heard;        // subscription id -> its list_changed count
  const reset = () => { sessions.resetForTests(); settings.resetForTests(); jobSessions.resetForTests(); notices.resetForTests(); settingsTool.resetForTests(); sessionPacks.resetForTests(); };
  const openSession = (id) => {
    const s = new EventEmitter();
    s.id = id;
    s.client = {status: 'ok', conditions: 'yes', repo: null};
    s.notify = () => {};
    open.add(id);
    reg.emit('session', s);
    sessions.recordClientInfo(id, {name: 'test-client', version: '1.0.0'});
  };
  const packs = {
    loadPack: async(mm, msg) => { calls.push(['load', msg.name]); records.set(msg.pack, [`m-${msg.pack}`]); return {modules: [`m-${msg.pack}`]}; },
    reloadPack: async(mm, msg) => { calls.push(['reload', msg.name]); records.set(msg.pack, [`m-${msg.pack}`]); return {modules: [`m-${msg.pack}`]}; },
    unloadPack: async(mm, msg) => { calls.push(['unload', msg.name]); const p = msg.name.replace('@countinghouse/ch-pack-', ''); records.delete(p); return {modules: [`m-${p}`]}; }
  };
  const on = (id, p) => settings.set(id, `pack.${p}`, true, {loosening: true, version: '1.0.0'});
  const off = (id, p) => settings.set(id, `pack.${p}`, false, {version: '1.0.0'});
  const queued = (id, p) => notices.take(SCENARIO(p), id);
  const listener = (id, session) => {
    heard[id] = 0;
    hub.open({id, appKey: 'k', session, filter: {toolsListChanged: true}, write: () => { heard[id] += 1; }, finish: () => {}});
  };

  beforeEach(() => {
    reset();
    reg = new EventEmitter();
    sessions.attach(reg);
    open = new Set();
    records = new Map();
    calls = [];
    heard = {};
    settings.configure({ceiling: () => ({state: 'none'}), defaultOf: () => 8 * 1024 * 1024, isLive: (id) => open.has(id), ceilingMemoMs: 0});
    sessionPacks.configure({
      records: () => [...records].map(([pack, modules]) => ({pack, modules})),
      moduleOf: (deviceID) => deviceID.replace(/^d-/, 'm-'),
      overridesOf: settings.packOverridesOf, onOverrideChange: settings.onChange,
      openSessions: () => [...open], isOpen: (id) => open.has(id), shared: () => sessions.shared(),
      allowsOn: settings.packOnAllowed, ceilingNow: settings.ceilingNow, ceilingKey: settings.ceilingKey
    });
    hub = createHub({listTools: async(appKey, session) => [...records.keys()].filter((p) => sessionPacks.lists(session, p)).map((name) => ({name})), settleMs: 5});
    sessionPacks.onChange((session) => hub.changed({session}));
    control = createPackControl({mm: {}, dm: {}, packs, toolsOf: async() => [], shared: () => sessions.shared()});
    for (const id of [A, B, C]) openSession(id);
  });
  afterEach(reset);

  const load = (p, global, extra = {}) => control.load(Object.assign({type: 'load', name: SCENARIO(p), scenario: `/x/${p}`, pack: p, global}, extra));

  describe('a load: global from the message, never inferred', () => {
    it('global false while A\'s load-pack waits: not global; global true: global, and B lists it', async() => {
      on(A, 'ci');
      await load('ci', false);
      assert.deepStrictEqual([sessionPacks.isGlobal('ci'), sessionPacks.lists(A, 'ci'), sessionPacks.lists(B, 'ci')], [false, true, false]);
      await control.reload({type: 'reload', name: SCENARIO('ci'), scenario: '/x/ci', pack: 'ci', global: true});
      assert.deepStrictEqual([sessionPacks.isGlobal('ci'), sessionPacks.lists(B, 'ci')], [true, true]);
    });

    it('global false with no session waiting (a restart\'s reload): not global, and no session lists it', async() => {
      await load('ci', false);
      assert.deepStrictEqual([A, B, C].map((id) => sessionPacks.lists(id, 'ci')), [false, false, false]);
    });

    it('in shared mode a load or reload with no boolean global, or a pack name out of pattern, is refused and loads nothing', async() => {
      await assert.rejects(control.load({type: 'load', name: SCENARIO('ci'), scenario: '/x/ci', pack: 'ci'}), (e) => e.code === 'CONTROL_FAILED');
      await assert.rejects(control.load({type: 'load', name: SCENARIO('ci'), scenario: '/x/ci', pack: 'ci', global: 'yes'}), (e) => e.code === 'CONTROL_FAILED');
      await assert.rejects(control.reload({type: 'reload', name: SCENARIO('ci'), scenario: '/x/ci', pack: 'ci'}), (e) => e.code === 'CONTROL_FAILED');
      await assert.rejects(control.load({type: 'load', name: SCENARIO('ci'), scenario: '/x/ci', pack: 'CI!', global: true}), (e) => e.code === 'CONTROL_FAILED');
      assert.deepStrictEqual(calls, []);
    });

    it('a load that fails leaves the pack\'s global value as it was', async() => {
      const failing = createPackControl({mm: {}, dm: {}, packs: Object.assign({}, packs, {loadPack: async() => { throw Object.assign(new Error('no'), {code: 'CONTROL_FAILED'}); }}),
        toolsOf: async() => [], shared: () => sessions.shared()});
      await assert.rejects(failing.load({type: 'load', name: SCENARIO('ci'), scenario: '/x/ci', pack: 'ci', global: true}));
      assert.strictEqual(sessionPacks.isGlobal('ci'), false);
    });
  });

  describe('a notice about a pack goes to the sessions that list it', () => {
    it('load\'s, reload\'s and a notice message\'s, about A\'s this-session pack: A gets each once, B and C none', async() => {
      on(A, 'ci');
      await load('ci', false, {notice: 'ci added 1.0.0'});
      await control.reload({type: 'reload', name: SCENARIO('ci'), scenario: '/x/ci', pack: 'ci', global: false, notice: 'ci upgraded'});
      await control.notice({type: 'notice', module: null, text: 'ci turned on for this session', pack: 'ci'});
      assert.deepStrictEqual(notices.take(null, A).concat(queued(A, 'ci')).sort(), ['ci added 1.0.0', 'ci turned on for this session', 'ci upgraded'].sort());
      assert.deepStrictEqual([notices.take(null, B), queued(B, 'ci'), notices.take(null, C), queued(C, 'ci')], [[], [], [], []]);
    });

    it('about a global pack B turned off: A and C are told, B isn\'t; a notice with no pack goes to everyone', async() => {
      await load('docs', true);
      off(B, 'docs');
      await control.notice({type: 'notice', module: null, text: 'docs news', pack: 'docs'});
      await control.notice({type: 'notice', module: null, text: 'requestTimeout set to 60 s'});
      const all = (id) => notices.take(null, id).concat(queued(id, 'docs'));
      assert.deepStrictEqual([all(A).sort(), all(B), all(C).sort()], [['docs news', 'requestTimeout set to 60 s'], ['requestTimeout set to 60 s'], ['docs news', 'requestTimeout set to 60 s']]);
    });
  });

  describe('a terminal off is an unload, which does all of it', () => {
    it('unload of a global pack with A\'s own "on", B\'s own "off" and C with none: A and C told once, B not; A\'s "on" gone, B\'s "off" kept; nobody lists it; A\'s and C\'s listeners told', async() => {
      await load('docs', true);
      on(A, 'docs');
      off(B, 'docs');
      listener(1, A);
      listener(2, B);
      listener(3, C);
      await tick();
      await control.unload({type: 'unload', name: SCENARIO('docs'), notice: 'docs turned off', pack: 'docs'});
      const all = (id) => notices.take(null, id).concat(queued(id, 'docs'));
      assert.deepStrictEqual([all(A), all(B), all(C)], [['your this-session pack docs ended: it was turned off'], [], ['docs turned off']]);
      assert.deepStrictEqual([settings.packOverridesOf(A).has('docs'), settings.packOverridesOf(B).get('docs')], [false, false]);
      assert.deepStrictEqual([A, B, C].map((id) => sessionPacks.lists(id, 'docs')), [false, false, false]);
      assert.ok(await until(() => heard[1] === 1 && heard[3] === 1));
      await tick(40);
      assert.strictEqual(heard[2], 0);
      // on again for everyone: A and C list it by the global value, B still doesn't
      await load('docs', true);
      assert.deepStrictEqual([A, B, C].map((id) => sessionPacks.lists(id, 'docs')), [true, false, true]);
    });

    it('unload of a pack only A and B had on: both told, both "on"s gone; an unload with no notice says the tools were turned off', async() => {
      await load('ci', false);
      on(A, 'ci');
      on(B, 'ci');
      await control.unload({type: 'unload', name: SCENARIO('ci'), pack: 'ci'});
      const all = (id) => notices.take(null, id).concat(queued(id, 'ci'));
      assert.deepStrictEqual([all(A), all(B), all(C)], [['your this-session pack ci ended: it was turned off'], ['your this-session pack ci ended: it was turned off'], []]);
      assert.deepStrictEqual([settings.packOverridesOf(A).size, settings.packOverridesOf(B).size], [0, 0]);
      await load('docs', true);
      await control.unload({type: 'unload', name: SCENARIO('docs'), pack: 'docs'});
      assert.deepStrictEqual(notices.take(SCENARIO('docs'), C), ['the docs tools were turned off']);
    });
  });

  describe('set pack.<n>', () => {
    it('true makes a pack that only A listed listed to B, and tells B\'s listener; false is refused and changes nothing', async() => {
      await load('ci', false);
      on(A, 'ci');
      listener(4, B);
      await tick();
      await control.set({type: 'set', name: 'pack.ci', value: true});
      assert.strictEqual(sessionPacks.lists(B, 'ci'), true);
      assert.ok(await until(() => heard[4] === 1));
      await assert.rejects(control.set({type: 'set', name: 'pack.ci', value: false}));
      assert.strictEqual(sessionPacks.isGlobal('ci'), true);
    });
  });

  describe('under --stdio, as on master', () => {
    it('a load\'s notice goes to the one queue; pack and global are not read; an unload says its notice and calls packUnloaded', async() => {
      sessions.resetForTests();   // not shared
      const said = [];
      const plain = createPackControl({mm: {}, dm: {}, packs, toolsOf: async() => ['t'], shared: () => false,
        packUnloaded: (name) => said.push(['packUnloaded', name])});
      assert.deepStrictEqual(await plain.load({type: 'load', name: SCENARIO('ci'), scenario: '/x/ci', notice: 'ci added', pack: 'ci'}), {tools: ['t']});
      assert.deepStrictEqual(notices.take(SCENARIO('ci')), ['ci added']);
      await plain.unload({type: 'unload', name: SCENARIO('ci'), notice: 'ci turned off'});
      assert.deepStrictEqual([notices.take(SCENARIO('ci')), said], [['ci turned off'], [['packUnloaded', SCENARIO('ci')]]]);
      assert.strictEqual(sessionPacks.isGlobal('ci'), false, 'global not read');
    });
  });

  // the reviewer's ruling (1) on #340: Task 6 wires session-packs in production, with no default left in place
  describe('the production wiring (RouteManager configureSessionPacks)', () => {
    it('records, devices, overrides, the ceiling and the open sessions all come from the runtime', () => {
      const RouteManager = require('../../lib/route-manager');
      let ceiling = {state: 'none'};
      settings.configure({ceiling: () => ceiling, defaultOf: () => 8 * 1024 * 1024, isLive: (id) => open.has(id), ceilingMemoMs: 0});
      // a pack loaded at start (the terminal's) is global; ci is loaded after, for a session
      const mm = {modules: {}, unlisted: new Set(), startScenarios: [], startPlan: null,
        packsInPlace: new Map([['@countinghouse/ch-pack-docs', {scenario: '/y', pack: 'docs', modules: new Map([['@countinghouse/ch-pack-docs', {version: '2.0.0'}]]), tools: new Set(), prompts: new Set()}]]),
        supervisor: {errorForDevice: (d) => (d === 'd-restarting' ? {code: 'MODULE_RESTARTING', module: 'm-ci'} : null)},
        endedStateForDevice: (d) => (d === 'd-ended' ? {code: 'MODULE_UNLOADED', name: 'm-ci'} : null)};
      const dm = {deviceMap: {'d-ci': {hostModuleName: 'm-ci'}}};
      let gone = false;
      RouteManager.prototype.configureSessionPacks.call({moduleManager: mm, cdifInterface: {deviceManager: dm}}, {daemonGone: () => gone});
      assert.strictEqual(sessionPacks.isGlobal('docs'), true, 'a start pack is global');
      mm.packsInPlace.set('@countinghouse/ch-pack-ci', {scenario: '/x', pack: 'ci', modules: new Map([['@countinghouse/ch-pack-ci', {version: '1.0.0'}], ['m-ci', {version: '1.0.0'}]]), tools: new Set(), prompts: new Set()});
      sessionPacks.packChanged('ci');
      // the loaded version, from the pack's own scenario (#341 review, 1)
      assert.deepStrictEqual([sessionPacks.loadedVersion('ci'), sessionPacks.loadedVersion('docs'), sessionPacks.loadedVersion('nope')], ['1.0.0', '2.0.0', null]);
      // a device out of the map (restarting, ended) is still its module's: hidden from B (#341 review, 3)
      assert.deepStrictEqual([sessionPacks.listsDevice(B, 'd-restarting'), sessionPacks.listsDevice(B, 'd-ended'), sessionPacks.listsDevice(B, 'd-unknown')], [false, false, true]);
      gone = true;
      assert.strictEqual(sessionPacks.unloadIfUnused != null, true);
      on(A, 'ci');
      // B: no override; A: its own "on"; both by the store's records and the device map
      assert.deepStrictEqual([sessionPacks.listsDevice(A, 'd-ci'), sessionPacks.listsDevice(B, 'd-ci')], [true, false]);
      assert.deepStrictEqual([...sessionPacks.audienceOf('ci')], [A], 'the open sessions');
      // the ceiling, through the settings store: untrusted, A's "on" is off with no event
      ceiling = {state: 'untrusted', file: 'x', problem: 'y'};
      assert.strictEqual(sessionPacks.listsDevice(A, 'd-ci'), false);
    });
  });

  // the reviewer's #340 review, obligation 1: while a this-session pack loads, its modules are already owned by
  // it, so B never sees them (registration and toolschanged come before the load's answer)
  describe('a pack\'s modules are owned while it loads (packs-in-place packRecords)', () => {
    let root;
    let saved;
    beforeEach(() => {
      saved = options.packsRoot;
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-b3-load-')));
      const dir = path.join(root, 'ci', 'node_modules', '@countinghouse', 'ch-pack-ci');
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: '@countinghouse/ch-pack-ci', version: '1.0.0', countinghouse: {role: 'scenario'}}));
      fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'ch-pack-ci', serviceList: {'urn:x:serviceID:svc': {actionList: [{name: 'ci_triage', description: 'triage'}]}}}}));
      options.packsRoot = [root];
    });
    afterEach(() => { options.packsRoot = saved; fs.rmSync(root, {recursive: true, force: true}); });

    // #341 review, 5: the loading record is gone whatever throws, the rollback included
    it('a load whose rollback throws leaves no loading record behind', async() => {
      const packsInPlace = require('../../lib/packs-in-place');
      const mm = {modules: {}, unlisted: new Set(), startScenarios: [], startPlan: null,
        loadModuleFromPath: (p, name, version, cb) => cb(new Error('no spawn')),
        unloadModuleExternal: () => { throw new Error('unload threw'); }};
      await assert.rejects(packsInPlace.loadPack(mm, {type: 'load', name: '@countinghouse/ch-pack-ci', scenario: path.join(root, 'ci', 'node_modules', '@countinghouse', 'ch-pack-ci'), pack: 'ci', global: false}, {}));
      assert.deepStrictEqual(packsInPlace.packRecords(mm), []);
      assert.strictEqual(mm.packsLoading == null || mm.packsLoading.size === 0, true);
    });

    it('B can\'t see A\'s pack between its devices\' registration and the load\'s answer', async() => {
      const packsInPlace = require('../../lib/packs-in-place');
      const seenMidLoad = [];
      const mm = {modules: {}, unlisted: new Set(), startScenarios: [], startPlan: null,
        loadModuleFromPath: (p, name, version, cb) => {
          // the module's devices register now (toolschanged): what B sees at this moment
          mm.modules[name] = {packageInfo: {version}};
          seenMidLoad.push({records: packsInPlace.packRecords(mm), b: sessionPacks.listsModule(B, name), a: sessionPacks.listsModule(A, name)});
          cb(null);
        },
        unloadModuleExternal: (name, cb) => { delete mm.modules[name]; cb(); }};
      sessionPacks.configure({records: () => packsInPlace.packRecords(mm), moduleOf: () => null,
        overridesOf: settings.packOverridesOf, onOverrideChange: settings.onChange, openSessions: () => [...open], isOpen: (id) => open.has(id),
        shared: () => sessions.shared(), allowsOn: settings.packOnAllowed, ceilingNow: settings.ceilingNow, ceilingKey: settings.ceilingKey});
      on(A, 'ci');
      await packsInPlace.loadPack(mm, {type: 'load', name: '@countinghouse/ch-pack-ci', scenario: path.join(root, 'ci', 'node_modules', '@countinghouse', 'ch-pack-ci'), pack: 'ci', global: false}, {});
      assert.deepStrictEqual(seenMidLoad, [{records: [{pack: 'ci', modules: ['@countinghouse/ch-pack-ci']}], b: false, a: true}]);
      assert.deepStrictEqual(packsInPlace.packRecords(mm), [{pack: 'ci', modules: ['@countinghouse/ch-pack-ci']}]);
      // and a pack loaded at runtime keeps its prompt names for the next load's check (a fix to fd2bfc62)
      assert.ok(mm.packsInPlace.get('@countinghouse/ch-pack-ci').prompts instanceof Set);
    });
  });
});

'use strict';
// Shared runtime B3, Task 6, as M5a and M6 leave it (module-level
// configuration, #413 rev 3, sections 5.4, 5.5 and 7.3): ch-local's module
// messages, and who is told (lib/module-control.js), and a unit's modules
// hidden while they load or unload (lib/modules-in-place.js; the reviewer's
// #340 review, obligation 1). No session has a view of its own: whatever is
// loaded is listed to every session, and a notice goes once to every open
// session. The pack form is gone (M6). Server-free: real shared sessions and
// notices; the loads are stand-ins, except in the last block, which drives
// modules-in-place's loadPack over a stand-in module manager and modules on
// disk.
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
// (the options are set in each describe's before(), the process's put back
// in its after(): never at load, which every file of a folder run would
// see -- B-loadopts-2)
const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
require('../../lib/logger').createLogger();
const sessions = require('../../lib/sessions');
const settings = require('../../lib/session-settings');
const jobSessions = require('../../lib/job-sessions');
const notices = require('../../lib/notices');
const settingsTool = require('../../lib/settings-tool');
const visibility = require('../../lib/module-visibility');
const {createModuleControl} = require('../../lib/module-control');

// What lib/modules-in-place.js asks of a manager for a unit loaded in place:
// ModuleManager's own methods (these fakes' loads never acknowledge, so a
// unit has nothing to wait for).
const MMP = require('../../lib/module-manager').prototype;
const UNITS = {holdDiscovery: MMP.holdDiscovery, releaseDiscovery: MMP.releaseDiscovery, isHeld: MMP.isHeld, unitLoaded: MMP.unitLoaded, unitRegistration: MMP.unitRegistration, unitNote: MMP.unitNote};

describe('sessions 19: ch-local\'s pack and module messages: every session is told (shared runtime B3, Task 6; M5a)', () => {
  let keptOptions = null;
  before(() => { keptOptions = optionsNow(); options.setOptions({redisUrl: 'redis://127.0.0.1:1'}); });
  after(() => { restoreOptions(keptOptions); });
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
  // (a unit by its scenario's short name, as the old pack name was)
  const short = (n) => String(n).replace('@countinghouse/ch-pack-', '');
  const packs = {
    loadPack: async(mm, msg) => { calls.push(['load', msg.name]); records.set(short(msg.name), [`m-${short(msg.name)}`]); return {modules: [`m-${short(msg.name)}`]}; },
    reloadPack: async(mm, msg) => { const n = msg.name || msg.names[0]; calls.push(['reload', n]); records.set(short(n), [`m-${short(n)}`]); return {modules: [`m-${short(n)}`]}; },
    unloadPack: async(mm, msg) => { calls.push(['unload', msg.name]); const p = short(msg.name); records.delete(p); return {modules: [`m-${p}`]}; }
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
    control = createModuleControl({mm: {}, dm: {}, packs, toolsOf: async() => [], shared: () => sessions.shared()});
    for (const id of [A, B, C]) openSession(id);
  });
  afterEach(reset);

  const load = (p, extra = {}) => control.load(Object.assign({type: 'load', name: SCENARIO(p), dirs: {[SCENARIO(p)]: `/x/${p}`}}, extra));

  // M4 Task 5 (#413 section 7.3; section 16 rule 3): a module-form message on a shared runtime
  describe('the module form: under its package name, told to every session', () => {
    const MOD = '@countinghouse/ch-pack-mod';
    const dirsOf = (names) => Object.fromEntries(names.map((n) => [n, `/store/${n}/1.0.0`]));
    const modulePacks = Object.assign({}, packs, {
      // recorded under its package name, as the runtime records a unit
      loadPack: async(mm, msg) => { calls.push(['load', msg.name]); records.set(msg.name, [`m-${msg.name}`]); return {modules: [`m-${msg.name}`]}; },
      reloadPack: async(mm, msg) => { calls.push(['reload', msg.names.join(',')]); for (const n of msg.names) records.set(n, [`m-${n}`]); return {modules: msg.names.map((n) => `m-${n}`)}; },
      unloadPack: async(mm, msg) => { calls.push(['unload', msg.name]); records.delete(msg.name); return {modules: [`m-${msg.name}`]}; }
    });
    const moduleControl = () => createModuleControl({mm: {}, dm: {}, packs: modulePacks, toolsOf: async() => [], shared: () => sessions.shared()});

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
  // callers loaded before it and the way back
  describe('every unload is told once, under its own key; reason off gives the full off text', () => {
    const MOD = '@countinghouse/ch-pack-mod';
    const CALLER = 'trip-planner';
    const {offNotice} = require('../../lib/settings-tool');
    let loaded;
    const both = Object.assign({}, packs, {
      unloadPack: async(mm, msg) => { calls.push(['unload', msg.name]); loaded = loaded.filter((t) => t.name !== msg.name); return {modules: [`m-${msg.name}`]}; }
    });
    const c = (o = {}) => createModuleControl(Object.assign({mm: {}, dm: {}, packs: both, toolsOf: async() => [], shared: () => sessions.shared(),
      settingsServed: () => true, storedOff: (name) => name === MOD, loadedTops: () => loaded}, o));
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
        // each once, on the next result of any tool: the runtime's own off
        // text first, in its own lane (round 6, 1)
        const own = 'trip-planner unloaded: it calls ch-pack-mod, which is turned off';
        const want = order[0] === MOD ? [offNotice(MOD, [CALLER]), own] : [offNotice(MOD, []), own];
        assert.deepStrictEqual(all(null), [want, want, want], order.join(' then '));
      }
    });

    // (round 5, 1) the module's tools are gone: its notice goes on the next
    // result of any tool, never filed under the module unloaded
    it('an unload\'s notice reaches a session that only calls another tool, and is not left under the module', async() => {
      await c().unload({type: 'unload', name: MOD, notice: 'ch-pack-mod turned off', reason: 'off'});
      assert.deepStrictEqual([A, B, C].map((id) => notices.take('some-other-module', id)), each(offNotice(MOD, [CALLER])));
      assert.deepStrictEqual(all(MOD), [[], [], []], 'nothing left for a later turn-on to deliver');
    });

    // (round 5, 2) reason off and the settings holding it off, both: a
    // ceiling's unload or a stale reason never gets the way back
    // (round 5, 6) a caller unloaded with the module it went with, explicit:
    // its own line, with the way back
    it('reason calls, because the module turned off: the caller\'s line with the way back; otherwise its own words', async() => {
      const own = 'trip-planner unloaded: it calls ch-pack-mod, which is turned off';
      await c().unload({type: 'unload', name: CALLER, notice: own, reason: 'calls', because: MOD});
      assert.deepStrictEqual(all(null), each(`${CALLER} unloaded: it calls ${MOD}, which is turned off for all your sessions (turning ${MOD} on brings it back).`));
      // (round 6, 6) a name that is no package name: refused before anything
      // (M6: every message's shape is checked, on any runtime)
      await assert.rejects(c().unload({type: 'unload', name: 'Not A Package', notice: own, reason: 'calls', because: MOD}), (e) => e.code === 'CONTROL_FAILED');
      assert.deepStrictEqual(all(null), [[], [], []]);
      // the module it names not held off, a because that is no package name,
      // or none: its own words
      for (const because of ['other-module', 7, undefined]) {
        await c().unload({type: 'unload', name: CALLER, notice: own, reason: 'calls', because});
        assert.deepStrictEqual(all(null), each(own), String(because));
      }
    });

    it('reason off but the settings do not hold it off (or cannot be read): the message\'s own words', async() => {
      await c({storedOff: () => false}).unload({type: 'unload', name: MOD, notice: 'ch-pack-mod turned off', reason: 'off'});
      assert.deepStrictEqual(all(MOD), each('ch-pack-mod turned off'));
      await c({storedOff: () => { throw new Error('unreadable'); }}).unload({type: 'unload', name: MOD, notice: 'ch-pack-mod turned off', reason: 'off'});
      assert.deepStrictEqual(all(MOD), each('ch-pack-mod turned off'));
    });

    // (the medium review of round 5, 7) the stored value read as it is: an
    // unrelated value the settings would refuse does not hide the off
    it('the settings file read as stored: enabled.<m> false beside a value the settings refuse still gives the off text', async() => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const options = require('../../lib/cli-options');
      const saved = {settingsTool: options.settingsTool, settingsFile: options.settingsFile};
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s19-'));
      try {
        const file = path.join(dir, 'settings.json');
        fs.writeFileSync(file, JSON.stringify({version: 1, values: {[`enabled.${MOD}`]: false, maxOutputBytes: 'not a size'}}));
        Object.assign(options, {settingsTool: true, settingsFile: file});
        loaded = [{name: MOD, modules: [MOD], tools: []}];
        await c({settingsServed: undefined, storedOff: undefined}).unload({type: 'unload', name: MOD, notice: 'ch-pack-mod turned off', reason: 'off'});
        assert.deepStrictEqual(all(MOD), each(offNotice(MOD, [])));
      } finally {
        Object.assign(options, saved);
        fs.rmSync(dir, {recursive: true, force: true});
      }
    });

    // (round 6, 1) a flood of caller unloads never evicts the runtime's own
    // off text
    it('25 callers unloaded after it: the off text with its way back is still delivered', async() => {
      const control = c();
      await control.unload({type: 'unload', name: MOD, notice: 'ch-pack-mod turned off', reason: 'off'});
      for (let i = 0; i < 25; i++) {
        await control.unload({type: 'unload', name: `caller-${i}`, notice: `caller-${i} unloaded`});
      }
      const got = notices.take('some-other-module', A);
      assert.strictEqual(got[0], offNotice(MOD, [CALLER]));
      assert.ok(got.some((t) => /earlier changes not listed here/.test(t)), 'the others counted, never silent');
    });

    // (the medium review of round 6, 1) the callers' own 'calls' lines, 21
    // and more, never evict the off text either
    it('25 callers unloaded with reason calls after it: the off text is still delivered', async() => {
      const control = c();
      await control.unload({type: 'unload', name: MOD, notice: 'ch-pack-mod turned off', reason: 'off'});
      for (let i = 0; i < 25; i++) {
        await control.unload({type: 'unload', name: `caller-${i}`, notice: `caller-${i} unloaded`, reason: 'calls', because: MOD});
      }
      assert.strictEqual(notices.take('some-other-module', A)[0], offNotice(MOD, [CALLER]));
      // a caller line of long names keeps its way back whole
      const long = `@${'c'.repeat(40)}/${'d'.repeat(120)}`;
      await control.unload({type: 'unload', name: long, notice: 'x', reason: 'calls', because: MOD});
      assert.ok(notices.take('some-other-module', A).some((t) => t.endsWith('on brings it back).')));
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

    it('many callers: eight named and how many more, the way back kept whole', async() => {
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

  describe('a notice about a module goes to every open session', () => {
    // what a session that joins later is given (lib/notices.js standing notices), through module-control's own calls
    describe('a session that joins later', () => {
      const D = 'd'.repeat(32);
      const MOD = '@countinghouse/ch-pack-late';
      const dirs = {[MOD]: `/store/${MOD}/1.0.0`};

      for (const notice of [undefined, 'loaded again']) {
        it(`a load ${notice == null ? 'with no notice' : 'with its notice'} clears what was kept about the module: a later session is not told the unload`, async() => {
          await control.unload({type: 'unload', name: MOD, notice: 'the late tools were turned off'});
          await control.load(Object.assign({type: 'load', name: MOD, dirs}, notice != null ? {notice} : {}));
          openSession(D);
          const got = notices.take(null, D).concat(notices.take(MOD, D));
          assert.ok(!got.some((l) => l.includes('turned off')), got.join(' | '));
          if (notice != null) assert.ok(got.some((l) => l.endsWith('loaded again')), got.join(' | '));
        });
      }

      it('an unload\'s notice and a notice message name their module: one hidden at a session\'s open waits for it', async() => {
        await control.unload({type: 'unload', name: MOD, notice: 'the late tools were turned off'});
        await control.notice({type: 'notice', module: MOD, text: 'a line about the late module'});
        visibility.hide([MOD]);
        openSession(D);
        assert.deepStrictEqual(notices.take(null, D).concat(notices.take(MOD, D)), []);
        visibility.show([MOD]);
        const got = notices.take(null, D).concat(notices.take(MOD, D));
        assert.ok(got.some((l) => l.endsWith('the late tools were turned off')) && got.some((l) => l.endsWith('a line about the late module')), got.join(' | '));
      });
    });

    it('load\'s, reload\'s and a notice message\'s: each session gets each once', async() => {
      await load('ci', {notice: 'ci added 1.0.0'});
      await control.reload({type: 'reload', names: [SCENARIO('ci')], dirs: {[SCENARIO('ci')]: '/x/ci'}, notice: 'ci upgraded'});
      await control.notice({type: 'notice', module: null, text: 'ci news'});
      await control.notice({type: 'notice', module: null, text: 'requestTimeout set to 60 s'});
      for (const id of [A, B, C]) assert.deepStrictEqual(all(id, 'ci').sort(), ['ci added 1.0.0', 'ci news', 'ci upgraded', 'requestTimeout set to 60 s'].sort(), id);
    });
  });

  // M6's medium review, 1-3: a message is judged as the handler it reached;
  // a notice with no module is about none (ch-local sends none so); one
  // carrying the pack form's fields is refused like any other
  describe('a message as the handler it reached', () => {
    it('a notice with no type and no module goes to every session; one with a pack field is refused, nobody told', async() => {
      await control.notice({text: 'about none'});
      assert.deepStrictEqual([A, B, C].map((id) => notices.take(null, id)), [['about none'], ['about none'], ['about none']]);
      await assert.rejects(control.notice({type: 'notice', module: null, text: 'x', pack: 'ci'}), (e) => e.code === 'CONTROL_FAILED' && /no scenario, pack, global or remoteCredentials/.test(e.message));
      assert.deepStrictEqual([A, B, C].map((id) => notices.take(null, id)), [[], [], []]);
    });

    it('an unload with no type is judged as an unload, never as a load missing its dirs', async() => {
      await load('ci');
      await control.unload({name: SCENARIO('ci'), notice: 'gone'});
      assert.deepStrictEqual(calls.filter((x) => x[0] === 'unload'), [['unload', SCENARIO('ci')]]);
    });
  });

  describe('a terminal off is an unload, which tells everyone', () => {
    it('unload of a module: every open session told once, in the message\'s words; with no notice, the tools were turned off', async() => {
      await load('docs');
      await control.unload({type: 'unload', name: SCENARIO('docs'), notice: 'docs turned off'});
      assert.deepStrictEqual([A, B, C].map((id) => all(id, 'docs')), [['docs turned off'], ['docs turned off'], ['docs turned off']]);
      await load('ci');
      await control.unload({type: 'unload', name: SCENARIO('ci')});
      assert.deepStrictEqual([A, B, C].map((id) => all(id, 'ci')), [[`the ${SCENARIO('ci')} tools were turned off`], [`the ${SCENARIO('ci')} tools were turned off`], [`the ${SCENARIO('ci')} tools were turned off`]]);
      assert.deepStrictEqual(calls.filter((c) => c[0] === 'unload'), [['unload', SCENARIO('docs')], ['unload', SCENARIO('ci')]]);
    });
  });

  describe('under --stdio, as on master', () => {
    it('a load\'s notice goes to the one queue; an unload says its notice', async() => {
      sessions.resetForTests();   // not shared
      const plain = createModuleControl({mm: {}, dm: {}, packs, toolsOf: async() => ['t'], shared: () => false});
      assert.deepStrictEqual(await plain.load({type: 'load', name: SCENARIO('ci'), dirs: {[SCENARIO('ci')]: '/x/ci'}, notice: 'ci added'}), {tools: ['t']});
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
      saved = options.modulesRoot;
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
      options.modulesRoot = [root];
    });
    afterEach(() => { options.modulesRoot = saved; fs.rmSync(root, {recursive: true, force: true}); });
    // the module form's directories (M6): each module of the closure, by package name
    const CI = '@countinghouse/ch-pack-ci';
    const TWO = '@countinghouse/ch-pack-two';
    const ciDirs = () => ({[CI]: path.join(root, 'ci', 'node_modules', '@countinghouse', 'ch-pack-ci')});
    const twoDirs = () => ({[TWO]: path.join(root, 'two', 'node_modules', '@countinghouse', 'ch-pack-two'),
      '@countinghouse/ch-step-x': path.join(root, 'two', 'node_modules', '@countinghouse', 'ch-step-x')});
    // the units loaded or loading, with their modules (packRecords went with the pack form)
    const unitsOf = (mm) => {
      const mip = require('../../lib/modules-in-place');
      const out = new Map(mip.loadedTops(mm).map((t) => [t.name, t.modules]));
      if (mm.packsLoading != null) for (const [n, l] of mm.packsLoading) out.set(n, [...l.modules]);
      return [...out].map(([name, modules]) => ({name, modules}));
    };

    // #341 review, 5: the loading record is gone whatever throws, the rollback included
    it('a load whose rollback throws leaves no loading record behind', async() => {
      const packsInPlace = require('../../lib/modules-in-place');
      let loads = 0;
      const mm = {modules: {}, unlisted: new Set(), startScenarios: [], startPlan: null, ...UNITS,
        // the first module loads, the second fails, and the rollback's unload throws
        loadModuleFromPath: (p, name, version, cb) => { loads += 1; if (loads === 1) { mm.modules[name] = {}; return cb(null); } return cb(new Error('no spawn')); },
        unloadModuleExternal: () => { throw new Error('unload threw'); }};
      await assert.rejects(packsInPlace.loadPack(mm, {type: 'load', name: TWO, dirs: twoDirs()}, {}));
      assert.strictEqual(loads, 2, 'two modules, the rollback ran');
      assert.deepStrictEqual(unitsOf(mm), []);
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
      await packsInPlace.loadPack(mm, {type: 'load', name: CI, dirs: ciDirs()}, {});
      await packsInPlace.unloadPack(mm, {type: 'unload', name: CI});
      assert.deepStrictEqual(seenMidUnload, [false], 'hidden while it unloads');
      assert.deepStrictEqual(unitsOf(mm), [], 'and gone once unloaded');
      assert.strictEqual(visibility.none(), true, 'nothing left hidden once it is out of the module map');
    });

    it('no session sees a pack between its devices\' registration and the load\'s answer', async() => {
      const packsInPlace = require('../../lib/modules-in-place');
      const seenMidLoad = [];
      const mm = {modules: {}, unlisted: new Set(), startScenarios: [], startPlan: null, ...UNITS,
        loadModuleFromPath: (p, name, version, cb) => {
          // the module's devices register now (toolschanged): what every session sees at this moment
          mm.modules[name] = {packageInfo: {version}};
          seenMidLoad.push({records: unitsOf(mm), listed: visibility.listsModule(name)});
          cb(null);
        },
        unloadModuleExternal: (name, cb) => { delete mm.modules[name]; cb(); }};
      await packsInPlace.loadPack(mm, {type: 'load', name: CI, dirs: ciDirs()}, {});
      // M4 (#413 section 5.5): what a load newly brings in is hidden from
      // every session until the load has completed
      assert.deepStrictEqual(seenMidLoad, [{records: [{name: CI, modules: [CI]}], listed: false}]);
      assert.strictEqual(visibility.listsModule('@countinghouse/ch-pack-ci'), true, 'and listed to every session once loaded');
      assert.deepStrictEqual(unitsOf(mm), [{name: CI, modules: [CI]}]);
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
      const load = (h) => require('../../lib/modules-in-place').loadPack(h.mm, {type: 'load', name: TWO, dirs: twoDirs()}, {});

      it('turned off inside the backoff: the restart never runs, and nothing of the part is left', async() => {
        const packsInPlace = require('../../lib/modules-in-place');
        const h = crashedPartRuntime();
        await load(h);
        h.crash();
        assert.strictEqual(h.mm.supervisor.status(PART).state, 'restarting', 'premise: its restart is pending');
        await packsInPlace.unloadPack(h.mm, {type: 'unload', name: TWO});
        h.backoffEnds();
        assert.deepStrictEqual(h.restarts, [], 'its restart never runs');
        assert.strictEqual(h.mm.supervisor.status(PART), null, 'its supervisor\'s record is gone');
        assert.deepStrictEqual(unitsOf(h.mm), []);
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
        await packsInPlace.unloadPack(h.mm, {type: 'unload', name: TWO});
        // lib/module-manager.js: a restart spawn whose record is no longer current terminates its worker
        assert.strictEqual(h.mm.supervisor.isCurrent(PART, h.restarts[0].record), false);
      });

      it('reloaded without the part inside the backoff: the restart never runs either', async() => {
        const packsInPlace = require('../../lib/modules-in-place');
        const h = crashedPartRuntime();
        await load(h);
        h.crash();
        fs.writeFileSync(path.join(scenario(), 'package.json'), JSON.stringify({name: '@countinghouse/ch-pack-two', version: '1.0.0', countinghouse: {role: 'scenario'}}));
        await packsInPlace.reloadPack(h.mm, {type: 'reload', names: [TWO], dirs: {[TWO]: scenario()}}, {});
        h.backoffEnds();
        assert.deepStrictEqual(h.restarts, [], 'its restart never runs');
        assert.strictEqual(h.mm.supervisor.status(PART), null);
        assert.deepStrictEqual(unitsOf(h.mm), [{name: TWO, modules: [TWO]}]);
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
          await packsInPlace.unloadPack(h.mm, {type: 'unload', name: TWO});
        } finally { LOG.W = W; }
        assert.deepStrictEqual(warned, []);
      });

      // F3-5 with F1-3: the part's spec, kept by its supervisor while it is down, is no tool before its pack goes,
      // and gone with it after; it never comes back
      // (its own timeout: it takes about 1.5 s under a loaded machine, close
      // to mocha's 2 s default, and failed one run in three at a load
      // average of about 8; the #449 review)
      it('restarting or suspended, its spec kept: no tool while down, gone with its pack, never respawned (F3-5)', async function() {
        this.timeout(5000);
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
          await packsInPlace.unloadPack(h.mm, {type: 'unload', name: TWO});
          h.backoffEnds();
          assert.deepStrictEqual(h.restarts, [], 'never respawned');
          assert.strictEqual(dm.getAllDeviceSpecs().dx, undefined, 'its spec gone with the pack');
          assert.ok(!tools(ci).includes('ch_step_x_svc_run'));
        }
      });

      it('module operations run one at a time: one arriving while another is under way is refused, and changes nothing', async() => {
        const packsInPlace = require('../../lib/modules-in-place');
        const h = crashedPartRuntime();
        await load(h);
        h.mm.packsLoading.set('@countinghouse/ch-pack-ci', {modules: ['@countinghouse/ch-pack-ci']});
        try {
          await assert.rejects(packsInPlace.unloadPack(h.mm, {type: 'unload', name: TWO}),
            (e) => e.code === 'CONTROL_FAILED' && /serialised/.test(e.message));
        } finally { h.mm.packsLoading.delete('@countinghouse/ch-pack-ci'); }
        assert.deepStrictEqual(unitsOf(h.mm), [{name: TWO, modules: [TWO, PART]}]);
        // and nothing left for the next test
        await packsInPlace.unloadPack(h.mm, {type: 'unload', name: TWO});
        assert.deepStrictEqual(unitsOf(h.mm), []);
      });
    });
  });
});

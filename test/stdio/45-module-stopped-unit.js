// M4b's medium review, server-free: the runtime's own unload of a unit
// whose module the supervisor gave up on (modules-in-place selfUnload)
// cleans up as an unload does, and the start plan under --modulesRoot
// loads only what it kept.
//  1. an expansion that throws loads only the directories checkStartPlan kept;
//  2. the unit's own allowance (a pack's file) goes with it;
//  (3., the session view cleared by the record's own key, went with the
//  session view in M5a)
//  4. the settings tool's this-start pack is cleared;
//  7. a refused start-plan module is told by its package name only;
//  8. a self-unload that leaves a module in the map restores the records
//     marked uncertain: a reload of one is refused, CONTROL_MODULE_UNCERTAIN.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {realPath} = require('../helpers/real-path');
require('../../lib/logger').createLogger();

const SVC = (s) => `urn:countinghouse-test:serviceID:${s}`;
function writeModule(dir, {name, version = '1.0.0', role, calls}) {
  fs.mkdirSync(path.join(dir, 'handlers', 'svc'), {recursive: true});
  const ch = {};
  if (role != null) ch.role = role;
  if (calls != null) ch.calls = calls;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version, countinghouse: ch}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name.replace(/^@[^/]+\//, ''), manufacturer: 't', modelDescription: name,
    serviceList: {[SVC('svc')]: {actionList: [{name: 'run', description: `run of ${name}`, input: {schema: '/svc/run/input'}, output: {schema: '/svc/run/output'}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({svc: {run: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'svc', 'run.js'), 'module.exports = async () => ({output: {}});\n');
  return dir;
}

describe('stdio 45: a unit the runtime gives up on, and the start plan (M4b medium review)', () => {
  const cli = require('../../lib/cli-options');
  const ModuleManager = require('../../lib/module-manager');
  let mip = null;
  let root = null;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-45-'));
    // a unit in the module store (M6: the module form only): a scenario and its part
    writeModule(path.join(root, 'store', 'ch-step-x', '1.0.0'), {name: 'ch-step-x', role: 'part'});
    writeModule(path.join(root, 'store', 'ch-pack-pf', '1.0.0'), {name: 'ch-pack-pf', role: 'scenario', calls: ['ch-step-x/svc.run']});
    cli.setOptions({workerThread: true, modulesRoot: [path.join(root, 'store')], requestTimeout: 5000});
    mip = require('../../lib/modules-in-place');
  });
  after(() => {
    cli.setOptions({workerThread: false});
    require('../../lib/module-visibility').resetForTests();
    fs.rmSync(root, {recursive: true, force: true});
  });

  // a stand-in module manager: loads put a module in the map; `stuck` stays
  function runtime({stuck = null} = {}) {
    const mm = Object.assign(Object.create(ModuleManager.prototype), {modules: {}, unlisted: new Set(), startScenarios: [], startPlan: null,
      supervisor: null, generations: {}, packsInPlace: null});
    mm.loadModuleFromPath = (p, name, version, cb) => {
      mm.modules[name] = {hostModuleName: name, packageInfo: {name, version}, deviceList: {[`d-${name}`]: {}}, modulePath: p};
      mm.unitLoaded(name);
      setImmediate(() => { mm.unitRegistration(name); cb(null); });
    };
    mm.unloadModuleExternal = (name, cb) => { if (name !== stuck) delete mm.modules[name]; cb(null); };
    // each case its own hidden set: one left hidden must not leak into the next
    require('../../lib/module-visibility').resetForTests();
    require('../../lib/module-visibility').configure({moduleOf: () => null, isGone: (n) => mm.modules[n] == null});
    return mm;
  }
  const pfDirs = () => ({'ch-pack-pf': path.join(root, 'store', 'ch-pack-pf', '1.0.0'), 'ch-step-x': path.join(root, 'store', 'ch-step-x', '1.0.0')});
  const loadPf = (mm) => mip.loadPack(mm, {type: 'load', name: 'ch-pack-pf', dirs: pfDirs()}, {});

  // (M5b: no settings state follows an unload: a module's on/off is the file's)
  it('2, 4: the unit\'s record goes', async () => {
    const mm = runtime();
    await loadPf(mm);
    await mip.selfUnload(mm, 'ch-step-x', 'MODULE_SUSPENDED');
    assert.strictEqual(mm.packsInPlace.has('ch-pack-pf'), false);
  });

  it('every session is told it stopped, and that a restart of countinghouse tries it again (never of one\'s client: runtime-claims 2)', async () => {
    const notices = require('../../lib/notices');
    const add = notices.add;
    const told = [];
    notices.add = (module, text) => { told.push([module, text]); };
    try {
      const mm = runtime();
      await loadPf(mm);
      await mip.selfUnload(mm, 'ch-step-x', 'MODULE_SUSPENDED');
    } finally {
      notices.add = add;
    }
    // (under no module, its tools gone: on the next result of any tool)
    assert.deepStrictEqual(told, [[null, 'ch-pack-pf stopped (MODULE_SUSPENDED); it is tried again when countinghouse restarts']]);
  });

  it('8: a module still in the map after the self-unload: the record comes back marked, and a reload of it is refused', async () => {
    const mm = runtime({stuck: 'ch-step-x'});
    await loadPf(mm);
    await mip.selfUnload(mm, 'ch-step-x', 'MODULE_SUSPENDED');
    assert.strictEqual(mm.packsInPlace.get('ch-pack-pf').uncertain, true);
    await assert.rejects(mip.reloadPack(mm, {type: 'reload', names: ['ch-pack-pf'], dirs: pfDirs()}, {}),
      (e) => e.code === 'CONTROL_MODULE_UNCERTAIN');
  });

  it('7: a refused start-plan module is told by its package name; one with none to tell by is only logged', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-45o-'));
    const named = writeModule(path.join(outside, 'named'), {name: '@t/named', role: 'scenario'});
    const nameless = path.join(outside, 'nameless');
    fs.mkdirSync(nameless);
    fs.writeFileSync(path.join(nameless, 'package.json'), 'not json');
    try {
      const r = mip.checkStartPlan([named, nameless, path.join(outside, 'missing')], []);
      assert.deepStrictEqual(r.refused, [{name: '@t/named', code: 'MODULE_PATH_OUTSIDE_ROOT'}]);
      assert.deepStrictEqual(r.tops, []);
    } finally {
      fs.rmSync(outside, {recursive: true, force: true});
    }
  });

  // C-startup-order's Low (the high on #419): the start plan judges the real
  // path it resolved, once -- what it keeps is what loads -- never the
  // directory resolved again, which a link swapped in between could answer
  // inside the root for a real path outside it
  it('the start plan judges the one real path it keeps, never the directory resolved again', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-45s-'));
    const away = writeModule(path.join(outside, 'away'), {name: '@t/away', role: 'scenario'});
    const here = writeModule(path.join(root, 'store', 'ch-pack-here', '1.0.0'), {name: 'ch-pack-here', role: 'scenario'});
    const native = fs.realpathSync.native;
    let first = true;
    // (the module's directory: outside at the first look, inside after)
    fs.realpathSync.native = (p, o) => {
      if (p === here) { const r = first ? native(away, o) : native(here, o); first = false; return r; }
      return native(p, o);
    };
    try {
      const r = mip.checkStartPlan([here], []);
      assert.deepStrictEqual(r.tops, [], `kept: ${JSON.stringify(r.tops)}`);
      // (named by the package at the real path judged)
      assert.deepStrictEqual(r.refused, [{name: '@t/away', code: 'MODULE_PATH_OUTSIDE_ROOT'}]);
    } finally {
      fs.realpathSync.native = native;
      fs.rmSync(outside, {recursive: true, force: true});
      fs.rmSync(path.join(root, 'store', 'ch-pack-here'), {recursive: true, force: true});
    }
  });

  it('1: an expansion that throws under --modulesRoot loads only the directories the start plan kept', () => {
    const store = path.join(root, 'store');
    const inside = writeModule(path.join(store, '@t', 'in', '1.0.0'), {name: '@t/in', role: 'scenario'});
    const outsideDir = writeModule(path.join(root, 'elsewhere', 'out'), {name: '@t/out', role: 'scenario'});
    const roles = require('../../lib/module-roles');
    const realExpand = roles.expandLoadList;
    roles.expandLoadList = () => { throw new Error('a malformed api.json'); };
    try {
      const mm = Object.assign(Object.create(ModuleManager.prototype), {unlisted: new Set(), modules: {}});
      mm.tellStartRefused = () => {};
      const list = mm.getModuleInfoFromPath([inside, outsideDir]);
      assert.deepStrictEqual(list.map((m) => m.name), ['@t/in']);
    } finally {
      roles.expandLoadList = realExpand;
    }
  });

  // #429's high review
  it('high 2: a module no longer given up when its turn comes is left alone', async () => {
    const mm = runtime();
    await loadPf(mm);
    await mip.selfUnload(mm, 'ch-step-x', 'MODULE_SUSPENDED', () => false);
    assert.ok(mm.packsInPlace.has('ch-pack-pf'));
    assert.ok(mm.modules['ch-step-x'] != null);
  });

  // (M5a: no session has a pack of its own, so a self-unload drops no session's pack setting)
  it('high 1: one unit\'s failure never stops the next being told', async () => {
    const mm = runtime();
    await loadPf(mm);
    // a second unit holding the same part, recorded as a start under
    // --modulesRoot records it: no ch-local pack name
    mm.packsInPlace.set('@t/ch-pack-seeded', {modules: new Map([['ch-step-x', {path: '/x', version: '1.0.0', listed: false}]]), tools: new Set(), prompts: new Set()});
    const told = [];
    const channel = require('../../lib/control-channel');
    const realTell = channel.tell;
    // one unit's telling fails: the other is still told
    channel.tell = (m) => { told.push(m.name); if (m.name === 'ch-pack-pf') throw new Error('the channel failed'); return true; };
    try {
      await mip.selfUnload(mm, 'ch-step-x', 'MODULE_SUSPENDED');
    } finally {
      channel.tell = realTell;
    }
    assert.deepStrictEqual(told.sort(), ['@t/ch-pack-seeded', 'ch-pack-pf']);
  });

  it('high 4: a top-level directory is kept, and loaded, by its checked real path', () => {
    const store = path.join(root, 'store');
    const real = writeModule(path.join(store, '@t', 'real', '1.0.0'), {name: '@t/real', role: 'scenario'});
    const link = path.join(store, 'link-to-real');
    fs.symlinkSync(real, link, 'dir');
    const r = mip.checkStartPlan([link], []);
    assert.deepStrictEqual(r.tops, [realPath(real)]);
    assert.deepStrictEqual(r.partDirs, [realPath(real)]);
  });

  it('high 3: a start refusal from the scenario expansion is told by package name only', () => {
    const roles = require('../../lib/module-roles');
    const realExpand = roles.expandLoadList;
    roles.expandLoadList = () => ({load: [], owners: new Map(), refused: [{name: '/not/a/package', code: 'PART_MISSING', part: 'x'}, {name: '@t/named', code: 'PART_MISSING', part: 'x'}]});
    try {
      const mm = Object.assign(Object.create(ModuleManager.prototype), {unlisted: new Set(), modules: {}});
      mm.tellStartRefused = () => {};
      mm.getModuleInfoFromPath([]);
      assert.deepStrictEqual(mm.startRefused.map((r) => r.name), ['@t/named']);
    } finally {
      roles.expandLoadList = realExpand;
    }
  });

  // the medium review of #429's high fixes
  describe('the medium review of the high fixes', () => {
    const storeDir = (name, version) => path.join(root, 'store', ...name.split('/'), version);
    const moduleForm = (name, version = '1.0.0') => {
      const dir = storeDir(name, version);
      if (!fs.existsSync(dir)) writeModule(dir, {name, version, role: 'scenario'});
      return {type: 'load', name, dirs: {[name]: dir}};
    };

    it('medium 1: a unit is under its package name while it loads', async () => {
      const mm = runtime();
      const seen = [];
      const load = mm.loadModuleFromPath;
      mm.loadModuleFromPath = (p, name, version, cb, opts) => { seen.push(...(mm.packsLoading || new Map()).keys()); load(p, name, version, cb, opts); };
      await mip.loadPack(mm, moduleForm('ci-failure-triage'), {});
      assert.ok(seen.length > 0);
      assert.ok(seen.every((k) => k === 'ci-failure-triage'), JSON.stringify(seen));
    });

    // (its shape is its handler's: lib/module-control.js, #455's high review, 4)
    it('medium 3: a names-only reload whose type the message leaves out is read as a reload', async () => {
      const mm = runtime();
      await mip.loadPack(mm, moduleForm('@t/ch-pack-r'), {});
      const dirs = {'@t/ch-pack-r': storeDir('@t/ch-pack-r', '1.0.0')};
      await mip.reloadPack(mm, {names: ['@t/ch-pack-r'], dirs}, {});
      assert.strictEqual(mm.modules['@t/ch-pack-r'].packageInfo.version, '1.0.0');
    });

    // (medium 2, a view rebuild that throws, went with the session view in M5a;
    // medium 7, a pack-form unit with no pack name, with the pack form in M6)
    it('medium 5: a module with no supervisor record at its turn is not given up, and nothing throws on the channel\'s chain', async () => {
      const mm = Object.assign(Object.create(ModuleManager.prototype), {generations: {'ch-step-x': 1},
        supervisor: {records: {}, isCurrent: (n, r) => mm.supervisor.records[n] === r, status: () => null}});
      const channel = require('../../lib/control-channel');
      const realEnqueue = channel.enqueue;
      let queued = null;
      channel.enqueue = (fn) => { queued = fn; return true; };
      const was = cli.controlChannel;
      cli.setOptions({controlChannel: 'ipc'});
      try {
        mm.givenUp('ch-step-x', 'MODULE_SUSPENDED');
      } finally {
        channel.enqueue = realEnqueue;
        cli.setOptions({controlChannel: was});
      }
      assert.strictEqual(typeof(queued), 'function');
      mm.packsInPlace = new Map([['ch-pack-pf', {pack: 'pf', modules: new Map([['ch-step-x', {}]])}]]);
      await queued();
      assert.ok(mm.packsInPlace.has('ch-pack-pf'), 'left alone');
    });
  });
});

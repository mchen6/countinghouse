// M4b's medium review, server-free: the runtime's own unload of a unit
// whose module the supervisor gave up on (modules-in-place selfUnload)
// cleans up as an unload does, and the start plan under --modulesRoot
// loads only what it kept.
//  1. an expansion that throws loads only the directories checkStartPlan kept;
//  2. the unit's own allowance (a pack's file) goes with it;
//  3. the session view is cleared by the record's own key (a pack's name);
//  4. the settings tool's this-start pack is cleared;
//  7. a refused start-plan module is told by its package name only;
//  8. a self-unload that leaves a module in the map restores the records
//     marked uncertain: a reload of one is refused, CONTROL_MODULE_UNCERTAIN.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
  const mmod = require('../../lib/module-manager');
  const sessionPacks = require('../../lib/session-packs');
  const settingsTool = require('../../lib/settings-tool');
  let mip = null;
  let root = null;
  let packs = null;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-45-'));
    packs = path.join(root, 'packs');
    const nm = path.join(packs, 'pf', '1.0.0', 'node_modules');
    writeModule(path.join(nm, 'ch-step-x'), {name: 'ch-step-x', role: 'part'});
    writeModule(path.join(nm, 'ch-pack-pf'), {name: 'ch-pack-pf', role: 'scenario', calls: ['ch-step-x/svc.run']});
    cli.setOptions({workerThread: true, packsRoot: [packs], modulesRoot: [path.join(root, 'store')], requestTimeout: 5000});
    mip = require('../../lib/modules-in-place');
  });
  after(() => {
    cli.setOptions({workerThread: false});
    sessionPacks.resetForTests();
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
  const scenario = () => path.join(packs, 'pf', '1.0.0', 'node_modules', 'ch-pack-pf');
  const loadPf = (mm) => mip.loadPack(mm, {type: 'load', name: 'ch-pack-pf', scenario: scenario(), pack: 'pf'}, {});

  it('2, 3, 4: the unit\'s own allowance goes, the view by its pack name, the settings tool\'s this-start pack', async () => {
    const mm = runtime();
    await loadPf(mm);
    mmod.packRemotes.set('ch-step-x', new Map([['ch-pack-pf', new Map([['https://x.example', new Set(['X'])]])]]));
    sessionPacks.setGlobal('pf', true);
    const unloaded = [];
    const real = settingsTool.packUnloaded;
    settingsTool.packUnloaded = (n) => unloaded.push(n);
    try {
      await mip.selfUnload(mm, 'ch-step-x', 'MODULE_SUSPENDED');
    } finally {
      settingsTool.packUnloaded = real;
    }
    assert.strictEqual(mmod.packRemotes.has('ch-step-x'), false, 'the pack\'s allowance went with it');
    assert.strictEqual(sessionPacks.isGlobal('pf'), false, 'the view cleared by the pack\'s own name');
    assert.deepStrictEqual(unloaded, ['ch-pack-pf']);
    assert.strictEqual(mm.packsInPlace.has('ch-pack-pf'), false);
  });

  it('8: a module still in the map after the self-unload: the record comes back marked, and a reload of it is refused', async () => {
    const mm = runtime({stuck: 'ch-step-x'});
    await loadPf(mm);
    await mip.selfUnload(mm, 'ch-step-x', 'MODULE_SUSPENDED');
    assert.strictEqual(mm.packsInPlace.get('ch-pack-pf').uncertain, true);
    await assert.rejects(mip.reloadPack(mm, {type: 'reload', name: 'ch-pack-pf', scenario: scenario(), pack: 'pf'}, {}),
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

  it('high 1: a unit with no ch-local pack name drops no pack setting, and one unit\'s failure never stops the next being told', async () => {
    const mm = runtime();
    await loadPf(mm);
    // a second unit holding the same part, recorded as a start under
    // --modulesRoot records it: no ch-local pack name
    mm.packsInPlace.set('@t/ch-pack-seeded', {form: 'module', pack: mip.moduleKey('@t/ch-pack-seeded'), modules: new Map([['ch-step-x', {path: '/x', version: '1.0.0', listed: false}]]), tools: new Set(), prompts: new Set(), allowance: null});
    const told = [];
    const channel = require('../../lib/control-channel');
    const realTell = channel.tell;
    const realUnloaded = settingsTool.packUnloaded;
    const settings = require('../../lib/session-settings');
    const realDrop = settings.dropPack;
    const dropped = [];
    channel.tell = (m) => { told.push(m.name); return true; };
    settingsTool.packUnloaded = (n) => { if (n === 'ch-pack-pf') throw new Error('settings tool failed'); };
    settings.dropPack = (k) => { dropped.push(k); return []; };
    try {
      await mip.selfUnload(mm, 'ch-step-x', 'MODULE_SUSPENDED');
    } finally {
      channel.tell = realTell;
      settingsTool.packUnloaded = realUnloaded;
      settings.dropPack = realDrop;
    }
    assert.deepStrictEqual(told.sort(), ['@t/ch-pack-seeded', 'ch-pack-pf']);
    assert.deepStrictEqual(dropped, ['pack.pf'], 'only the pack-form unit\'s pack name');
  });

  it('high 4: a top-level directory is kept, and loaded, by its checked real path', () => {
    const store = path.join(root, 'store');
    const real = writeModule(path.join(store, '@t', 'real', '1.0.0'), {name: '@t/real', role: 'scenario'});
    const link = path.join(store, 'link-to-real');
    fs.symlinkSync(real, link, 'dir');
    const r = mip.checkStartPlan([link], []);
    assert.deepStrictEqual(r.tops, [fs.realpathSync(real)]);
    assert.deepStrictEqual(r.partDirs, [fs.realpathSync(real)]);
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
});

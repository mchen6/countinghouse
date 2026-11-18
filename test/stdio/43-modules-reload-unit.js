// M4a Task 3 (#413 section 7.3; the reload's review, items 3, 4 and 5),
// server-free: the module form's reload on #423's unit machinery, driven
// through a stand-in module manager that uses the real hold
// (ModuleManager.prototype.holdDiscovery and its notes) and records the
// order of registrations and of the unit's pass.
// 3. a rollback's put-back modules have registered before the unit's pass;
// 4. only the new instance's registration counts: one the old version makes
//    during the drain (a supervised restart, say) never lets the unit end;
// 5. the hold covers only what the reload itself starts: a kept module
//    (same version) is never held.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../../lib/logger').createLogger();

const SVC = (s) => `urn:countinghouse-test:serviceID:${s}`;
function writeModule(dir, {name, version, role, calls}) {
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

describe('stdio 43: the module form\'s reload on the unit machinery (M4a items 3, 4, 5)', () => {
  const cli = require('../../lib/cli-options');
  const ModuleManager = require('../../lib/module-manager');
  const WorkerMessage = require('../../lib/worker-message');
  let mip = null;
  let root = null;
  let store = null;
  const at = (name, v) => path.join(store, ...name.split('/'), v);
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-43-'));
    store = path.join(root, 'module-store');
    for (const v of ['1.0.0', '2.0.0']) {
      writeModule(at('@t/ch-step-p', v), {name: '@t/ch-step-p', version: v, role: 'part'});
      writeModule(at('@t/ch-pack-s', v), {name: '@t/ch-pack-s', version: v, role: 'scenario', calls: ['ch-step-p/svc.run', 'ch-step-k/svc.run']});
    }
    writeModule(at('@t/ch-step-k', '1.0.0'), {name: '@t/ch-step-k', version: '1.0.0', role: 'part'});
    // 3.0.0: the scenario adds two parts, a and b (the medium review's
    // finding 1), and b calls the part being switched (finding 5)
    writeModule(at('@t/ch-step-p', '3.0.0'), {name: '@t/ch-step-p', version: '3.0.0', role: 'part'});
    writeModule(at('@t/ch-step-a', '1.0.0'), {name: '@t/ch-step-a', version: '1.0.0', role: 'part'});
    writeModule(at('@t/ch-step-b', '1.0.0'), {name: '@t/ch-step-b', version: '1.0.0', role: 'part', calls: ['ch-step-p/svc.run']});
    writeModule(at('@t/ch-pack-s', '3.0.0'), {name: '@t/ch-pack-s', version: '3.0.0', role: 'scenario',
      calls: ['ch-step-a/svc.run', 'ch-step-b/svc.run', 'ch-step-p/svc.run', 'ch-step-k/svc.run']});
    // the pack form (finding 7): <packs>/<pack>/<version>/node_modules/...
    const packs = path.join(root, 'packs');
    const pf = (v, calls) => path.join(packs, 'pf', v, 'node_modules');
    writeModule(path.join(pf('1.0.0'), 'ch-step-x'), {name: 'ch-step-x', version: '1.0.0', role: 'part'});
    writeModule(path.join(pf('1.0.0'), 'ch-pack-pf'), {name: 'ch-pack-pf', version: '1.0.0', role: 'scenario', calls: ['ch-step-x/svc.run']});
    for (const n of ['ch-step-x', 'ch-step-y', 'ch-step-w']) writeModule(path.join(pf('2.0.0'), n), {name: n, version: '1.0.0', role: 'part'});
    writeModule(path.join(pf('2.0.0'), 'ch-pack-pf'), {name: 'ch-pack-pf', version: '2.0.0', role: 'scenario', calls: ['ch-step-x/svc.run', 'ch-step-y/svc.run', 'ch-step-w/svc.run']});
    cli.setOptions({workerThread: true, modulesRoot: [store], packsRoot: [packs], requestTimeout: 5000});
    mip = require('../../lib/modules-in-place');
  });
  after(() => {
    cli.setOptions({workerThread: false});
    fs.rmSync(root, {recursive: true, force: true});
  });

  // log: the order things happen in; failVersion: a version whose spawn fails
  function runtime({failVersion = null, staleDuringDrain = null, failName = '@t/ch-pack-s'} = {}) {
    const log = [];
    const mm = Object.assign(Object.create(ModuleManager.prototype), {modules: {}, unlisted: new Set(), startScenarios: [], startPlan: null,
      supervisor: null, generations: {}, packsInPlace: null});
    const instance = (name, version) => {
      // a worker proxy: the drain reads its queue
      const wm = Object.create(WorkerMessage.prototype);
      return Object.assign(wm, {hostModuleName: name, packageInfo: {name, version}, deviceList: {[`d-${name}`]: {}}, msgQueue: {}});
    };
    const spawn = (p, name, version, cb) => {
      if (version === failVersion && name === failName) return setImmediate(() => cb(Object.assign(new Error('no spawn'), {code: 'LOAD_MODULE_FAIL'})));
      log.push(`held ${name}: ${mm.isHeld(name)}`);
      mm.modules[name] = instance(name, version);
      mm.unitLoaded(name);
      setImmediate(() => cb(null));
      // its registration, a little later
      setTimeout(() => { log.push(`registered ${name}@${version}`); mm.unitRegistration(name); }, 30);
    };
    mm.loadModuleFromPath = spawn;
    mm.loadModuleByWorker = (p, name, version, cb) => { delete mm.modules[name]; spawn(p, name, version, cb); };
    mm.unloadModuleExternal = (name, cb) => { delete mm.modules[name]; cb(null); };
    const dm = {
      verificationPass: (only) => log.push(`own pass ${[...only].join(',')}`),
      verifyModules: (names) => log.push(`unit pass ${[...names].sort().join(',')}`),
      // the drain asks the broker what the old version owes; the stale note
      // comes in then, as a restart of the old version would
      peerChannelBroker: {openInvokesTo: (old) => {
        if (staleDuringDrain != null && old.hostModuleName === staleDuringDrain) { log.push(`stale ${staleDuringDrain}`); mm.unitRegistration(staleDuringDrain); }
        return 0;
      }}
    };
    return {mm, dm, log};
  }
  const loadBoth = async (mm, dm, v) => {
    const r = await mip.loadPack(mm, {type: 'load', name: '@t/ch-pack-s', dirs: {'@t/ch-pack-s': at('@t/ch-pack-s', v), '@t/ch-step-p': at('@t/ch-step-p', v), '@t/ch-step-k': at('@t/ch-step-k', '1.0.0')}}, dm);
    assert.ok(r.modules.includes('@t/ch-step-k'));
  };
  const reloadTo = (mm, dm, v) => mip.reloadPack(mm, {type: 'reload', names: ['@t/ch-pack-s'],
    dirs: {'@t/ch-pack-s': at('@t/ch-pack-s', v), '@t/ch-step-p': at('@t/ch-step-p', v), '@t/ch-step-k': at('@t/ch-step-k', '1.0.0')}}, dm);

  const reloadTo3 = (mm, dm) => mip.reloadPack(mm, {type: 'reload', names: ['@t/ch-pack-s'],
    dirs: {'@t/ch-pack-s': at('@t/ch-pack-s', '3.0.0'), '@t/ch-step-p': at('@t/ch-step-p', '3.0.0'), '@t/ch-step-k': at('@t/ch-step-k', '1.0.0'),
      '@t/ch-step-a': at('@t/ch-step-a', '1.0.0'), '@t/ch-step-b': at('@t/ch-step-b', '1.0.0')}}, dm);

  // the medium review of M4a
  it('finding 1: a reload whose first addition fails leaves no addition hidden', async () => {
    const visibility = require('../../lib/module-visibility');
    const {mm, dm} = runtime({failVersion: '1.0.0', failName: '@t/ch-step-b'});
    visibility.configure({moduleOf: () => null, isGone: (n) => mm.modules[n] == null});
    await loadBoth(mm, dm, '1.0.0');
    await assert.rejects(reloadTo3(mm, dm));
    assert.deepStrictEqual(visibility.hiddenOf(['@t/ch-step-a', '@t/ch-step-b']), []);
    visibility.resetForTests();
  });

  it('finding 5: an addition that calls a module the reload switches is verified after that switch', async () => {
    const {mm, dm, log} = runtime();
    await loadBoth(mm, dm, '1.0.0');
    log.length = 0;
    await reloadTo3(mm, dm);
    const switched = log.indexOf('registered @t/ch-step-p@3.0.0');
    const ownB = log.findIndex((l) => l.startsWith('own pass') && l.includes('@t/ch-step-b'));
    const ownA = log.findIndex((l) => l.startsWith('own pass') && l.includes('@t/ch-step-a'));
    assert.ok(switched >= 0 && ownB > switched, log.join('\n'));
    assert.ok(ownA >= 0 && ownA < switched, 'an addition calling nothing switched is verified at once');
  });

  it('finding 8: a module-form reload of a unit recorded in the pack form is refused', async () => {
    const {mm, dm} = runtime();
    await loadBoth(mm, dm, '1.0.0');
    const rec = mm.packsInPlace.get('@t/ch-pack-s');
    rec.form = undefined;
    rec.pack = 'ci';
    await assert.rejects(reloadTo(mm, dm, '2.0.0'), (e) => e.code === 'CONTROL_FAILED' && /pack form/.test(e.message));
    assert.strictEqual(mm.packsInPlace.get('@t/ch-pack-s').pack, 'ci');
  });

  describe('finding 3: a load sets the allowance of the modules it brings in only', () => {
    const credentials = require('../../lib/remote/credentials');
    let saved = null;
    const ORIGIN = 'https://api.example.com';
    before(() => {
      saved = credentials.snapshot();
      const file = path.join(root, 'allow.json');
      fs.writeFileSync(file, JSON.stringify({version: 2, modules: {'@t/ch-step-k': {[ORIGIN]: {K: 'COUNTINGHOUSE_CREDENTIAL_1'}, 'https://api.other.com': {K2: 'COUNTINGHOUSE_CREDENTIAL_2'}}}}));
      credentials.configure(file);
    });
    after(() => credentials.restore(saved));

    it('an already-loaded module keeps its allowance whatever a later load\'s credentials name', async () => {
      const {mm, dm} = runtime();
      await loadBoth(mm, dm, '1.0.0');
      const before = credentials.moduleEntry('@t/ch-step-k');
      // a part as a top-level unit: it lists no tool of its own
      writeModule(at('@t/ch-pack-z', '1.0.0'), {name: '@t/ch-pack-z', version: '1.0.0', role: 'part', calls: ['ch-step-k/svc.run']});
      await mip.loadPack(mm, {type: 'load', name: '@t/ch-pack-z', dirs: {'@t/ch-pack-z': at('@t/ch-pack-z', '1.0.0'), '@t/ch-step-k': at('@t/ch-step-k', '1.0.0')},
        credentials: {'@t/ch-step-k': {[ORIGIN]: {K: 'COUNTINGHOUSE_CREDENTIAL_1'}}}}, dm);
      assert.strictEqual(credentials.moduleEntry('@t/ch-step-k'), before, 'not narrowed to the later message\'s subset');
    });

    it('an unload puts back the binding the start\'s file gave (finding 2)', async () => {
      const {mm, dm} = runtime();
      await loadBoth(mm, dm, '1.0.0');
      await mip.unloadPack(mm, {type: 'unload', name: '@t/ch-pack-s'});
      const e = credentials.moduleEntry('@t/ch-step-k');
      assert.ok(e != null && e.get(ORIGIN).get('K') === 'COUNTINGHOUSE_CREDENTIAL_1', 'the start\'s binding stays for the next load');
    });
  });

  it('finding 7: a pack-form reload shows each part it adds once that part has loaded, not at the end', async () => {
    const visibility = require('../../lib/module-visibility');
    const {mm, dm} = runtime();
    visibility.configure({moduleOf: () => null, isGone: (n) => mm.modules[n] == null});
    const seen = [];
    const spawn = mm.loadModuleFromPath;
    mm.loadModuleFromPath = (p, name, version, cb) => { if (name === 'ch-step-w') seen.push(visibility.isHidden('ch-step-y')); spawn(p, name, version, cb); };
    const scenario = (v) => path.join(root, 'packs', 'pf', v, 'node_modules', 'ch-pack-pf');
    await mip.loadPack(mm, {type: 'load', name: 'ch-pack-pf', scenario: scenario('1.0.0')}, dm);
    await mip.reloadPack(mm, {type: 'reload', name: 'ch-pack-pf', scenario: scenario('2.0.0')}, dm);
    assert.deepStrictEqual(seen, [false], 'y shown before w loads');
    visibility.resetForTests();
  });

  it('5: the hold covers what the reload switches, never a kept module', async () => {
    const {mm, dm, log} = runtime();
    await loadBoth(mm, dm, '1.0.0');
    log.length = 0;
    await reloadTo(mm, dm, '2.0.0');
    assert.ok(log.includes('held @t/ch-step-p: true') && log.includes('held @t/ch-pack-s: true'), log.join('\n'));
    assert.ok(!log.some((l) => l.startsWith('held @t/ch-step-k')), 'the kept module is not spawned again');
    assert.strictEqual(mm.isHeld('@t/ch-step-k'), false);
    assert.ok(log.includes('unit pass @t/ch-pack-s,@t/ch-step-p'), log.join('\n'));
  });

  it('3: a rollback\'s put-back modules have registered before the unit\'s pass', async () => {
    const {mm, dm, log} = runtime({failVersion: '2.0.0'});
    await loadBoth(mm, dm, '1.0.0');
    log.length = 0;
    await assert.rejects(reloadTo(mm, dm, '2.0.0'));
    const putBack = log.lastIndexOf('registered @t/ch-step-p@1.0.0');
    const pass = log.findIndex((l) => l.startsWith('unit pass'));
    assert.ok(putBack >= 0 && pass > putBack, log.join('\n'));
  });

  it('4: a registration the old version makes during the drain does not count; the unit waits for the new instance\'s', async () => {
    const {mm, dm, log} = runtime({staleDuringDrain: '@t/ch-step-p'});
    await loadBoth(mm, dm, '1.0.0');
    log.length = 0;
    await reloadTo(mm, dm, '2.0.0');
    const stale = log.indexOf('stale @t/ch-step-p');
    const fresh = log.indexOf('registered @t/ch-step-p@2.0.0');
    const pass = log.findIndex((l) => l.startsWith('unit pass'));
    assert.ok(stale >= 0 && fresh > stale && pass > fresh, log.join('\n'));
  });
});

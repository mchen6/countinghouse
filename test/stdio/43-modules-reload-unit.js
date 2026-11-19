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
  // many fixture modules written at once: past mocha's 2 s on a slow
  // Windows runner (#425's run), so a bound of its own
  before(function() {
    this.timeout(60000);
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
  // unloadDuring: {name, when: 'drain' | 'spawn' | 'registration' | 'after'
  // (once its switch is done) | 'unload' (a restarting one's unload)}: an
  // operator unload (POST /unload-module: a generation of its own, the module
  // off the map) in that window of the module's switch
  function runtime({failVersion = null, staleDuringDrain = null, failName = '@t/ch-pack-s', unloadDuring = null} = {}) {
    const log = [];
    const mm = Object.assign(Object.create(ModuleManager.prototype), {modules: {}, unlisted: new Set(), startScenarios: [], startPlan: null,
      supervisor: null, generations: {}, packsInPlace: null});
    const instance = (name, version, p) => {
      // a worker proxy: the drain reads its queue
      const wm = Object.create(WorkerMessage.prototype);
      return Object.assign(wm, {hostModuleName: name, packageInfo: {name, version}, deviceList: {[`d-${name}`]: {}}, msgQueue: {}, modulePath: p});
    };
    const operatorUnload = (name) => { log.push(`operator unload ${name}`); mm.nextGeneration(name); delete mm.modules[name]; };
    const unloadsIn = (name, when) => unloadDuring != null && unloadDuring.name === name && unloadDuring.when === when && !log.includes(`operator unload ${name}`);
    // switching: a reload's switch spawning it (loadModuleByWorker), the only
    // spawn an unloadDuring 'spawn' or 'registration' acts in
    // (loadModuleFromPath's fifth argument is its options: only the stub's
    // own loadModuleByWorker passes true)
    const spawn = (p, name, version, cb, how) => {
      const switching = how === true;
      // the unload-then-load branch's load (loadOne: options, not true)
      const branchLoad = how != null && how !== true && how.generation != null;
      if (version === failVersion && name === failName) return setImmediate(() => cb(Object.assign(new Error('no spawn'), {code: 'LOAD_MODULE_FAIL'})));
      log.push(`held ${name}: ${mm.isHeld(name)}`);
      const wm = instance(name, version, p);
      mm.modules[name] = wm;
      mm.unitLoaded(name);
      if (switching && unloadsIn(name, 'spawn')) operatorUnload(name);
      if (branchLoad && unloadsIn(name, 'load')) operatorUnload(name);
      setImmediate(() => cb(null));
      // its registration, a little later (its devices from then on)
      const late = switching && unloadDuring != null && unloadDuring.name === name && unloadDuring.when === 'registration';
      if (late) wm.deviceList = {};
      setTimeout(() => {
        if (late && unloadsIn(name, 'registration')) return operatorUnload(name);
        if (late) wm.deviceList = {[`d-${name}`]: {}};
        log.push(`registered ${name}@${version}`);
        mm.unitRegistration(name);
        if (switching && unloadsIn(name, 'after')) operatorUnload(name);
      }, 30);
    };
    mm.loadModuleFromPath = spawn;
    // the real one's contract (lib/module-manager.js): a reload's generation,
    // held through the spawn; one moved meanwhile answers MODULE_LOAD_SUPERSEDED
    const SUPERSEDED = (name) => Object.assign(new Error(`${name}: superseded`), {code: 'MODULE_LOAD_SUPERSEDED'});
    mm.loadModuleByWorker = (p, name, version, cb, {generation = null} = {}) => {
      if (generation != null && mm.generations[name] !== generation) return cb(SUPERSEDED(name));
      delete mm.modules[name];
      spawn(p, name, version, (err) => cb(err == null && generation != null && mm.generations[name] !== generation ? SUPERSEDED(name) : err), true);
    };
    mm.unloadModuleExternal = (name, cb) => {
      delete mm.modules[name];
      if (unloadsIn(name, 'unload')) operatorUnload(name);
      cb(null);
    };
    const dm = {
      verificationPass: (only) => log.push(`own pass ${[...only].join(',')}`),
      verifyModules: (names) => log.push(`unit pass ${[...names].sort().join(',')}`),
      // the drain asks the broker what the old version owes; the stale note
      // comes in then, as a restart of the old version would
      peerChannelBroker: {openInvokesTo: (old) => {
        if (staleDuringDrain != null && old.hostModuleName === staleDuringDrain) { log.push(`stale ${staleDuringDrain}`); mm.unitRegistration(staleDuringDrain); }
        if (unloadsIn(old.hostModuleName, 'drain') && mm.modules[old.hostModuleName] === old) operatorUnload(old.hostModuleName);
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
    mm.loadModuleFromPath = (p, name, version, cb, opts) => { if (name === 'ch-step-w') seen.push(visibility.isHidden('ch-step-y')); spawn(p, name, version, cb, opts); };
    const scenario = (v) => path.join(root, 'packs', 'pf', v, 'node_modules', 'ch-pack-pf');
    await mip.loadPack(mm, {type: 'load', name: 'ch-pack-pf', scenario: scenario('1.0.0')}, dm);
    await mip.reloadPack(mm, {type: 'reload', name: 'ch-pack-pf', scenario: scenario('2.0.0')}, dm);
    assert.deepStrictEqual(seen, [false], 'y shown before w loads');
    visibility.resetForTests();
  });

  // #427's high review
  it('high 5: a load whose module entered the map and then failed takes it out again; nothing stays hidden', async () => {
    const visibility = require('../../lib/module-visibility');
    const {mm, dm} = runtime();
    visibility.configure({moduleOf: () => null, isGone: (n) => mm.modules[n] == null});
    const spawn = mm.loadModuleFromPath;
    mm.loadModuleFromPath = (p, name, version, cb, opts) => {
      if (name === '@t/ch-step-p') { mm.modules[name] = {packageInfo: {name, version}, deviceList: {}}; return setImmediate(() => cb(new Error('registered, then failed'))); }
      return spawn(p, name, version, cb, opts);
    };
    await assert.rejects(loadBoth(mm, dm, '1.0.0'));
    assert.strictEqual(mm.modules['@t/ch-step-p'], undefined, 'rolled back');
    assert.deepStrictEqual(visibility.hiddenOf(['@t/ch-step-p', '@t/ch-pack-s', '@t/ch-step-k']), []);
    visibility.resetForTests();
  });

  it('high 3: a switched module with nothing to switch back to makes the failure uncertain, not all-or-none', async () => {
    const {mm, dm} = runtime({failVersion: '2.0.0'});
    await loadBoth(mm, dm, '1.0.0');
    // the record no longer names p, and the loaded module says no path
    mm.packsInPlace.get('@t/ch-pack-s').modules.delete('@t/ch-step-p');
    delete mm.modules['@t/ch-step-p'].modulePath;
    await assert.rejects(reloadTo(mm, dm, '2.0.0'), (e) => e.code === 'CONTROL_MODULE_UNCERTAIN');
  });

  it('a switched module with no record entry is switched back to the loaded module\'s own path and version (medium 6)', async () => {
    const {mm, dm, log} = runtime({failVersion: '2.0.0'});
    await loadBoth(mm, dm, '1.0.0');
    mm.packsInPlace.get('@t/ch-pack-s').modules.delete('@t/ch-step-p');
    await assert.rejects(reloadTo(mm, dm, '2.0.0'), (e) => e.code !== 'CONTROL_MODULE_UNCERTAIN');
    assert.ok(log.includes('registered @t/ch-step-p@1.0.0'), log.join('\n'));
    assert.strictEqual(mm.modules['@t/ch-step-p'].packageInfo.version, '1.0.0');
  });

  it('medium 1: a trusted ceiling\'s modules list binds the pack form too', async () => {
    const settingsTool = require('../../lib/settings-tool');
    const {mm, dm} = runtime();
    settingsTool.ceilingForControl(() => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {packs: null, modules: ['ch-pack-pf']}}));
    try {
      const scenario = path.join(root, 'packs', 'pf', '1.0.0', 'node_modules', 'ch-pack-pf');
      await assert.rejects(mip.loadPack(mm, {type: 'load', name: 'ch-pack-pf', scenario}, dm), (e) => e.code === 'SETTING_FORBIDDEN_BY_CEILING' && /enabled\.ch-step-x/.test(e.message));
    } finally {
      settingsTool.ceilingForControl(() => ({state: 'none'}));
    }
  });

  it('high 8: the pack form\'s rollback hides an addition before unloading it', async () => {
    const visibility = require('../../lib/module-visibility');
    const {mm, dm} = runtime();
    visibility.configure({moduleOf: () => null, isGone: (n) => mm.modules[n] == null});
    const scenario = (v) => path.join(root, 'packs', 'pf', v, 'node_modules', 'ch-pack-pf');
    // 2.0.0's closure switches the scenario, then adds y, then w; w fails,
    // so the rollback unloads y, which was shown once it loaded
    const seen = [];
    const unload = mm.unloadModuleExternal;
    mm.unloadModuleExternal = (name, cb) => { if (name === 'ch-step-y') seen.push(visibility.isHidden(name)); unload(name, cb); };
    await mip.loadPack(mm, {type: 'load', name: 'ch-pack-pf', scenario: scenario('1.0.0')}, dm);
    const spawn = mm.loadModuleFromPath;
    mm.loadModuleFromPath = (p, name, version, cb, opts) => (name === 'ch-step-w' ? setImmediate(() => cb(new Error('no spawn'))) : spawn(p, name, version, cb, opts));
    await assert.rejects(mip.reloadPack(mm, {type: 'reload', name: 'ch-pack-pf', scenario: scenario('2.0.0')}, dm));
    assert.deepStrictEqual(seen, [true], 'hidden when its unload starts');
    visibility.resetForTests();
  });

  describe('high 7: a reload\'s credentials are authoritative for every module it names', () => {
    const credentials = require('../../lib/remote/credentials');
    let saved = null;
    const ORIGIN = 'https://api.example.com';
    const entryFor = (slot) => ({[ORIGIN]: {K: slot}});
    before(() => {
      saved = credentials.snapshot();
      const file = path.join(root, 'allow7.json');
      fs.writeFileSync(file, JSON.stringify({version: 2, modules: {'@t/ch-step-p': entryFor('COUNTINGHOUSE_CREDENTIAL_1'),
        '@t/ch-step-k': Object.assign(entryFor('COUNTINGHOUSE_CREDENTIAL_2'), {'https://api.other.com': {K2: 'COUNTINGHOUSE_CREDENTIAL_3'}})}}));
      credentials.configure(file);
    });
    after(() => credentials.restore(saved));

    it('a switched module named with no credentials loses its allowance (a revoke); a kept one too, and its remote is registered again', async () => {
      const {mm, dm} = runtime();
      const reregistered = [];
      mm.reRegisterRemotes = (name) => reregistered.push(name);
      await mip.loadPack(mm, {type: 'load', name: '@t/ch-pack-s', dirs: {'@t/ch-pack-s': at('@t/ch-pack-s', '1.0.0'), '@t/ch-step-p': at('@t/ch-step-p', '1.0.0'), '@t/ch-step-k': at('@t/ch-step-k', '1.0.0')},
        credentials: {'@t/ch-step-p': entryFor('COUNTINGHOUSE_CREDENTIAL_1'), '@t/ch-step-k': entryFor('COUNTINGHOUSE_CREDENTIAL_2')}}, dm);
      await reloadTo(mm, dm, '2.0.0');
      assert.strictEqual(credentials.moduleEntry('@t/ch-step-p'), undefined, 'revoked with the switch');
      assert.strictEqual(credentials.moduleEntry('@t/ch-step-k'), undefined, 'revoked, though kept');
      assert.deepStrictEqual(reregistered, ['@t/ch-step-k'], 'the kept module\'s remote takes it now');
    });

    it('medium 2: a module-form load is authoritative for what it brings in: absent credentials, none', async () => {
      const {mm, dm} = runtime();
      await loadBoth(mm, dm, '1.0.0');
      assert.strictEqual(credentials.moduleEntry('@t/ch-step-p'), undefined, 'the start bound p, but the load named none for it');
    });

    it('medium 3: a module another unnamed unit holds changes its credentials only with every holder named', async () => {
      const {mm, dm} = runtime();
      mm.reRegisterRemotes = () => {};
      await loadBoth(mm, dm, '1.0.0');
      writeModule(at('@t/ch-pack-y', '1.0.0'), {name: '@t/ch-pack-y', version: '1.0.0', role: 'part', calls: ['ch-step-k/svc.run']});
      await mip.loadPack(mm, {type: 'load', name: '@t/ch-pack-y', dirs: {'@t/ch-pack-y': at('@t/ch-pack-y', '1.0.0'), '@t/ch-step-k': at('@t/ch-step-k', '1.0.0')}}, dm);
      await assert.rejects(mip.reloadPack(mm, {type: 'reload', names: ['@t/ch-pack-s'], dirs: {'@t/ch-pack-s': at('@t/ch-pack-s', '2.0.0'), '@t/ch-step-p': at('@t/ch-step-p', '2.0.0'), '@t/ch-step-k': at('@t/ch-step-k', '1.0.0')},
        credentials: {'@t/ch-step-k': entryFor('COUNTINGHOUSE_CREDENTIAL_2')}}, dm), (e) => e.code === 'CONTROL_FAILED' && /every loaded module that holds it/.test(e.message));
      assert.strictEqual(mm.modules['@t/ch-pack-s'].packageInfo.version, '1.0.0', 'nothing changed');
    });

    it('medium 5: a reload that fails before its unit is held changes no allowance', async () => {
      const {mm, dm} = runtime();
      mm.reRegisterRemotes = () => {};
      await mip.loadPack(mm, {type: 'load', name: '@t/ch-pack-s', dirs: {'@t/ch-pack-s': at('@t/ch-pack-s', '1.0.0'), '@t/ch-step-p': at('@t/ch-step-p', '1.0.0'), '@t/ch-step-k': at('@t/ch-step-k', '1.0.0')},
        credentials: {'@t/ch-step-p': entryFor('COUNTINGHOUSE_CREDENTIAL_1'), '@t/ch-step-k': entryFor('COUNTINGHOUSE_CREDENTIAL_2')}}, dm);
      mm.holdDiscovery = () => { throw new Error('bookkeeping'); };
      await assert.rejects(reloadTo(mm, dm, '2.0.0'));
      assert.strictEqual(credentials.moduleEntry('@t/ch-step-k').get(ORIGIN).get('K'), 'COUNTINGHOUSE_CREDENTIAL_2');
    });

    it('medium 8: the same credentials in another order are no change: the kept module\'s remote is not rebuilt', async () => {
      const {mm, dm} = runtime();
      const reregistered = [];
      mm.reRegisterRemotes = (n) => reregistered.push(n);
      const ab = {[ORIGIN]: {K: 'COUNTINGHOUSE_CREDENTIAL_2'}, 'https://api.other.com': {K2: 'COUNTINGHOUSE_CREDENTIAL_3'}};
      const ba = {'https://api.other.com': {K2: 'COUNTINGHOUSE_CREDENTIAL_3'}, [ORIGIN]: {K: 'COUNTINGHOUSE_CREDENTIAL_2'}};
      await mip.loadPack(mm, {type: 'load', name: '@t/ch-pack-s', dirs: {'@t/ch-pack-s': at('@t/ch-pack-s', '1.0.0'), '@t/ch-step-p': at('@t/ch-step-p', '1.0.0'), '@t/ch-step-k': at('@t/ch-step-k', '1.0.0')},
        credentials: {'@t/ch-step-k': ab}}, dm);
      await mip.reloadPack(mm, {type: 'reload', names: ['@t/ch-pack-s'], dirs: {'@t/ch-pack-s': at('@t/ch-pack-s', '2.0.0'), '@t/ch-step-p': at('@t/ch-step-p', '2.0.0'), '@t/ch-step-k': at('@t/ch-step-k', '1.0.0')},
        credentials: {'@t/ch-step-k': ba}}, dm);
      assert.deepStrictEqual(reregistered, []);
    });

    it('a kept module given credentials takes them', async () => {
      const {mm, dm} = runtime();
      mm.reRegisterRemotes = () => {};
      await loadBoth(mm, dm, '1.0.0');
      credentials.dropModule('@t/ch-step-k');
      credentials.setModule('@t/ch-step-k', new Map());
      await mip.reloadPack(mm, {type: 'reload', names: ['@t/ch-pack-s'], dirs: {'@t/ch-pack-s': at('@t/ch-pack-s', '2.0.0'), '@t/ch-step-p': at('@t/ch-step-p', '2.0.0'), '@t/ch-step-k': at('@t/ch-step-k', '1.0.0')},
        credentials: {'@t/ch-step-k': entryFor('COUNTINGHOUSE_CREDENTIAL_2')}}, dm);
      assert.strictEqual(credentials.moduleEntry('@t/ch-step-k').get(ORIGIN).get('K'), 'COUNTINGHOUSE_CREDENTIAL_2');
    });
  });

  it('high 1: a reload\'s notice outside a shared runtime goes under its first name', async () => {
    const notices = require('../../lib/notices');
    notices.resetForTests();
    const control = require('../../lib/module-control').createPackControl({mm: {}, dm: {}, toolsOf: async () => [], shared: () => false,
      packs: {reloadPack: async () => ({modules: []}), loadPack: async () => ({modules: []}), unloadPack: async () => ({modules: []})}});
    await control.reload({type: 'reload', names: ['@t/a', '@t/b'], dirs: {}, notice: 'a and b upgraded'});
    assert.deepStrictEqual(notices.take('@t/a'), ['a and b upgraded']);
    assert.deepStrictEqual(notices.take('@t/b'), ['a and b upgraded'], 'under each name (medium 10)');
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

  // the back-sweep's group 3 and the Reviewer's high review of #441 (3, 4,
  // 6): the reload's generation is taken before the drain and held through
  // the spawn and the registration, so an operator action on the module in
  // any of the three windows stands the switch down, and the rollback never
  // brings that module back over it
  // the high review of #442, 1: a module left to a later operator action
  // makes the reload uncertain (never a plain all-or-none failure), naming it
  const leftToOperator = (e) => e.code === 'CONTROL_MODULE_UNCERTAIN' && /@t\/ch-step-p was left to a later operator action/.test(e.message);

  for (const when of ['drain', 'spawn', 'registration']) {
    it(`an operator unload during the switch's ${when} fails the reload, and nothing brings that module back`, async () => {
      const {mm, dm, log} = runtime({unloadDuring: {name: '@t/ch-step-p', when}});
      await loadBoth(mm, dm, '1.0.0');
      log.length = 0;
      await assert.rejects(reloadTo(mm, dm, '2.0.0'), leftToOperator);
      const at = log.indexOf('operator unload @t/ch-step-p');
      assert.ok(at >= 0, log.join('\n'));
      assert.ok(!log.slice(at + 1).some((l) => /^held @t\/ch-step-p/.test(l)), `no spawn of ch-step-p after the unload:\n${log.join('\n')}`);
      assert.strictEqual(mm.modules['@t/ch-step-p'], undefined, 'it stays unloaded');
      // the unit's record no longer says what runs: a reload of it is refused
      await assert.rejects(reloadTo(mm, dm, '2.0.0'), (e) => e.code === 'CONTROL_MODULE_UNCERTAIN' && /left to a later operator action; restart your client/.test(e.message));
    });
  }

  it('the real loadModuleByWorker holds a reload\'s generation: a moved one is MODULE_LOAD_SUPERSEDED before and after the spawn', async () => {
    const mm = Object.assign(Object.create(ModuleManager.prototype), {modules: {}, generations: {}, spawnsPending: {}, supervisor: null, endedDevices: {}});
    const spawned = [];
    mm.spawnModuleWorker = (p, name, version, settle, current) => spawned.push({settle, current});
    const load = (gen) => new Promise((resolve) => mm.loadModuleByWorker('/x', 'ch-step-x', '2.0.0', (err) => resolve(err), {generation: gen}));
    const gen = mm.nextGeneration('ch-step-x');
    mm.nextGeneration('ch-step-x');   // an unload before the spawn
    assert.strictEqual((await load(gen)).code, 'MODULE_LOAD_SUPERSEDED');
    assert.strictEqual(spawned.length, 0, 'no worker spawned');
    const gen2 = mm.nextGeneration('ch-step-x');
    const pending = load(gen2);
    assert.strictEqual(spawned.length, 1);
    assert.strictEqual(spawned[0].current(), true, 'the spawn holds the reload\'s own generation');
    mm.nextGeneration('ch-step-x');   // an unload during the spawn
    assert.strictEqual(spawned[0].current(), false);
    spawned[0].settle(null);
    assert.strictEqual((await pending).code, 'MODULE_LOAD_SUPERSEDED');
  });

  // the medium on the rebuilt #441, 1: an operator action on a module whose
  // switch had finished is not undone when a later step fails
  it('an operator unload after a module\'s switch finished, then a later switch fails: the rollback puts the rest back and leaves that module', async () => {
    const {mm, dm, log} = runtime({failVersion: '2.0.0', unloadDuring: {name: '@t/ch-step-p', when: 'after'}});
    await loadBoth(mm, dm, '1.0.0');
    log.length = 0;
    await assert.rejects(reloadTo(mm, dm, '2.0.0'), leftToOperator);
    const at = log.indexOf('operator unload @t/ch-step-p');
    assert.ok(at >= 0, log.join('\n'));
    assert.ok(!log.slice(at + 1).some((l) => /^held @t\/ch-step-p/.test(l)), `no spawn of ch-step-p after the unload:\n${log.join('\n')}`);
    assert.strictEqual(mm.modules['@t/ch-step-p'], undefined, 'it stays unloaded');
    assert.strictEqual(mm.modules['@t/ch-pack-s'].packageInfo.version, '1.0.0', 'the failed one is put back');
  });

  // and 2: a switch of a module not held by a live worker (replaceDrainThenSwitch's
  // other branch: its unload, then its load) holds the reload's generation
  // too, checked after its unload and after its load (single-thread
  // loadModuleFromPath takes none: the high review of #442, 3)
  for (const when of ['unload', 'load']) it(`a switch through the unload-then-load branch that an operator unload during its ${when} outranks stands down`, async () => {
    const {mm, dm, log} = runtime({unloadDuring: {name: '@t/ch-step-p', when}});
    await loadBoth(mm, dm, '1.0.0');
    // in the map, but no worker of its own (that branch's case)
    mm.modules['@t/ch-step-p'] = {hostModuleName: '@t/ch-step-p', packageInfo: {name: '@t/ch-step-p', version: '1.0.0'}, deviceList: {}};
    log.length = 0;
    await assert.rejects(reloadTo(mm, dm, '2.0.0'), leftToOperator);
    const at = log.indexOf('operator unload @t/ch-step-p');
    assert.ok(at >= 0, log.join('\n'));
    assert.ok(!log.slice(at + 1).some((l) => /^held @t\/ch-step-p/.test(l)), `no spawn of ch-step-p after the unload:\n${log.join('\n')}`);
  });
});

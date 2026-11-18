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
    cli.setOptions({workerThread: true, modulesRoot: [store], requestTimeout: 5000});
    mip = require('../../lib/modules-in-place');
  });
  after(() => {
    cli.setOptions({workerThread: false});
    fs.rmSync(root, {recursive: true, force: true});
  });

  // log: the order things happen in; failVersion: a version whose spawn fails
  function runtime({failVersion = null, staleDuringDrain = null} = {}) {
    const log = [];
    const mm = Object.assign(Object.create(ModuleManager.prototype), {modules: {}, unlisted: new Set(), startScenarios: [], startPlan: null,
      supervisor: null, generations: {}, packsInPlace: null});
    const instance = (name, version) => {
      // a worker proxy: the drain reads its queue
      const wm = Object.create(WorkerMessage.prototype);
      return Object.assign(wm, {hostModuleName: name, packageInfo: {name, version}, deviceList: {[`d-${name}`]: {}}, msgQueue: {}});
    };
    const spawn = (p, name, version, cb) => {
      if (version === failVersion && name === '@t/ch-pack-s') return setImmediate(() => cb(Object.assign(new Error('no spawn'), {code: 'LOAD_MODULE_FAIL'})));
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

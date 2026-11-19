// #9 under the lean worker (the back-sweep's group 3, 11-18), server-free: a
// restarted worker that ends after its load acknowledgement but before its
// devices are registered keeps the devices the supervisor kept from the
// exit before. Its tools stay listed and its device answers the
// supervisor's state.
//
// Why a unit test, not a server one: under the lean worker a worker's
// devices are registered from the main thread's own spec one main-thread
// turn after its load acknowledgement (onModuleLoad: handOn, then
// setImmediate). Module code cannot place a crash inside that turn. A
// message the worker posts before it exits is still processed, and the
// deferred registration runs in the same loop iteration, before the exit
// event. The startup order holds a registration only before that module's
// first turn, when nothing has been kept yet. So sandbox 28, written for
// the discovery round trip, now crashes after registration. This pins the
// logic of both halves with the module taken off inside that turn:
// - the deferred registration, which then registers nothing and settles
//   nothing;
// - the exit's specs (specsAtExit), which carry the kept ones over.
const assert = require('assert');
const events = require('events');
require('../../lib/logger').createLogger();

describe('stdio 48: a restarted worker that ends before its devices are registered keeps them (#9, lean worker)', () => {
  const cli = require('../../lib/cli-options');
  const ModuleManager = require('../../lib/module-manager');
  const ModuleSupervisor = require('../../lib/module-supervisor');
  const WorkerMessage = require('../../lib/worker-message');
  before(() => cli.setOptions({workerThread: true}));
  after(() => cli.setOptions({workerThread: false}));

  const NAME = 'ch-step-x';
  const SPEC = {deviceID: 'D-x', friendlyName: NAME};
  function runtime() {
    const mm = Object.create(ModuleManager.prototype);
    events.EventEmitter.call(mm);
    Object.assign(mm, {modules: {}, unlisted: new Set(), endedDevices: {}, generations: {}, startupOrder: null, units: null, startScenarios: [], startPlan: null,
      supervisor: new ModuleSupervisor({setTimer: () => 0, clearTimer: () => {}, restart: () => {}})});
    const registered = [];
    mm.on('registerdevices', (wm) => registered.push(wm));
    return {mm, registered};
  }
  const worker = (deviceList = {}) => Object.assign(Object.create(WorkerMessage.prototype), {hostModuleName: NAME, packageInfo: {name: NAME, version: '1.0.0'}, deviceList, msgQueue: {}});
  // the first worker's exit, as its exit handler records it
  const firstExit = (mm) => {
    mm.supervisor.track(NAME, {modulePath: '/m', version: '1.0.0'});
    const specs = mm.specsAtExit(NAME, worker({'D-x': SPEC}));
    mm.markEndedDevices(Object.keys(specs), NAME, 'MODULE_RESTARTING');
    assert.strictEqual(mm.supervisor.exited(NAME, 'crash', specs, null).action, 'restart');
  };
  const turn = () => new Promise((r) => setImmediate(() => setImmediate(r)));

  it('ended inside the turn between its load acknowledgement and registration: nothing registered, nothing settled, the kept spec carried over', async () => {
    const {mm, registered} = runtime();
    firstExit(mm);
    // the restarted worker acknowledges its load (its device list is empty
    // until registration) ...
    mm.supervisor.track(NAME, {modulePath: '/m', version: '1.0.0'});
    const restarted = worker();
    mm.onModuleLoad(NAME, restarted, '1.0.0');
    assert.strictEqual(mm.modules[NAME], restarted);
    // ... and ends in the same turn: its exit handler takes it off
    const specs = mm.specsAtExit(NAME, restarted);
    assert.deepStrictEqual(specs, {'D-x': SPEC}, 'the kept spec carries over');
    mm.markEndedDevices(Object.keys(specs), NAME, 'MODULE_RESTARTING');
    delete mm.modules[NAME];
    mm.supervisor.exited(NAME, 'crash again', specs, null);
    await turn();
    assert.deepStrictEqual(registered, [], 'the deferred registration registered nothing');
    assert.strictEqual(mm.endedDevices['D-x'].code, 'MODULE_RESTARTING', 'not settled as unloaded');
    assert.deepStrictEqual(mm.supervisor.previousSpecs(NAME), {'D-x': SPEC});
    assert.ok(Object.hasOwn(mm.supervisor.retainedSpecs(), 'D-x'), 'still listed while it restarts');
  });

  it('(contrast) not ended: the deferred registration registers it, a turn later', async () => {
    const {mm, registered} = runtime();
    firstExit(mm);
    mm.supervisor.track(NAME, {modulePath: '/m', version: '1.0.0'});
    const restarted = worker();
    mm.onModuleLoad(NAME, restarted, '1.0.0');
    assert.deepStrictEqual(registered, [], 'not in the same turn');
    await turn();
    assert.deepStrictEqual(registered, [restarted]);
  });
});

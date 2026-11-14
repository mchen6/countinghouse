// The guard in DeviceManager's registerFromSpec, server-free: a worker that
// is going -- being unloaded, already ended, or no longer its module's
// current worker -- has nothing registered for it when its load is
// acknowledged, or it would undo what the unload recorded (the device's
// ended entry) and leave a device the purge then drops as DEVICE_NOT_FOUND.
// (It guarded the worker's 'deviceonline' until lean worker step 3, Task 4,
// registered a worker's device from the main thread's spec at its load.) A
// current worker's device is registered, so the guard is shown to tell the
// cases apart.
const assert = require('assert');
const {EventEmitter} = require('events');

const MODULE = 'going-worker-module';

describe('module-loading 22: nothing is registered for a worker that is going', function() {
  // Requiring the device manager loads much of the runtime: 30 s, as 18 has.
  this.timeout(30000);
  let DeviceManager = null;
  // The main thread's copy of the module's spec (lib/module-spec.js), which
  // is what is registered, so only the guard decides.
  let own = null;
  let DEVICE = null;
  // The info lines logged, in place of the logger (none in this process).
  const LOG = require('../../lib/logger');
  const logged = [];
  let info = null;
  before(async () => {
    require('../../lib/cli-options').setOptions({workerThread: true});
    DeviceManager = require('../../lib/device-manager');
    own = await require('../../lib/module-spec').fromParts({device: {friendlyName: MODULE}}, null);
    DEVICE = own.deviceID;
    info = LOG.I;
    LOG.I = (line) => { logged.push(String(line)); return line; };
  });
  after(() => {
    LOG.I = info;
    require('../../lib/cli-options').setOptions({workerThread: false});
  });
  beforeEach(() => { logged.length = 0; });
  const refused = () => logged.some((l) => l === `module: ${MODULE}: a worker that is going loaded; its device was not registered`);

  // A device manager's own state, and a worker message whose load is
  // acknowledged; `shape` makes the worker going, or not.
  function announce(shape) {
    const wm = new EventEmitter();
    wm.deviceList = {};
    wm.moduleSpec = own;
    wm.hostModulePath = '/host/going-worker-module';
    wm.hostModuleName = MODULE;
    wm.hostPackageInfo = {name: MODULE};
    const cleared = [];
    const dm = {
      deviceMap: {},
      allDevicesLoaded: true,
      toolsetChanged: () => {},
      notifyDeviceLoad: {},
      moduleManager: {modules: {[MODULE]: wm}, clearEndedDevice: (id) => { cleared.push(id); }}
    };
    shape(wm, dm);
    DeviceManager.prototype.registerFromSpec.call(dm, wm);
    return {dm, wm, cleared};
  }

  it('a worker being unloaded', () => {
    const {dm, wm, cleared} = announce((w) => { w.unloading = true; });
    assert.deepStrictEqual(Object.keys(dm.deviceMap), []);
    assert.deepStrictEqual(wm.deviceList, {});
    assert.deepStrictEqual(cleared, [], 'the ended entry is kept');
    assert.ok(refused(), logged.join('\n'));
  });

  it('a worker that has ended', () => {
    const {dm, wm} = announce((w) => { w.ended = {code: 'MODULE_UNLOADED'}; });
    assert.deepStrictEqual(Object.keys(dm.deviceMap), []);
    assert.deepStrictEqual(wm.deviceList, {});
    assert.ok(refused(), logged.join('\n'));
  });

  it('a worker its module has replaced', () => {
    const {dm, wm} = announce((w, d) => { d.moduleManager.modules[MODULE] = new EventEmitter(); });
    assert.deepStrictEqual(Object.keys(dm.deviceMap), []);
    assert.deepStrictEqual(wm.deviceList, {});
    assert.ok(refused(), logged.join('\n'));
  });

  it('the module\'s current worker: registered, and its ended entry cleared', () => {
    const {dm, wm, cleared} = announce(() => {});
    assert.strictEqual(dm.deviceMap[DEVICE], wm);
    assert.ok(wm.deviceList[DEVICE] != null);
    assert.deepStrictEqual(cleared, [DEVICE]);
    assert.ok(!refused(), logged.join('\n'));
  });
});

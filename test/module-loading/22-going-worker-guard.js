// The guard in DeviceManager.onWorkerLoaded's 'deviceonline' handler,
// server-free: a device announced by a worker that is going -- being
// unloaded, already ended, or no longer its module's current worker -- is not
// registered, or it would undo what the unload recorded (the device's ended
// entry) and leave a device the purge then drops as DEVICE_NOT_FOUND. Its
// end-to-end test (sandbox 30) re-announced the device from module code,
// which the one module format no longer allows; the guard is kept as a
// defence against a late discover answer, and pinned here (reviewer,
// 2026-11-13). A current worker's announcement is registered, so the guard is
// shown to tell the cases apart.
const assert = require('assert');
const {EventEmitter} = require('events');

const MODULE = 'going-worker-module';
const DEVICE = 'going-worker-device-id';

describe('module-loading 22: a device announced by a worker that is going is not registered', function() {
  // Requiring the device manager loads much of the runtime: 30 s, as 18 has.
  this.timeout(30000);
  let DeviceManager = null;
  // The info lines logged, in place of the logger (none in this process).
  const LOG = require('../../lib/logger');
  const logged = [];
  let info = null;
  before(() => {
    require('../../lib/cli-options').setOptions({workerThread: true});
    DeviceManager = require('../../lib/device-manager');
    info = LOG.I;
    LOG.I = (line) => { logged.push(String(line)); return line; };
  });
  after(() => {
    LOG.I = info;
    require('../../lib/cli-options').setOptions({workerThread: false});
  });
  beforeEach(() => { logged.length = 0; });
  const refused = () => logged.some((l) => l === `module: ${MODULE}: a device announced by a worker that is going was not registered`);

  // A device manager's own state, and a worker message that announces one
  // device; `shape` makes the worker going, or not.
  function announce(shape) {
    const wm = new EventEmitter();
    wm.deviceList = {};
    wm.hostModulePath = '/host/going-worker-module';
    const cleared = [];
    const dm = {
      deviceMap: {},
      allDevicesLoaded: true,
      notifyDeviceLoad: {},
      moduleManager: {modules: {[MODULE]: wm}, clearEndedDevice: (id) => { cleared.push(id); }}
    };
    shape(wm, dm);
    DeviceManager.prototype.onWorkerLoaded.call(dm, wm);
    wm.emit('deviceonline', {data: {deviceID: DEVICE, moduleName: MODULE, packageInfo: {name: MODULE},
      spec: {device: {friendlyName: MODULE}}, modulePath: '/app'}}, wm);
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

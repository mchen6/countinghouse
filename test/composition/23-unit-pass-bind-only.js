'use strict';
// A unit loaded in place is verified in one pass scoped to it
// (DeviceManager.prototype.verifyModules, lib/packs-in-place.js unitDone):
// its own modules as any re-verification (a failure unbinds), and a module
// outside it that declares a call to one of its devices bind-only: a
// success binds it, a failure leaves the verdict it holds (a caller of a
// module a reload dropped still answers DEVICE_NOT_FOUND at the call, as
// after an unload). A module that calls nothing in the unit is not verified.
// Server-free: the devices are worker proxies with the pass's own helpers
// stubbed (verification, the relay into the worker).
const assert = require('assert');
const LOG = require('../../lib/logger');
LOG.createLogger();
const DeviceManager = require('../../lib/device-manager');
const WorkerMessage = require('../../lib/worker-message');
const callAddress = require('../../lib/call-address');

describe('composition 23: a unit\'s pass, its callers outside it bound only', () => {
  // a worker proxy for module `name`, hosting the device named `name`, that
  // declares `calls`
  const proxy = (name, calls = []) => {
    const wm = Object.create(WorkerMessage.prototype);
    const deviceID = callAddress.deviceIDForName(name);
    Object.assign(wm, {hostModuleName: name, deviceList: {[deviceID]: {device: {friendlyName: name}}},
      packageInfo: {name, countinghouse: {calls}}, modulePath: `/m/${name}`, bindings: {[deviceID]: {identity: 'before', module: name, targets: new Set(['kept'])}}});
    return {wm, deviceID};
  };

  function manager(outcomes) {
    const dm = Object.create(DeviceManager.prototype);
    dm.deviceMap = {};
    dm.notifyDeviceLoad = {};
    dm.allDevicesLoaded = true;
    dm._compositionStartupDone = true;
    dm.moduleManager = {};
    const rec = {verified: [], relayed: [], cleared: []};
    for (const [name, calls] of Object.entries(outcomes.modules)) {
      const {wm, deviceID} = proxy(name, calls);
      dm.deviceMap[deviceID] = wm;
    }
    dm.verifyComposition = (deviceID, spec, packageInfo, modulePath, moduleName, cb) => {
      rec.verified.push(moduleName);
      if (outcomes.fails.includes(moduleName)) return cb(new Error(`${moduleName}: a target is not found`));
      return cb(null, {identity: 'key', allowed: {}, targets: []});
    };
    dm.relayComposition = (wm, msg, cb) => { rec.relayed.push([wm.hostModuleName, msg.identity != null ? 'bound' : 'unbound']); cb(null); };
    dm.clearBinding = (wm) => { rec.cleared.push(wm.hostModuleName); };
    dm.announceReady = () => {};
    dm.announceDiscovered = () => {};
    return {dm, rec};
  }

  it('the unit\'s own: verified; a caller outside it that verifies: bound; one that fails: keeps what it holds; one calling nothing in it: not verified', () => {
    const {dm, rec} = manager({
      modules: {'q': [], 'c-ok': ['q/svc.act'], 'c-fail': ['q/svc.act', 'gone/svc.act'], 'other': ['elsewhere/svc.act']},
      fails: ['c-fail'],
    });
    const failing = dm.deviceMap[callAddress.deviceIDForName('c-fail')];
    dm.verifyModules(['q']);
    assert.deepStrictEqual(rec.verified.sort(), ['c-fail', 'c-ok', 'q']);
    assert.deepStrictEqual(rec.relayed.sort(), [['c-ok', 'bound'], ['q', 'bound']]);
    assert.deepStrictEqual(rec.cleared, [], 'nothing unbound');
    assert.strictEqual(failing.bindings[callAddress.deviceIDForName('c-fail')].identity, 'before', 'the failing caller keeps its binding');
  });

  it('a module of the unit that fails is unbound, as any re-verification\'s', () => {
    const {dm, rec} = manager({modules: {'q': ['gone/svc.act']}, fails: ['q']});
    dm.verifyModules(['q']);
    assert.deepStrictEqual(rec.cleared, ['q']);
    assert.deepStrictEqual(rec.relayed, [['q', 'unbound']]);
  });

  it('before the start\'s own pass, nothing: the start\'s pass verifies what there is', () => {
    const {dm, rec} = manager({modules: {'q': []}, fails: []});
    dm._compositionStartupDone = false;
    dm.verifyModules(['q']);
    assert.deepStrictEqual(rec.verified, []);
  });
});

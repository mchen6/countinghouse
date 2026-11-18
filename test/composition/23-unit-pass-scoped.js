'use strict';
// A unit loaded in place is verified in one pass scoped to the modules it
// added and the modules outside it that call them
// (DeviceManager.prototype.verifyModules, lib/packs-in-place.js unitDone),
// as any re-verification: bound, or unbound on a failure (fail closed; a
// caller whose grant is gone is never kept bound). A module that calls
// nothing in the unit is not verified, and a unit with no device left runs
// no pass.
// Server-free: the devices are worker proxies with the pass's own helpers
// stubbed (verification, the relay into the worker).
const assert = require('assert');
const LOG = require('../../lib/logger');
LOG.createLogger();
const DeviceManager = require('../../lib/device-manager');
const WorkerMessage = require('../../lib/worker-message');
const callAddress = require('../../lib/call-address');

describe('composition 23: a unit\'s pass, scoped to the modules it added and their callers', () => {
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

  it('the unit\'s own and its callers outside it are verified: bound, or unbound on a failure (fail closed); a module calling nothing in it is not', () => {
    const {dm, rec} = manager({
      modules: {'q': [], 's': ['q/svc.act'], 'c-ok': ['q/svc.act'], 'c-revoked': ['q/svc.act'], 'other': ['elsewhere/svc.act']},
      fails: ['c-revoked'],
    });
    dm.verifyModules(['q', 's']);
    assert.deepStrictEqual(rec.verified.sort(), ['c-ok', 'c-revoked', 'q', 's']);
    assert.deepStrictEqual(rec.relayed.sort(), [['c-ok', 'bound'], ['c-revoked', 'unbound'], ['q', 'bound'], ['s', 'bound']]);
    assert.deepStrictEqual(rec.cleared, ['c-revoked'], 'a caller that fails is unbound, never kept');
  });

  it('a unit with no device left (rolled back) runs no pass, and says nothing', () => {
    const {dm, rec} = manager({modules: {'other': ['elsewhere/svc.act']}, fails: []});
    let ready = 0;
    dm.announceReady = () => { ready += 1; };
    dm.verifyModules(['gone']);
    assert.deepStrictEqual(rec.verified, []);
    assert.strictEqual(ready, 0);
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

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
const callTokens = require('../../lib/call-tokens');
const cli = require('../../lib/cli-options');
const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');

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

  // A module loaded after the start that fails its first verification is never purged (a re-verification never purges): it serves
  // its own actions. It is given its verdict, unbound, so a call to it is not held for one that never comes (each would wait out the
  // hold and answer CTX_CALL_NOT_READY), and a call already held goes on.
  describe('a module first verified after the start, failing', () => {
    let kept = null;
    before(() => { kept = optionsNow(); cli.setOptions({workerThread: true, requestTimeout: 30}); });
    after(() => restoreOptions(kept));
    it('gets its verdict, unbound, and a call held for it goes on', async () => {
      const {dm} = manager({modules: {'late': ['gone/svc.act']}, fails: ['late']});
      dm.clearBinding = DeviceManager.prototype.clearBinding;
      const deviceID = callAddress.deviceIDForName('late');
      const wm = dm.deviceMap[deviceID];
      delete wm.bindings[deviceID];
      let held = null;
      dm.untilVerdict(deviceID, null, (state) => { held = state; });
      assert.strictEqual(held, null, 'held: no verdict yet');
      dm.verifyModules(['late']);
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(callTokens.hasVerdict(wm, deviceID), 'a verdict');
      assert.strictEqual(wm.bindings[deviceID].identity, null, 'unbound');
      assert.strictEqual(held, 'landed');
    });

    // (the module reloaded while a call was held for its first verdict: the verdict lands on the new copy)
    it('a call held on a copy a reload replaced is answered not ready at once when the new copy\'s verdict lands, never sent to the old', async () => {
      const {dm} = manager({modules: {'late': []}, fails: []});
      const deviceID = callAddress.deviceIDForName('late');
      const old = dm.deviceMap[deviceID];
      delete old.bindings[deviceID];
      let held = null;
      dm.untilVerdict(deviceID, null, (state) => { held = state; });
      const fresh = proxy('late').wm;
      delete fresh.bindings[deviceID];
      dm.deviceMap[deviceID] = fresh;
      dm.verifyModules(['late']);
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(callTokens.hasVerdict(fresh, deviceID) && !callTokens.hasVerdict(old, deviceID), 'the new copy has the verdict, the old none');
      assert.strictEqual(held, 'bound', 'answered now (CTX_CALL_NOT_READY), not at the bound');
    });
  });

  it('before the start\'s own pass, nothing: the start\'s pass verifies what there is', () => {
    const {dm, rec} = manager({modules: {'q': []}, fails: []});
    dm._compositionStartupDone = false;
    dm.verifyModules(['q']);
    assert.deepStrictEqual(rec.verified, []);
  });
});

'use strict';
// M4a, the multi-name reload's review (the Reviewer, after #423's high
// review), items 1, 2, 6 and 7, server-free:
// 1. while a unit is in progress, a full pass (some other load's) verifies
//    neither its modules nor the modules outside it that call one of them;
// 2. at the unit's end its callers outside it are re-verified fail closed,
//    except that a target not loaded (and nothing else wrong) keeps their
//    binding: their call to it answers DEVICE_NOT_FOUND, as after an
//    unload; verifyComposition says not-loaded only once every other
//    address has checked out, so a revoked grant is never hidden behind it;
// 6. a module the reload dropped is not in the unit: its callers are not
//    re-verified;
// 7. the unit's pass sets no allDevicesLoaded and drains no
//    notifyDeviceLoad: another load's window stays its own.
const assert = require('assert');
const LOG = require('../../lib/logger');
LOG.createLogger();
const DeviceManager = require('../../lib/device-manager');
const WorkerMessage = require('../../lib/worker-message');
const callAddress = require('../../lib/call-address');

describe('composition 24: a reload unit\'s pass (M4a items 1, 2, 6, 7)', () => {
  const proxy = (name, calls = []) => {
    const wm = Object.create(WorkerMessage.prototype);
    const deviceID = callAddress.deviceIDForName(name);
    Object.assign(wm, {hostModuleName: name, deviceList: {[deviceID]: {device: {friendlyName: name}}},
      packageInfo: {name, countinghouse: {calls}}, modulePath: `/m/${name}`, bindings: {[deviceID]: {identity: 'before', module: name, targets: new Set(['kept'])}}});
    return {wm, deviceID};
  };
  const notLoaded = (msg) => Object.defineProperty(new Error(msg), 'targetNotFound', {value: true});

  function manager({modules, held = [], outcomes = {}, offMap = {}}) {
    const dm = Object.create(DeviceManager.prototype);
    dm.deviceMap = {};
    dm.notifyDeviceLoad = {};
    dm.allDevicesLoaded = true;
    dm._compositionStartupDone = true;
    dm.moduleManager = {isHeld: (n) => held.includes(n)};
    // a device out of the map (mid-switch) still says its module
    dm.moduleOfDevice = (id) => {
      for (const [n] of Object.entries(Object.assign({}, modules, offMap))) if (callAddress.deviceIDForName(n) === id) return n;
      return null;
    };
    const rec = {verified: [], relayed: [], cleared: []};
    for (const [name, calls] of Object.entries(modules)) {
      const {wm, deviceID} = proxy(name, calls);
      dm.deviceMap[deviceID] = wm;
    }
    dm.verifyComposition = (deviceID, spec, packageInfo, modulePath, moduleName, cb) => {
      rec.verified.push(moduleName);
      const o = outcomes[moduleName];
      if (o === 'not-loaded') return cb(notLoaded(`${moduleName}: a target is not loaded`));
      if (o === 'revoked') return cb(new Error(`${moduleName}: no grant`));
      return cb(null, {identity: 'key', allowed: {}, targets: []});
    };
    dm.relayComposition = (wm, msg, cb) => { rec.relayed.push([wm.hostModuleName, msg.identity != null ? 'bound' : 'unbound']); cb(null); };
    dm.clearBinding = (wm) => { rec.cleared.push(wm.hostModuleName); };
    dm.announceReady = () => {};
    dm.announceDiscovered = () => {};
    return {dm, rec};
  }

  it('1: a full pass while a unit is in progress leaves its modules, and the modules outside it that call them, alone', () => {
    // m is mid-switch: out of the map, held; c calls it; o calls nothing held
    const {dm, rec} = manager({modules: {'c': ['m/svc.act'], 'o': ['x/svc.act'], 'x': []}, held: ['m'], offMap: {m: []}});
    dm.verificationPass(null);
    assert.deepStrictEqual(rec.verified.sort(), ['o', 'x']);
    assert.deepStrictEqual(rec.cleared, []);
  });

  it('2: at the unit\'s end, a caller outside it whose only failure is a target not loaded keeps its binding; one with any other failure is unbound', () => {
    const {dm, rec} = manager({modules: {'m': [], 'c-gone': ['m/svc.act'], 'c-revoked': ['m/svc.act'], 'c-ok': ['m/svc.act']},
      outcomes: {'c-gone': 'not-loaded', 'c-revoked': 'revoked'}});
    dm.verifyModules(['m']);
    assert.deepStrictEqual(rec.verified.sort(), ['c-gone', 'c-ok', 'c-revoked', 'm']);
    assert.deepStrictEqual(rec.cleared, ['c-revoked'], 'kept on not-loaded, cleared on a revoked grant');
    assert.ok(!rec.relayed.some(([n]) => n === 'c-gone'), 'its binding untouched');
  });

  it('2: a module of the unit itself that fails is unbound, a target not loaded included (fail closed)', () => {
    const {dm, rec} = manager({modules: {'m': ['gone/svc.act']}, outcomes: {m: 'not-loaded'}});
    dm.verifyModules(['m']);
    assert.deepStrictEqual(rec.cleared, ['m']);
  });

  it('6: a module the reload dropped is not in the unit: its callers are not re-verified', () => {
    // d was dropped (out of the map, not in the unit); c calls d; the unit is m
    const {dm, rec} = manager({modules: {'m': [], 'c': ['d/svc.act']}, offMap: {d: []}});
    dm.verifyModules(['m']);
    assert.deepStrictEqual(rec.verified, ['m']);
  });

  // the medium review of M4a, finding 4: a caller a full pass skipped (it
  // calls a held module) is in the unit's pass even when the unit rolled
  // back and its target is out of the map; never verified before, it gets a
  // verdict (unbound: fail closed), not none
  it('a caller skipped while the unit was held gets a verdict at the unit\'s end, though the unit rolled back', () => {
    const {dm, rec} = manager({modules: {'c': ['h/svc.act']}, offMap: {h: []}, outcomes: {c: 'not-loaded'}});
    // c was never verified: no binding
    const cid = Object.keys(dm.deviceMap)[0];
    delete dm.deviceMap[cid].bindings;
    dm.verifyModules(['h']);
    assert.deepStrictEqual(rec.verified, ['c']);
    assert.deepStrictEqual(rec.relayed, [['c', 'unbound']], 'a verdict, unbound');
  });

  it('7: the unit\'s pass leaves another load\'s window as it is', () => {
    const {dm} = manager({modules: {'m': []}});
    dm.allDevicesLoaded = false;
    const waiting = [{wm: {}, msgID: 1}];
    dm.notifyDeviceLoad = {'some-device': waiting};
    dm.verifyModules(['m']);
    assert.strictEqual(dm.allDevicesLoaded, false);
    assert.strictEqual(dm.notifyDeviceLoad['some-device'], waiting);
  });

  describe('2: verifyComposition says a target is not loaded only when nothing else is wrong', () => {
    const verify = (declared, {missing = [], denied = []}) => new Promise((resolve) => {
      const dm = Object.create(DeviceManager.prototype);
      dm.deviceMap = {};
      dm.moduleManager = {};
      dm.emit = (event, id, cb) => {
        const name = declared.map((a) => callAddress.parseAddress(a).device).find((n) => callAddress.deviceIDForName(n) === id);
        if (missing.includes(name)) return cb(new Error('not found'));
        cb(null, {spec: {device: {serviceList: {'urn:t:serviceID:svc': {actionList: [{name: 'act'}]}}}}});
      };
      const auth = require('../../lib/auth');
      const real = auth.getAuthProvider;
      auth.getAuthProvider = () => ({authenticate: (key, id, svc, act, cb) => cb(null, {ok: !denied.some((n) => callAddress.deviceIDForName(n) === id)}),
        identityForModule: (name, cb) => cb(null, {apiKey: 'k'})});
      const restore = () => { auth.getAuthProvider = real; };
      try {
        dm.verifyComposition('dev', {device: {friendlyName: 'caller'}}, {name: 'caller', countinghouse: {calls: declared}}, '/m/caller', 'caller', (err, comp) => { restore(); resolve({err, comp}); });
      } catch (e) { restore(); resolve({err: e}); }
    });

    it('one target not loaded, the rest fine: targetNotFound', async () => {
      const {err} = await verify(['a/svc.act', 'b/svc.act'], {missing: ['a']});
      assert.ok(err != null && err.targetNotFound === true, String(err && err.message));
    });

    it('one target not loaded and another\'s grant revoked: the revoked grant is the answer, never hidden', async () => {
      const {err} = await verify(['a/svc.act', 'b/svc.act'], {missing: ['a'], denied: ['b']});
      assert.ok(err != null && err.targetNotFound !== true, String(err && err.message));
      assert.match(err.message, /no grant/);
    });
  });
});

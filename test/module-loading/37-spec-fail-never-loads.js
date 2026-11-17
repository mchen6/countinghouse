'use strict';
// A module whose device fails its spec check never loads, whatever the
// options: the retired --verifyModule let it through (it fell through
// DEVICE_SPEC_VALIDATION_FAIL, INVALID_MODULE_INSTANCE, the interface check
// and even DEVICE_OBJECT_CONFLICT, and registered the device anyway).
// Server-free: DeviceManager.prototype.onDeviceOnline, the single-thread
// path, with a stub module manager.
const assert = require('assert');
const options = require('../../lib/cli-options');
options.setOptions({workerThread: false});
const LOG = require('../../lib/logger');
LOG.createLogger();
const DeviceManager = require('../../lib/device-manager');
const CHDevice = require('../../lib/countinghouse-device');

const stubModuleManager = () => ({on: () => {}});
// the validator answers through a callback: let it run
const settle = () => new Promise((r) => setTimeout(r, 50));
const good = () => ({device: {friendlyName: 'spec-ok', manufacturer: 'countinghouse-test', modelDescription: 'module-loading 37', serviceList: {}}});

describe('module-loading 37: a module that fails its spec check never loads', () => {
  afterEach(() => { delete options.verifyModule; });

  for (const stale of [undefined, true]) {
    it(`a device whose spec fails validation is not registered${stale ? ' (an old --verifyModule set on the options too)' : ''}`, async () => {
      if (stale) options.verifyModule = true;
      const dm = new DeviceManager(stubModuleManager());
      // no modelDescription: the meta-schema requires one
      const device = new CHDevice({device: {friendlyName: 'spec-bad', manufacturer: 'countinghouse-test', serviceList: {}}});
      dm.onDeviceOnline(device, {}, 'spec-bad-module', {name: 'spec-bad-module'}, '/modules/spec-bad');
      await settle();
      assert.deepStrictEqual(Object.keys(dm.deviceMap), [], 'never in the device map');
      assert.notStrictEqual(device.online, true, 'never online');
    });

    it(`a device with no module instance is not registered${stale ? ' (an old --verifyModule set too)' : ''}`, async () => {
      if (stale) options.verifyModule = true;
      const dm = new DeviceManager(stubModuleManager());
      const device = new CHDevice(good());
      dm.onDeviceOnline(device, null, 'no-instance', {name: 'no-instance'}, '/modules/no-instance');
      await settle();
      assert.deepStrictEqual(Object.keys(dm.deviceMap), []);
    });

    it(`a device whose deviceID another module holds does not replace it${stale ? ' (an old --verifyModule set too)' : ''}`, async () => {
      if (stale) options.verifyModule = true;
      const dm = new DeviceManager(stubModuleManager());
      const device = new CHDevice(good());
      const holder = {modulePath: '/modules/holder'};
      dm.deviceMap[device.deviceID] = holder;
      dm.onDeviceOnline(device, {}, 'incoming', {name: 'incoming'}, '/modules/incoming');
      await settle();
      assert.strictEqual(dm.deviceMap[device.deviceID], holder, 'the holder is untouched');
    });
  }

  it('a good device registers (the harness reaches the registration)', async () => {
    const dm = new DeviceManager(stubModuleManager());
    const device = new CHDevice(good());
    dm.onDeviceOnline(device, {}, 'spec-ok-module', {name: 'spec-ok-module'}, '/modules/spec-ok');
    await settle();
    assert.strictEqual(dm.deviceMap[device.deviceID], device);
  });
});

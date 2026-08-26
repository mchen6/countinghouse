// Exercises DeviceManager.prototype.onWorkerLoaded's 'deviceonline' handler
// directly, in-process, with no real worker thread.
//
// This is a separate file from 00-duplicate-device-id.js on purpose: that
// file's header explains device-id-conflict.js has no requires so it can be
// tested without pulling in the whole runtime. Requiring lib/device-manager
// here (which pulls in redis-client creation, PeerChannelBroker, etc.) would
// break that isolation for every test in the same file, so it gets its own.
//
// Why this file exists: 00-duplicate-device-id.js only unit-tests
// conflictingModulePath() in isolation. A prior round deleted both of that
// function's call sites from device-manager.js entirely and the whole test
// suite still passed, because nothing exercised the call sites themselves.
// This file closes that hole for the worker-mode call site by driving the
// real handler wired in onWorkerLoaded.
//
// lib/worker-message.js's WorkerMessage is a plain EventEmitter
// (util.inherits) and the real deviceonline event is emitted internally as
// `this.emit('deviceonline', msg, this)`. So the handler can be triggered
// the same way here with `wm.emit('deviceonline', {data: {...}}, wm)` on a
// `new WorkerMessage(null)` -- no worker_threads Worker required. The
// conflict branch returns before any redis/rate-limiter code runs, and the
// non-conflict branch only touches redis if the spec sets a rateLimit,
// which these specs don't -- so no network is needed either way.
const assert = require('assert');

// lib/device-manager.js (transitively, via lib/oauth/oauth.js and
// lib/countinghouse-util.js) creates a redis client at require() time using
// options.redisUrl, which is only populated by cli-options.setOptions().
// Outside of framework.js's normal startup nothing calls that, so requiring
// device-manager.js cold throws before this file's own tests even run.
// bin/countinghouse-validate.js hits the same problem for the same reason
// and fixes it the same way: call setOptions({}) for its defaults (real
// redisUrl 'redis://127.0.0.1:6379') before requiring anything downstream.
require('../../lib/cli-options').setOptions({});

// Likewise, the conflict branch under test logs via LOG.E(), which calls
// into a bunyan logger that only exists after LOG.createLogger() runs --
// normally done once by framework.js at startup. lib/sandbox.js hits this
// same gap and fixes it the same way (LOG.createLogger(false) at require
// time), so this mirrors an existing pattern rather than inventing one.
const LOG = require('../../lib/logger');
LOG.createLogger(false);

const DeviceManager = require('../../lib/device-manager');
const WorkerMessage = require('../../lib/worker-message');

// DeviceManager's constructor only ever calls mm.on(...) to wire its own
// listeners; nothing else on mm is touched by the path under test.
function stubModuleManager() {
  return {on: () => {}};
}

function emitDeviceOnline(wm, data) {
  wm.emit('deviceonline', {data: data}, wm);
}

describe('worker-mode deviceonline handler: conflict guard', () => {
  it('a refused (conflicting) registration mutates nothing on the WorkerMessage or deviceMap', () => {
    const deviceManager = new DeviceManager(stubModuleManager());
    const wm = new WorkerMessage(null);

    const deviceID = 'conflict-device-id';
    const existingEntry = {modulePath: '/modules/holder'};
    deviceManager.deviceMap[deviceID] = existingEntry;

    deviceManager.onWorkerLoaded(wm);

    emitDeviceOnline(wm, {
      deviceID: deviceID,
      spec: {device: {friendlyName: 'colliding-name'}},
      moduleName: 'incoming-module',
      packageInfo: {name: 'incoming-module'},
      modulePath: '/modules/incoming'
    });

    // Nothing on wm was touched -- these are all still constructor defaults.
    assert.strictEqual(wm.moduleName, null);
    assert.strictEqual(wm.packageInfo, null);
    assert.strictEqual(wm.modulePath, null);
    assert.deepStrictEqual(wm.deviceList, {});
    assert.strictEqual(wm.online, undefined);

    // The original registration is untouched.
    assert.strictEqual(deviceManager.deviceMap[deviceID], existingEntry);
  });

  it('a non-conflicting registration completes normally', () => {
    const deviceManager = new DeviceManager(stubModuleManager());
    const wm = new WorkerMessage(null);

    const deviceID = 'ok-device-id';
    const spec = {device: {friendlyName: 'unique-name'}};

    deviceManager.onWorkerLoaded(wm);

    emitDeviceOnline(wm, {
      deviceID: deviceID,
      spec: spec,
      moduleName: 'a-module',
      packageInfo: {name: 'a-module'},
      modulePath: '/modules/a'
    });

    assert.strictEqual(wm.moduleName, 'a-module');
    assert.deepStrictEqual(wm.packageInfo, {name: 'a-module'});
    assert.strictEqual(wm.modulePath, '/modules/a');
    assert.strictEqual(wm.deviceList[deviceID], spec);
    assert.strictEqual(wm.online, true);
    assert.strictEqual(deviceManager.deviceMap[deviceID], wm);
  });
});

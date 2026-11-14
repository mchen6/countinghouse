// Exercises DeviceManager.prototype.registerFromSpec (what a worker's load
// acknowledgement registers, from the main thread's own spec; it was the
// worker's 'deviceonline' handler until lean worker step 3, Task 4)
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
// This file closes that hole for the worker-mode call site by driving
// registerFromSpec on a `new WorkerMessage(null)` -- no worker_threads Worker
// required. The conflict branch returns before any redis code runs, and the
// non-conflict branch doesn't touch redis -- so no network is needed either
// way.
const assert = require('assert');

// lib/device-manager.js (transitively, via lib/oauth/oauth.js and
// lib/countinghouse-util.js) creates a redis client at require() time using
// options.redisUrl, which is only populated by cli-options.setOptions().
// Outside of framework.js's normal startup nothing calls that, so requiring
// device-manager.js cold throws before this file's own tests even run.
// bin/countinghouse-validate.js hits the same problem for the same reason
// and fixes it the same way: call setOptions({workerThread: false}) for its defaults (real
// redisUrl 'redis://127.0.0.1:6379') before requiring anything downstream.
require('../../lib/cli-options').setOptions({workerThread: false});

// Likewise, the conflict branch under test logs via LOG.E(), which calls
// into a bunyan logger that only exists after LOG.createLogger() runs --
// normally done once by framework.js at startup. lib/lean-worker.js hits this
// same gap and fixes it the same way (LOG.createLogger(false) at require
// time), so this mirrors an existing pattern rather than inventing one.
const LOG = require('../../lib/logger');
LOG.createLogger(false);

const DeviceManager = require('../../lib/device-manager');
const WorkerMessage = require('../../lib/worker-message');
const moduleSpec = require('../../lib/module-spec');

// The main thread's copy of the module's spec (lib/module-spec.js): a worker's
// device is registered only when it matches, and then as that copy. Each
// worker here announces exactly its own spec, so the handler reaches the
// branches under test.
// A worker whose load was acknowledged: the main thread's own spec, module
// name, host path and pinned package.json are what registerFromSpec reads.
async function workerWithSpec(friendlyName, moduleName, modulePath) {
  const wm = new WorkerMessage(null);
  wm.moduleSpec = await moduleSpec.fromParts({device: {friendlyName: friendlyName}}, null);
  wm.hostModuleName = moduleName;
  wm.hostModulePath = modulePath;
  wm.hostPackageInfo = {name: moduleName};
  return wm;
}

// DeviceManager's constructor only ever calls mm.on(...) to wire its own
// listeners; nothing else on mm is touched by the path under test.
function stubModuleManager() {
  return {on: () => {}};
}

describe('worker-mode registration from the main thread\'s spec: conflict guard', () => {
  it('a refused (conflicting) registration mutates nothing on the WorkerMessage or deviceMap', async () => {
    const deviceManager = new DeviceManager(stubModuleManager());
    const wm = await workerWithSpec('colliding-name', 'incoming-module', '/modules/incoming');

    const deviceID = wm.moduleSpec.deviceID;
    const existingEntry = {modulePath: '/modules/holder'};
    deviceManager.deviceMap[deviceID] = existingEntry;

    assert.strictEqual(deviceManager.registerFromSpec(wm), false);

    // Nothing on wm was touched -- these are all still constructor defaults.
    assert.strictEqual(wm.moduleName, null);
    assert.strictEqual(wm.packageInfo, null);
    assert.strictEqual(wm.modulePath, null);
    assert.deepStrictEqual(wm.deviceList, {});
    assert.strictEqual(wm.online, undefined);

    // The original registration is untouched.
    assert.strictEqual(deviceManager.deviceMap[deviceID], existingEntry);
  });

  it('a non-conflicting registration completes normally', async () => {
    const deviceManager = new DeviceManager(stubModuleManager());
    const wm = await workerWithSpec('unique-name', 'a-module', '/modules/a');

    const deviceID = wm.moduleSpec.deviceID;

    assert.strictEqual(deviceManager.registerFromSpec(wm), true);

    assert.strictEqual(wm.moduleName, 'a-module');
    assert.deepStrictEqual(wm.packageInfo, {name: 'a-module'});
    assert.strictEqual(wm.modulePath, '/modules/a');
    // registered as the main thread's own copy, not the announced object
    assert.strictEqual(wm.deviceList[deviceID], wm.moduleSpec.spec);
    assert.strictEqual(wm.online, true);
    assert.strictEqual(deviceManager.deviceMap[deviceID], wm);
  });
});

// The test-only restart hold (lib/module-manager.js restartModule), server-free:
// under the suite's own marker, COUNTINGHOUSE_TEST_RESTART_HOLD_MS holds a
// restart's new worker that long after the old one ended, for every module
// or, with COUNTINGHOUSE_TEST_RESTART_HOLD_MODULE, that one only; without the
// marker it is ignored. test/direct-peer-channels/02 (D4) relies on it.
const assert = require('assert');
const path = require('path');
const {performance} = require('perf_hooks');
const cli = require('../../lib/cli-options');
require('../../lib/logger').createLogger(false);
const ModuleManager = require('../../lib/module-manager');

// -> ms from the restart to the new worker's start; unload and load stood in for.
function restartDelay(name) {
  const mm = Object.create(ModuleManager.prototype);
  mm.modules = {[name]: {modulePath: __dirname, packageInfo: {version: '1.0.0'}}};
  mm.generations = {};
  mm.supervisor = null;
  mm.unloadModuleExternal = (n, cb) => setImmediate(cb);
  return new Promise((resolve, reject) => {
    const start = performance.now();
    mm.loadModuleByWorker = (p, n, v, cb) => { resolve(performance.now() - start); cb(null, {}); };
    mm.restartModule(path.join(__dirname), name, '1.0.0', (err) => { if (err) reject(err); });
  });
}

describe('module-loading 19: the test-only restart hold', function() {
  this.timeout(30000);
  // Worker mode for restartModule's worker branch, set here and not when the
  // file loads: a whole-folder run loads every file first, and a later file's
  // options would win (#135's CI).
  before(() => cli.setOptions({workerThread: true}));
  after(() => cli.setOptions({workerThread: false}));
  const saved = {};
  const VARS = ['COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG', 'COUNTINGHOUSE_TEST_RESTART_HOLD_MS', 'COUNTINGHOUSE_TEST_RESTART_HOLD_MODULE'];
  beforeEach(() => { for (const v of VARS) saved[v] = process.env[v]; });
  afterEach(() => { for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; } });

  it('holds the new worker that long under the marker', async () => {
    process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG = '1';
    process.env.COUNTINGHOUSE_TEST_RESTART_HOLD_MS = '400';
    delete process.env.COUNTINGHOUSE_TEST_RESTART_HOLD_MODULE;
    assert.ok(await restartDelay('m') >= 395);
  });

  it('only for the named module when one is named', async () => {
    process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG = '1';
    process.env.COUNTINGHOUSE_TEST_RESTART_HOLD_MS = '400';
    process.env.COUNTINGHOUSE_TEST_RESTART_HOLD_MODULE = 'other';
    assert.ok(await restartDelay('m') < 300);
  });

  it('is ignored without the marker', async () => {
    delete process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG;
    process.env.COUNTINGHOUSE_TEST_RESTART_HOLD_MS = '400';
    delete process.env.COUNTINGHOUSE_TEST_RESTART_HOLD_MODULE;
    assert.ok(await restartDelay('m') < 300);
  });
});

// Unit cover for CHUtil.queryDeviceSpec (lib/countinghouse-util.js) -- the
// one wholly new function Task 4 shipped, so its three thread-mode
// branches shouldn't rest on manual tracing alone. No server, no real
// device -- CHUtil.dm (and, for the worker-child branch, dm.workerMessage)
// is stubbed directly, the same collaborator ctx.call itself only ever
// touches through this function.
//
// Requiring lib/countinghouse-util.js opens a real Redis client at require
// time whenever isMainThread === true (see the `if (isMainThread === true)`
// block near the top of that file) -- true for this, or any, plain test
// process. That is pre-existing behavior this task did not introduce (see
// test/composition/01-worker-mode-conflict-guard.js's header, which
// documents the identical thing for lib/device-manager.js), but it does
// mean this file, unlike test/module-authoring/01-module-validator.js,
// does NOT exit cleanly without `--exit` -- the open socket keeps the
// process alive. Documented rather than worked around.
const assert = require('assert');
const path   = require('path');
const Worker = require('worker_threads').Worker;

require('../../lib/cli-options').setOptions({});
const CHUtil   = require('../../lib/countinghouse-util');
const CHDevice = require('../../lib/countinghouse-device');

const DEVICE_ID = 'unit-test-device-id';
const SPEC = {device: {friendlyName: 'some-module', serviceList: {}}};

// A CHDevice-shaped stand-in without running the real constructor (which
// wants a full, valid spec passed through _getDeviceRootSchema and friends
// -- irrelevant to what's under test here, which is only the
// `instanceof CHDevice` discrimination in queryDeviceSpec's relay).
function fakeCHDevice(spec) {
  const device = Object.create(CHDevice.prototype);
  device.spec = spec;
  return device;
}

describe('CHUtil.queryDeviceSpec', () => {
  afterEach(() => { delete CHUtil.dm; });

  it('errors on a null deviceID instead of proceeding', (done) => {
    CHUtil.queryDeviceSpec(null, (err, spec) => {
      assert.ok(err != null);
      assert.strictEqual(spec, null);
      done();
    });
  });

  it('errors on a non-string deviceID instead of proceeding', (done) => {
    CHUtil.queryDeviceSpec(42, (err, spec) => {
      assert.ok(err != null);
      assert.strictEqual(spec, null);
      done();
    });
  });

  describe('main-thread branch (workerThread !== true, isMainThread === true)', () => {
    it('a CHDevice-shaped reply yields its .spec', (done) => {
      CHUtil.dm = {
        emit: (event, deviceID, cb) => {
          assert.strictEqual(event, 'querydevice');
          assert.strictEqual(deviceID, DEVICE_ID);
          return cb(null, fakeCHDevice(SPEC));
        }
      };
      CHUtil.queryDeviceSpec(DEVICE_ID, (err, spec) => {
        assert.ifError(err);
        assert.strictEqual(spec, SPEC);
        done();
      });
    });

    it('a reply whose device has a null spec rejects with NO_VALID_DEVICE_SPEC, not undefined', (done) => {
      CHUtil.dm = {emit: (event, deviceID, cb) => cb(null, fakeCHDevice(null))};
      CHUtil.queryDeviceSpec(DEVICE_ID, (err, spec) => {
        assert.ok(err != null);
        assert.strictEqual(err.code, 'NO_VALID_DEVICE_SPEC');
        assert.strictEqual(spec, null);
        done();
      });
    });

    it('a reply with no .device rejects with NO_VALID_DEVICE_SPEC, not undefined', (done) => {
      // shaped like neither a CHDevice nor a valid spec
      CHUtil.dm = {emit: (event, deviceID, cb) => cb(null, {unrelated: true})};
      CHUtil.queryDeviceSpec(DEVICE_ID, (err, spec) => {
        assert.ok(err != null);
        assert.strictEqual(err.code, 'NO_VALID_DEVICE_SPEC');
        assert.strictEqual(spec, null);
        done();
      });
    });
  });

  // isMainThread is Node's own worker_threads.isMainThread, captured once
  // at require time -- true for this (or any) plain test process, so the
  // worker-child branch cannot be reached by calling the CHUtil required
  // above no matter what is stubbed on it. rewire (already a real
  // dependency of lib/countinghouse-util.js itself, for loadFile) was
  // tried first and rejected: it cannot override a `const` binding
  // ("Assignment to constant variable"), which is exactly how
  // isMainThread is declared. So this runs the real function inside a
  // real worker thread instead -- eval:true, no extra file needed -- which
  // is the one way to make isMainThread genuinely false and exercise the
  // actual dispatch branch rather than inferring its behavior from the
  // main-thread case. As a side effect this avoids opening a second Redis
  // connection too: inside a real worker, countinghouse-util.js's own
  // `isMainThread === true` guard is false, so it skips creating one.
  describe('worker-child branch (workerThread !== true, isMainThread === false)', () => {
    it('a raw-spec reply (no CHDevice wrapper) is passed through unchanged', function(done) {
      this.timeout(10000);

      const cliOptionsPath = path.resolve(__dirname, '../../lib/cli-options.js');
      const chUtilPath     = path.resolve(__dirname, '../../lib/countinghouse-util.js');

      const workerSrc = `
        const {parentPort} = require('worker_threads');
        require(${JSON.stringify(cliOptionsPath)}).setOptions({});
        const CHUtil = require(${JSON.stringify(chUtilPath)});
        const DEVICE_ID = ${JSON.stringify(DEVICE_ID)};
        const SPEC = ${JSON.stringify(SPEC)};

        CHUtil.dm = {workerMessage: {
          sendDeviceQueryMessageToParent: (deviceID, cb) => {
            if (deviceID !== DEVICE_ID) return cb(new Error('deviceID mismatch'));
            return cb(null, SPEC);
          }
        }};

        CHUtil.queryDeviceSpec(DEVICE_ID, (err, spec) => {
          parentPort.postMessage({errMessage: (err != null) ? err.message : null, spec: spec});
        });
      `;

      const worker = new Worker(workerSrc, {eval: true});
      let settled = false;

      worker.on('message', (msg) => {
        settled = true;
        try {
          assert.strictEqual(msg.errMessage, null, msg.errMessage);
          assert.deepStrictEqual(msg.spec, SPEC);
        } catch (assertErr) {
          worker.terminate();
          return done(assertErr);
        }
        worker.terminate();
        return done();
      });
      worker.on('error', (err) => { if (!settled) done(err); });
    });
  });
});

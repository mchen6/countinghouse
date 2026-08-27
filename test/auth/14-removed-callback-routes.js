const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

// Standalone-only, non---debug.
//
// Covers the 7.0.0 removal of a dead HTTP entry path. It was not a working
// feature at the time it was removed, and this file exists so that
// reinstating it is a deliberate act rather than an accident:
//
//   /callbacks/:deviceID/*  -- routes/callbacks.js -> invokeDeviceCallbacks
//     -> DeviceManager.onInvokeDeviceCallback -> CHDevice.invokeDeviceCallback
//     -> this._deviceCallbackHandler, a property nothing in the repo ever
//     assigned. Every request reached the null check and came back
//     DEVICE_CALLBACK_NOT_AVAILABLE. It was also mounted with no userAuth at
//     all (route-manager.js: "callback don't do user auth"), which is what
//     put it on the pre-release audit's list (leftover #7).
//
// It now 404s like any other unrouted path.
const PORT             = 9546;
const url              = `http://127.0.0.1:${PORT}`;
const AUTH_CONFIG_PATH = `/tmp/countinghouse-test-auth-14-${process.pid}.json`;

const ALICE = `alice-key-14-${process.pid}`;

describe('auth 14: the dead /callbacks entry path is gone', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    const config = {};
    config[ALICE] = {userName: 'alice', devices: ['*']};
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

    console.log('starting countinghouse WITHOUT --debug, --authProvider file, for removed-route test...');
    exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ${PORT
         } --authProvider file --authConfigPath ${AUTH_CONFIG_PATH
         } --loadModule ./pre-installed-packages/echo-device-module`,
         (err, stdout, stderr) => { console.log(err); });
    setTimeout(() => { done(); }, 13000);
  });

  after((done) => {
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) {}
    exec(`pkill -f "framework.js.*${AUTH_CONFIG_PATH}"`, () => { done(); });
  });

  // The server must still be up and serving, otherwise every 404 below would
  // pass for the wrong reason.
  it('the server is up (guard: proves the 404s below mean "no such route")', (done) => {
    request(url).get('/balance').set('X-CH-Key', ALICE).expect(200, done);
  });

  it('GET /callbacks/:deviceID/* is 404', (done) => {
    request(url).get('/callbacks/some-device-id/whatever').expect(404, done);
  });

  it('POST /callbacks/:deviceID/* is 404', (done) => {
    request(url).post('/callbacks/some-device-id/whatever')
                .set('Content-Type', 'application/json')
                .send({device_access_token: 'x'})
                .expect(404, done);
  });

  it('GET /callbacks (bare) is 404', (done) => {
    request(url).get('/callbacks').expect(404, done);
  });
});

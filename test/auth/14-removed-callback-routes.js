const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

// Standalone-only, non---debug.
//
// Covers the 7.0.0 removal of two dead HTTP entry paths. Neither was a
// working feature at the time it was removed, and this file exists so that
// reinstating either one is a deliberate act rather than an accident:
//
//   /callbacks/:deviceID/*  -- routes/callbacks.js -> invokeDeviceCallbacks
//     -> DeviceManager.onInvokeDeviceCallback -> CHDevice.invokeDeviceCallback
//     -> this._deviceCallbackHandler, a property nothing in the repo ever
//     assigned. Every request reached the null check and came back
//     DEVICE_CALLBACK_NOT_AVAILABLE. It was also mounted with no userAuth at
//     all (route-manager.js: "callback don't do user auth"), which is what
//     put it on the pre-release audit's list (leftover #7).
//
//   /callback_url  -- routes/oauth-callback.js called
//     cdifInterface.setDeviceOAuthAccessToken(...), a method never defined on
//     CdifInterface, so every GET threw TypeError and answered 500. It also
//     read req.session, which only routes/user.js and routes/admin-only.js
//     ever set, and neither was mounted on that path. Nothing outside
//     lib/oauth/oauth.js itself ever set the oauth_version that
//     DeviceManager.onDeviceOnline branched on to build an OAuth device, so
//     the whole subsystem had no reachable entry point.
//
// Both now 404 like any other unrouted path.
const PORT             = 9546;
const url              = `http://127.0.0.1:${PORT}`;
const AUTH_CONFIG_PATH = `/tmp/countinghouse-test-auth-14-${process.pid}.json`;

const ALICE = `alice-key-14-${process.pid}`;

describe('auth 14: the dead /callbacks and /callback_url entry paths are gone', function() {
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

  it('GET /callback_url is 404 (was: TypeError, HTTP 500)', (done) => {
    request(url).get('/callback_url?state=some-device-id&code=abc').expect(404, done);
  });
});

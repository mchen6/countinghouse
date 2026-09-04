const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

// Covers the 7.0.0 removal of the IoT-era entry paths. None was a working
// feature when it was removed; this file exists so that reinstating any of
// them is a deliberate act rather than an accident. Same role as
// test/auth/14-removed-callback-routes.js, which covers the earlier pair.
//
//   /devices/:deviceID/connect     -- routes/connect.js called
//     cdifInterface.connectDevice, a method defined nowhere in the repo, so
//     every POST threw TypeError. The file also referenced CHError without
//     importing it, so its own validation branches threw ReferenceError.
//   /devices/:deviceID/disconnect  -- same shape, cdifInterface.disconnectDevice.
//   /discover, /stop-discover      -- mounted only under options.allowDiscover,
//     which cli-options.js hardcoded to false ("broken under worker thread
//     mode"). Never mounted at all.
//   /devices/:deviceID/presentation -- dead twice: deviceManager never emitted
//     the 'presentation' event that mounts it, and the mount handler called
//     cdifInterface.getDeviceRootUrl, never defined on CdifInterface.
const PORT             = 9547;
const url              = `http://127.0.0.1:${PORT}`;
const AUTH_CONFIG_PATH = `/tmp/countinghouse-test-auth-16-${process.pid}.json`;

const ALICE = `alice-key-16-${process.pid}`;

describe('auth 16: the dead IoT-era entry paths are gone', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    const config = {};
    config[ALICE] = {userName: 'alice', devices: ['*']};
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

    console.log('starting countinghouse WITHOUT --debug, for removed IoT-route test...');
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

  // Without this, every 404 below could pass because the server never booted.
  it('the server is up (guard: proves the 404s below mean "no such route")', (done) => {
    request(url).get('/balance').set('X-CH-Key', ALICE).expect(200, done);
  });

  it('POST /devices/:deviceID/connect is 404 (was: TypeError)', (done) => {
    request(url).post('/devices/some-device-id/connect')
                .set('X-CH-Key', ALICE)
                .set('Content-Type', 'application/json')
                .send({username: 'u', password: 'p'})
                .expect(404, done);
  });

  it('POST /devices/:deviceID/disconnect is 404 (was: TypeError)', (done) => {
    request(url).post('/devices/some-device-id/disconnect')
                .set('X-CH-Key', ALICE)
                .set('Content-Type', 'application/json')
                .send({device_access_token: 'x'})
                .expect(404, done);
  });

  it('POST /discover is 404', (done) => {
    request(url).post('/discover').set('X-CH-Key', ALICE).expect(404, done);
  });

  it('POST /stop-discover is 404', (done) => {
    request(url).post('/stop-discover').set('X-CH-Key', ALICE).expect(404, done);
  });

  it('GET /devices/:deviceID/presentation is 404', (done) => {
    request(url).get('/devices/some-device-id/presentation')
                .set('X-CH-Key', ALICE).expect(404, done);
  });

  // The live neighbours must be unaffected -- this is a removal, not a
  // regression in the device-scoped router that hosted two of them.
  it('the surviving device-scoped routes still respond (not 404)', (done) => {
    request(url).get('/device-list').set('X-CH-Key', ALICE).expect(200, done);
  });
});

// Started WITH the flags that used to mount these, because that is the case
// that could regress silently. --simOpenStackAPI mounted the OpenStack
// simulation with no userAuth at all ("openstack api simulation don't do
// user auth"), one flag away from live; --loadProfile mounted /load-profile.
// Both flags are gone in 7.0.0, so a server given them must still boot and
// must not mount anything.
const PORT_FLAGS  = 9548;
const urlFlags    = `http://127.0.0.1:${PORT_FLAGS}`;
const FLAGS_AUTH  = `/tmp/countinghouse-test-auth-16b-${process.pid}.json`;
const BOB         = `bob-key-16b-${process.pid}`;

describe('auth 16b: the vestigial flag-gated surface is gone', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    const config = {};
    config[BOB] = {userName: 'bob', devices: ['*']};
    fs.writeFileSync(FLAGS_AUTH, JSON.stringify(config));

    console.log('starting countinghouse WITH --simOpenStackAPI --loadProfile (both now no-ops)...');
    exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ${PORT_FLAGS
         } --authProvider file --authConfigPath ${FLAGS_AUTH
         } --simOpenStackAPI --loadProfile` +
         ` --loadModule ./pre-installed-packages/echo-device-module`,
         (err, stdout, stderr) => { console.log(err); });
    setTimeout(() => { done(); }, 13000);
  });

  after((done) => {
    try { fs.unlinkSync(FLAGS_AUTH); } catch (e) {}
    exec(`pkill -f "framework.js.*${FLAGS_AUTH}"`, () => { done(); });
  });

  // An unknown flag must not stop the server booting -- otherwise the 404s
  // below would pass for the wrong reason, and an operator upgrading with the
  // old flag in their startup script would get a dead server instead of a
  // route that quietly no longer exists.
  it('the server still boots when given the removed flags', (done) => {
    request(urlFlags).get('/balance').set('X-CH-Key', BOB).expect(200, done);
  });

  it('POST /v2/:tenantID/servers is 404', (done) => {
    request(urlFlags).post('/v2/tenant-1/servers')
                     .set('Content-Type', 'application/json')
                     .send({name: 'x'}).expect(404, done);
  });

  it('DELETE /v2/:tenantID/servers/:serverID is 404', (done) => {
    request(urlFlags).delete('/v2/tenant-1/servers/server-1').expect(404, done);
  });

  it('GET /load-profile is 404', (done) => {
    request(urlFlags).get('/load-profile').set('X-CH-Key', BOB).expect(404, done);
  });
});

const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

const url = 'http://127.0.0.1:9527';

// Standalone-only: needs a real (non---debug) server, so it can't share
// test1.js's/test8.js's shared --debug instance -- every other test file
// in this repo runs with --debug, which bypasses AuthProvider entirely
// (see lib/user-auth.js's debug-mode branch). This is the first test that
// actually exercises the non-debug path: FileAuthProvider (lib/auth/) plus
// its consumers -- HTTP invoke-action's userAuth gate, /device-list (now
// via AuthProvider.listDevices instead of a raw CouchDB view), and MCP
// tools/list's new per-apiKey filtering (lib/mcp/tool-registry.js's
// filterTargetsByAuth) -- which previously always listed every loaded
// device's tools regardless of caller identity.
const AUTH_CONFIG_PATH = '/tmp/countinghouse-test-auth-01.json';

const ECHO_DEVICE_ID      = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767'; // echo-device-module
const TRANSFORM_DEVICE_ID = 'a53ef5c7-cc2f-5264-9811-44f1611685ee'; // transform-demo

const WILDCARD_KEY = 'wildcard-key';
const SCOPED_KEY    = 'scoped-key'; // authorized for echo-device-module only
const UNKNOWN_KEY   = 'unknown-key'; // not present in auth.json at all

describe('auth 01: FileAuthProvider drives HTTP invoke-action, /device-list, and MCP tools/list filtering', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    const config = {};
    config[WILDCARD_KEY] = {userName: 'wildcard-user', devices: ['*']};
    config[SCOPED_KEY]   = {userName: 'scoped-user',    devices: [ECHO_DEVICE_ID]};
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

    console.log('starting countinghouse WITHOUT --debug, --authProvider file, for AuthProvider e2e test...');
    exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --authProvider file --authConfigPath ${AUTH_CONFIG_PATH
         } --loadModule ./pre-installed-packages/echo-device-module --loadModule ./pre-installed-packages/transform-demo`,
         (err, stdout, stderr) => { console.log(err); });
    setTimeout(() => { done(); }, 13000);
  });

  after((done) => {
    fs.unlinkSync(AUTH_CONFIG_PATH);
    // /shutdown is always mounted now (lib/route-manager.js), but gated
    // by admin-only.js -- this server's auth.json (built above) grants no
    // key admin rights, so unlike every other standalone test in this
    // repo, POSTing /shutdown here would just 403 (ADMIN_REQUIRED) and
    // leave the process running forever (which in turn keeps this test's
    // own `exec()`-spawned child alive, hanging mocha itself past the
    // last assertion -- found the hard way, back when this route 404'd
    // instead for the same underlying reason: no legitimate way for this
    // deliberately-non-debug, non-admin server to shut itself down via
    // HTTP). Kill the actual node process directly instead, matched via
    // the unique --authConfigPath value on its command line.
    exec(`pkill -f "framework.js.*${AUTH_CONFIG_PATH}"`, () => { done(); });
  });

  function deviceList(apiKey, cb) {
    request(url).get('/device-list').set('X-CH-Key', apiKey).end((err, res) => {
      if (err) return cb(err);
      return cb(null, res.body.map((d) => { return d.device.friendlyName; }));
    });
  }

  function invoke(apiKey, deviceID, serviceID, actionName, input, cb) {
    request(url).post(`/devices/${deviceID}/invoke-action`)
    .set('X-CH-Key', apiKey)
    .send({serviceID: serviceID, actionName: actionName, input: input})
    .end((err, res) => {
      if (err) return cb(err);
      return cb(null, res.body);
    });
  }

  function toolsList(apiKey, cb) {
    let req = request(url).post('/mcp').set('Content-Type', 'application/json');
    if (apiKey != null) req = req.set('X-CH-Key', apiKey);
    req.send({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}})
    .end((err, res) => {
      if (err) return cb(err);
      return cb(null, res.body.result.tools.map((t) => { return t.name; }));
    });
  }

  it('/device-list: wildcard key sees both devices, scoped key sees only its own, unknown key sees none', (done) => {
    deviceList(WILDCARD_KEY, (err, names) => {
      if (err) return done(err);
      if (names.indexOf('echo-device') === -1 || names.indexOf('transform-demo') === -1) {
        return done(new Error(`wildcard key should see both devices, got: ${JSON.stringify(names)}`));
      }

      deviceList(SCOPED_KEY, (err, names) => {
        if (err) return done(err);
        if (names.indexOf('echo-device') === -1 || names.indexOf('transform-demo') !== -1) {
          return done(new Error(`scoped key should see only echo-device, got: ${JSON.stringify(names)}`));
        }

        deviceList(UNKNOWN_KEY, (err, names) => {
          if (err) return done(err);
          if (names.length !== 0) return done(new Error(`unknown key should see no devices, got: ${JSON.stringify(names)}`));
          return done();
        });
      });
    });
  });

  it('HTTP invoke-action: scoped key can call its own device but is denied (USER_HAS_NO_DEVICE) on the other', (done) => {
    invoke(SCOPED_KEY, ECHO_DEVICE_ID, 'urn:countinghouse-com:serviceID:echoService', 'echo', {foo: [], bar: 'hi'}, (err, body) => {
      if (err) return done(err);
      if (body.output == null) return done(new Error(`scoped key should be able to invoke echo-device: ${JSON.stringify(body)}`));

      invoke(SCOPED_KEY, TRANSFORM_DEVICE_ID, 'urn:countinghouse-com:serviceID:transformService', 'uppercase', {text: 'hi'}, (err, body) => {
        if (err) return done(err);
        if (body.code !== 'USER_HAS_NO_DEVICE') {
          return done(new Error(`expected USER_HAS_NO_DEVICE denying transform-demo to scoped key, got: ${JSON.stringify(body)}`));
        }
        return done();
      });
    });
  });

  it('HTTP invoke-action: unknown key is denied with SYSTEM_ERROR_UNKNOWN_USER', (done) => {
    invoke(UNKNOWN_KEY, ECHO_DEVICE_ID, 'urn:countinghouse-com:serviceID:echoService', 'echo', {foo: [], bar: 'hi'}, (err, body) => {
      if (err) return done(err);
      if (body.code !== 'SYSTEM_ERROR_UNKNOWN_USER') {
        return done(new Error(`expected SYSTEM_ERROR_UNKNOWN_USER for unknown key, got: ${JSON.stringify(body)}`));
      }
      return done();
    });
  });

  it('MCP tools/list: filtered per apiKey via AuthProvider.listDevices, not just per-device schema resolution', (done) => {
    toolsList(WILDCARD_KEY, (err, names) => {
      if (err) return done(err);
      const hasEcho      = names.indexOf('echo_device_echoservice_echo') !== -1;
      const hasTransform = names.indexOf('transform_demo_transformservice_uppercase') !== -1;
      if (!hasEcho || !hasTransform) {
        return done(new Error(`wildcard key should see both device tools, got: ${JSON.stringify(names)}`));
      }

      toolsList(SCOPED_KEY, (err, names) => {
        if (err) return done(err);
        const hasEcho      = names.indexOf('echo_device_echoservice_echo') !== -1;
        const hasTransform = names.indexOf('transform_demo_transformservice_uppercase') !== -1;
        if (!hasEcho || hasTransform) {
          return done(new Error(`scoped key should see echo-device tools but not transform-demo, got: ${JSON.stringify(names)}`));
        }

        toolsList(null, (err, names) => {
          if (err) return done(err);
          // platform tool (countinghouse_check_balance) is not device-derived,
          // always visible; every device tool must be absent for an anonymous caller.
          if (names.indexOf('countinghouse_check_balance') === -1) {
            return done(new Error(`platform tool should always be listed, got: ${JSON.stringify(names)}`));
          }
          if (names.indexOf('echo_device_echoservice_echo') !== -1 || names.indexOf('transform_demo_transformservice_uppercase') !== -1) {
            return done(new Error(`anonymous caller (no X-CH-Key) should see no device tools, got: ${JSON.stringify(names)}`));
          }
          return done();
        });
      });
    });
  });

  it('MCP tools/call: denies a tool filtered out of tools/list, not just hidden from it', (done) => {
    request(url).post('/mcp')
    .set('Content-Type', 'application/json')
    .set('X-CH-Key', SCOPED_KEY)
    .send({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'transform_demo_transformservice_uppercase', arguments: {text: 'hi'}}})
    .expect(200, (err, res) => {
      if (err) return done(err);
      if (res.body.error == null) {
        return done(new Error(`expected tools/call to deny scoped key calling transform-demo, got: ${JSON.stringify(res.body)}`));
      }
      return done();
    });
  });
});

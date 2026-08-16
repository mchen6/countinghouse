const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

// Standalone-only, non---debug, multi-tenant auth.json.
//
// Covers S4. That finding was that the `admin` capability was real and
// load-bearing but undocumented, and that README described the
// module-lifecycle endpoints as "--debug only" -- so the only path a reader
// could find to hot-loading a module was to turn off authentication for the
// whole server.
//
// docs/authentication.md now documents admin keys and README says plainly
// that normal use does not need --debug. This test is what makes that claim
// checkable rather than aspirational: it walks the full documented workflow
// on a server with authentication ON -- grant admin in auth.json, load a
// module over HTTP, then call the tool it provides -- and asserts a
// non-admin tenant cannot do the same.
//
// test/auth/06-admin-gating.js covers the gate itself (who is refused).
// This covers the other half: that the documented way through it actually
// works end to end.
const PORT             = 9545;
const url              = `http://127.0.0.1:${PORT}`;
const AUTH_CONFIG_PATH = `/tmp/countinghouse-test-auth-11-${process.pid}.json`;

const OPERATOR = `operator-key-11-${process.pid}`; // admin: true
const TENANT   = `tenant-key-11-${process.pid}`;   // devices: ['*'], but NOT admin

// loaded at runtime by the operator below, not at startup
const MODULE_PATH = './pre-installed-packages/transform-demo';

function toolNames(key, cb) {
  request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', key)
    .send({jsonrpc: '2.0', id: 1, method: 'tools/list'})
    .end((err, res) => {
      if (err) return cb(err);
      if (res.body.result == null) return cb(new Error(`tools/list failed: ${JSON.stringify(res.body)}`));
      cb(null, res.body.result.tools.map((t) => { return t.name; }));
    });
}

describe('auth 11: the documented admin workflow works with authentication ON (no --debug)', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    // exactly the auth.json shape docs/authentication.md documents
    const config = {};
    config[OPERATOR] = {userName: 'operator', devices: ['*'], admin: true};
    config[TENANT]   = {userName: 'tenant',   devices: ['*']}; // no admin field
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

    console.log('starting countinghouse WITHOUT --debug, for admin module-lifecycle test...');
    // deliberately starts with only echo-device-module -- transform-demo is
    // loaded later, over HTTP, by the admin key
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

  it('the module to be loaded is not present yet', (done) => {
    toolNames(OPERATOR, (err, names) => {
      if (err) return done(err);
      const transform = names.filter((n) => { return n.indexOf('transform') !== -1; });
      if (transform.length !== 0) {
        return done(new Error(`transform-demo should not be loaded yet, got: ${JSON.stringify(transform)}`));
      }
      return done();
    });
  });

  it('a wildcard-device tenant WITHOUT admin cannot load a module', (done) => {
    request(url).post('/load-module').set('X-CH-Key', TENANT)
      .send({path: MODULE_PATH, name: 'transform-demo', version: '1.0.0'})
      .expect(403, (err, res) => {
        if (err) return done(err);
        if (res.body.code !== 'ADMIN_REQUIRED') {
          return done(new Error(`expected ADMIN_REQUIRED, got: ${JSON.stringify(res.body)}`));
        }
        return done();
      });
  });

  it('an admin key loads a module into the running server over HTTP', (done) => {
    request(url).post('/load-module').set('X-CH-Key', OPERATOR)
      .send({path: MODULE_PATH, name: 'transform-demo', version: '1.0.0'})
      .end((err, res) => {
        if (err) return done(err);
        if (res.status === 403) {
          return done(new Error(`admin key was refused by the admin gate: ${JSON.stringify(res.body)}`));
        }
        if (res.status !== 200) {
          return done(new Error(`load-module failed for an admin key: ${res.status} ${JSON.stringify(res.body)}`));
        }

        // The response must be the minimal answer to "did it load", not the
        // live module/WorkerMessage instance -- that used to serialize
        // msgQueue, the worker_threads handle, workerId, rateLimiters and
        // deviceList straight onto the wire.
        if (res.body.loaded !== true || res.body.name !== 'transform-demo') {
          return done(new Error(`expected {loaded:true,name,version}, got: ${JSON.stringify(res.body)}`));
        }
        ['msgQueue', 'worker', 'workerId', 'rateLimiters', 'deviceList', 'msgID', 'discoverState'].forEach((leak) => {
          if (Object.prototype.hasOwnProperty.call(res.body, leak)) {
            throw new Error(`internal field "${leak}" leaked in /load-module response: ${JSON.stringify(res.body)}`);
          }
        });

        setTimeout(done, 4000); // let the worker come up and the device register
      });
  });

  it('the newly loaded module\'s tool is now callable -- authentication never turned off', (done) => {
    toolNames(TENANT, (err, names) => {
      if (err) return done(err);
      const transform = names.filter((n) => { return n.indexOf('transform') !== -1; });
      if (transform.length === 0) {
        return done(new Error(`expected the loaded module's tool in tools/list, got: ${JSON.stringify(names)}`));
      }

      request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', TENANT)
        .send({jsonrpc: '2.0', id: 2, method: 'tools/call',
               params: {name: transform[0], arguments: {text: 'hello'}}})
        .end((err, res) => {
          if (err) return done(err);
          if (res.body.result == null || res.body.result.isError === true) {
            return done(new Error(`calling the freshly loaded tool failed: ${JSON.stringify(res.body)}`));
          }
          if (JSON.stringify(res.body).indexOf('HELLO') === -1) {
            return done(new Error(`expected the uppercased result, got: ${JSON.stringify(res.body)}`));
          }
          return done();
        });
    });
  });

  it('an admin key can unload it again', (done) => {
    request(url).post('/unload-module').set('X-CH-Key', OPERATOR)
      .send({name: 'transform-demo'})
      .end((err, res) => {
        if (err) return done(err);
        if (res.status === 403) {
          return done(new Error(`admin key was refused on /unload-module: ${JSON.stringify(res.body)}`));
        }
        if (res.status === 200 && res.body.unloaded !== true) {
          return done(new Error(`expected {unloaded:true,name}, got: ${JSON.stringify(res.body)}`));
        }
        return done();
      });
  });
});

const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

// Standalone-only, non---debug, multi-tenant auth.json.
//
// Covers S7. A module that calls other modules does so as some apiKey, and
// that apiKey goes through the same AuthProvider check any external caller
// would -- so on a real server a composing module simply does not work
// until its internal identity has been granted. README documented that
// grant for composite-demo only; echo-device-client-module ('aabbcc') and
// perf-caller-demo ('perf-caller-demo-internal') have the same requirement
// and had no mention anywhere, so anyone loading them outside --debug hit an
// unexplained failure. Both docs now list all three.
//
// This is the clean-room check for that claim: an auth.json containing the
// caller's key but NOT the internal identities, then the same server with
// the documented grants applied. The first case must fail, the second must
// succeed -- if both passed, the documentation would be describing a
// requirement that doesn't exist.
const PORT             = 9546;
const url              = `http://127.0.0.1:${PORT}`;
const AUTH_UNGRANTED   = `/tmp/countinghouse-test-auth-12a-${process.pid}.json`;
const AUTH_GRANTED     = `/tmp/countinghouse-test-auth-12b-${process.pid}.json`;

const CALLER = `caller-key-12-${process.pid}`;

// exactly the identities docs/composite-tools.md now tabulates
const INTERNAL_IDENTITIES = ['composite-demo-internal', 'aabbcc', 'perf-caller-demo-internal'];

const MODULES = [
  './pre-installed-packages/echo-device-module',
  './pre-installed-packages/transform-demo',
  './pre-installed-packages/composite-demo',
  './pre-installed-packages/echo-device-client-module'
];

function writeAuth(path, withGrants) {
  const config = {};
  config[CALLER] = {userName: 'caller', devices: ['*']};
  if (withGrants === true) {
    INTERNAL_IDENTITIES.forEach((k) => { config[k] = {userName: k, devices: ['*']}; });
  }
  fs.writeFileSync(path, JSON.stringify(config));
}

function startServer(authPath, done) {
  exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ${PORT
       } --authProvider file --authConfigPath ${authPath
       }${MODULES.map((m) => { return ` --loadModule ${m}`; }).join('')}`,
       (err, stdout, stderr) => { console.log(err); });
  setTimeout(done, 14000);
}

function stopServer(authPath, done) {
  exec(`pkill -f "framework.js.*${authPath}"`, () => { setTimeout(done, 2000); });
}

function callComposite(cb) {
  request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', CALLER)
    .send({jsonrpc: '2.0', id: 1, method: 'tools/call',
           params: {name: 'composite_demo_compositeservice_run', arguments: {text: 'hello from the composite demo'}}})
    .end(cb);
}

describe('auth 12: composing modules need their internal identity granted (all of them, not just composite-demo)', function() {
  this.timeout(0);

  describe('WITHOUT the documented grants', () => {
    before(function(done) { this.timeout(0); writeAuth(AUTH_UNGRANTED, false); startServer(AUTH_UNGRANTED, done); });
    after((done) =>  { try { fs.unlinkSync(AUTH_UNGRANTED); } catch (e) {} stopServer(AUTH_UNGRANTED, done); });

    it('composite-demo fails, because its internal identity is unknown to AuthProvider', (done) => {
      callComposite((err, res) => {
        if (err) return done(err);
        if (res.body.result != null && res.body.result.isError !== true) {
          return done(new Error(`expected the inner hops to be refused without a grant, but the call succeeded: ${
                                JSON.stringify(res.body)  } -- if this is now legitimately allowed, ` +
                                `docs/composite-tools.md is describing a requirement that no longer exists`));
        }
        return done();
      });
    });
  });

  describe('WITH the documented grants applied', () => {
    before(function(done) { this.timeout(0); writeAuth(AUTH_GRANTED, true); startServer(AUTH_GRANTED, done); });
    after((done) =>  { try { fs.unlinkSync(AUTH_GRANTED); } catch (e) {} stopServer(AUTH_GRANTED, done); });

    it('composite-demo runs both inner hops and returns a per-hop bill', (done) => {
      callComposite((err, res) => {
        if (err) return done(err);
        const result = res.body.result;
        if (result == null || result.isError === true) {
          return done(new Error(`composite-demo still failing with the documented grants applied: ${JSON.stringify(res.body)}`));
        }
        const output = result.structuredContent.output;
        if (output.finalText !== 'HELLO FROM THE COMPOSITE DEMO') {
          return done(new Error(`unexpected finalText: ${JSON.stringify(output)}`));
        }
        if (!Array.isArray(output.bill) || output.bill.length !== 2) {
          return done(new Error(`expected one bill entry per inner hop, got: ${JSON.stringify(output.bill)}`));
        }
        return done();
      });
    });

    it('echo-device-client-module (internal identity "aabbcc") also works', (done) => {
      request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', CALLER)
        .send({jsonrpc: '2.0', id: 2, method: 'tools/call',
               params: {name: 'echo_device_client_x_api', arguments: {}}})
        .end((err, res) => {
          if (err) return done(err);
          const result = res.body.result;
          if (result == null || result.isError === true) {
            return done(new Error(`echo-device-client-module failed even with its identity granted: ${JSON.stringify(res.body)}`));
          }
          return done();
        });
    });
  });
});

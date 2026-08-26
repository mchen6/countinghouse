// A server started with NO preloaded modules must still complete discovery.
//
// The bug this guards: `allmodulediscovered` is emitted only when
// `noofTotalModules > 0` (lib/module-manager.js, both emit sites), and
// noofTotalModules is set only from the startup module list. So an instance
// started with no --loadModule never fired it at all, which meant:
//
//   1. DeviceManager.prototype.verifyComposition never ran, so a module
//      loaded later via countinghouse_load_module was never bound and every
//      ctx.call from it refused with "no auth identity is bound to this
//      module" -- an accusation against an auth config that was correct.
//      That is exactly the --authoringTools setup docs/module-development.md
//      recommends for agent-driven authoring, so composition silently did
//      not work in the one workflow built for it.
//
//   2. `allDevicesLoaded` never became true, and queryDeviceForChild only
//      ERRORS for an unknown device once that flag is set -- otherwise it
//      queues the reply. So a ctx.call to a genuinely missing module hung
//      until the request timeout instead of failing with "not loaded".
//
// Both are the same root cause: a bare instance never left the "still
// discovering" state. A server with zero modules HAS finished discovering,
// vacuously, and must say so.
const assert = require('assert');
const path   = require('path');
const spawn  = require('child_process').spawn;

const ROOT = path.join(__dirname, '..', '..');
const PORT = 9562;   // verified unused across test/ and examples/

describe('composition 08: a bare server completes discovery', function() {
  this.timeout(40000);

  let server = null;
  let log    = '';

  before((done) => {
    server = spawn(process.execPath,
      [path.join(ROOT, 'framework.js'), '--workerThread', '--bindAddr', '127.0.0.1',
       '--port', String(PORT), '--authoringTools', '--debug', '--debugKey', 'aabbcc'],
      {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});

    server.stdout.on('data', (c) => { log += c.toString(); });
    server.stderr.on('data', (c) => { log += c.toString(); });

    // Generous: the assertion is about whether the line EVER appears, so a
    // slow start must not be mistaken for the bug.
    setTimeout(done, 12000);
  });

  after((done) => {
    if (server == null) return done();
    server.once('exit', () => done());
    server.kill('SIGKILL');
  });

  it('reaches "all module discovered" with no modules to discover', () => {
    assert.ok(/all module discovered/i.test(log),
      'a server started with no --loadModule never completed discovery. ' +
      'verifyComposition therefore never runs and unknown-device queries queue ' +
      `instead of erroring. Server output was:\n${log.slice(-1500)}`);
  });
});

// The end-to-end case the whole-branch review named as the missing test: load a
// module that DECLARES countinghouse.calls into a bare instance at runtime, and
// call it. Nothing anywhere else exercises the authoring toolchain and the
// composition API together, which is why this gap survived both features'
// own suites.
//
// Deliberately NOT --debug: under --debug, doUserAuth requires every appKey in
// the chain to equal one shared debugKey, so an inner hop authorized as the
// module's own identity would be refused for a reason unrelated to this bug.
describe('composition 08b: a module loaded at runtime into a bare server can ctx.call', function() {
  this.timeout(60000);

  const fs      = require('fs');
  const os      = require('os');
  const request = require('supertest');

  const PORT_E2E = 9563;   // verified unused across test/ and examples/
  const BASE     = `http://127.0.0.1:${PORT_E2E}`;
  const ADMIN    = 'e2e-admin-key';

  let server = null;
  let log    = '';

  const mcp = (method, params, cb) => request(BASE).post('/mcp')
    .set('X-CH-Key', ADMIN)
    .set('Accept', 'application/json, text/event-stream')
    .send({jsonrpc: '2.0', id: Date.now(), method: method, params: params})
    .end((err, res) => cb(err, res && res.body));

  before((done) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-bare-'));
    const authPath = path.join(dir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({
      [ADMIN]: {userName: 'e2e-admin', devices: ['*'], admin: true},
      'compose-caller-internal': {
        userName: 'compose-caller-internal', devices: ['*'],
        runsModules: ['compose-caller']
      }
    }));

    server = spawn(process.execPath,
      [path.join(ROOT, 'framework.js'), '--workerThread', '--bindAddr', '127.0.0.1',
       '--port', String(PORT_E2E), '--authoringTools', '--authConfigPath', authPath],
      {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    server.stdout.on('data', (c) => { log += c.toString(); });
    server.stderr.on('data', (c) => { log += c.toString(); });

    setTimeout(() => {
      // callee first, so the target exists when the caller is verified
      mcp('tools/call', {name: 'countinghouse_load_module', arguments: {
        path: path.join(ROOT, 'test', 'fixtures', 'compose-callee'), name: 'compose-callee'}}, () => {
        mcp('tools/call', {name: 'countinghouse_load_module', arguments: {
          path: path.join(ROOT, 'test', 'fixtures', 'compose-caller'), name: 'compose-caller'}}, () => {
          setTimeout(done, 4000);   // let verification settle
        });
      });
    }, 10000);
  });

  after((done) => {
    if (server == null) return done();
    server.once('exit', () => done());
    server.kill('SIGKILL');
  });

  it('ctx.call works from a runtime-loaded composing module', (done) => {
    mcp('tools/call', {name: 'compose_caller_callerservice_viacall', arguments: {n: 21}}, (err, body) => {
      assert.ifError(err);
      assert.ok(body && body.result, `no result: ${JSON.stringify(body)}`);
      assert.notStrictEqual(body.result.isError, true,
        'ctx.call refused from a runtime-loaded module -- composition was never ' +
        `verified on this bare instance. Result: ${JSON.stringify(body.result)}`);
      assert.strictEqual(body.result.structuredContent.output.n, 42, JSON.stringify(body.result));
      done();
    });
  });
});

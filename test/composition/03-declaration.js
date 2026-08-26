// Load-time verification: DeviceManager.prototype.verifyComposition.
//
// Three cases, each its own server spawn (own fixture directory for the two
// load-failure cases) so one failure cannot mask another:
//
//   1. compose-caller-badaddr declares an address for an action that does
//      not exist on the target module. Load-time resolveAddress fails, the
//      module must not come online, and the server's combined stdout+stderr
//      must name both the offending module and the offending address --
//      per this task's brief, that message is the ONLY user-facing surface
//      for a misconfigured chain (ctx.call's own runtime rejection never
//      reaches an MCP client with any detail -- see 02-ctx-call.js's header
//      comment for the full trace of why).
//
//   2. compose-caller (the same working fixture 02-ctx-call.js uses, with
//      its identity properly bound) still refuses a call to an address
//      outside its own "countinghouse.calls" at call time. This exercises
//      the exact same guard clause 02-ctx-call.js already asserts in-process
//      against a synthetic device, but here against the REAL spawned
//      server, with the REAL identity DeviceManager.prototype.
//      verifyComposition bound -- proving the refusal survives end-to-end
//      with load-time verification actually having run, not just a
//      hand-built ctx. As documented in 02-ctx-call.js's header (confirmed
//      again here by hand), the detailed rejection message does not survive
//      the worker-thread hop to an MCP client -- lib/mcp/gateway.js's
//      toolCallResult builds the error from `err.message`/`err.code` alone
//      and DeviceManager.prototype.invokeAction's worker-reply branch
//      re-wraps using `err.code` over `err.message` when a code is present
//      -- so what is asserted here is the real, observable MCP shape
//      (isError + the generic DEVICE_INVOKE_EXCEPTION code), not literal
//      message text.
//
//   3. compose-caller-noident declares a perfectly valid address, but no
//      auth identity's "runsModules" lists it. Load-time identityForModule
//      resolution fails, the module must not come online, and stderr must
//      mention "runsModules".
const assert  = require('assert');
const path    = require('path');
const request = require('supertest');
const spawn   = require('child_process').spawn;

const PORT = 9557;
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const AUTH_CONFIG = path.join(__dirname, 'fixtures-auth.json');
const BASE = `http://127.0.0.1:${PORT}`;

let server;

// Same shape as 02-ctx-call.js's startServer, parameterized on which
// modules to load. Waits for "all module discovered" specifically, not just
// the first device announcing itself: DeviceManager.prototype.
// verifyComposition (this task) runs right after that point, and needs its
// own async work (a 'querydevice' resolution plus an authenticate() round
// trip per declared address, then under --workerThread a further
// main<->worker relay of the result) to finish before either a load
// failure has been logged and purged, or a real identity is usable by
// ctx.call.
function startServer(modulePaths, done) {
  const args = [
    path.join(__dirname, '..', '..', 'framework.js'),
    '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(PORT),
    '--authConfigPath', AUTH_CONFIG
  ];
  modulePaths.forEach((p) => { args.push('--loadModule', path.join(FIXTURES, p)); });

  server = spawn(process.execPath, args, {stdio: ['ignore', 'pipe', 'pipe']});

  let out = '';
  const onData = (buf) => { out += buf.toString(); };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);

  const check = setInterval(() => {
    if (/all module discovered/i.test(out)) {
      clearInterval(check);
      setTimeout(() => done(out), 2500);
    }
  }, 100);
}

function stopServer(done) {
  if (server == null) return done();
  server.kill('SIGKILL');
  server.on('exit', () => { server = null; done(); });
}

function listTools(cb) {
  request(BASE)
    .post('/mcp')
    .set('X-CH-Key', 'composition-test-key')
    .set('Accept', 'application/json, text/event-stream')
    .send({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}})
    .expect(200)
    .end((err, res) => {
      if (err) return cb(err);
      return cb(null, res.body);
    });
}

function callTool(name, args, cb) {
  request(BASE)
    .post('/mcp')
    .set('X-CH-Key', 'composition-test-key')
    .set('Accept', 'application/json, text/event-stream')
    .send({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: name, arguments: args}})
    .expect(200)
    .end((err, res) => {
      if (err) return cb(err);
      return cb(null, res.body);
    });
}

describe('verifyComposition: an address for an action that does not exist', function() {
  this.timeout(40000);

  let capturedOutput = '';

  before((done) => {
    startServer(['compose-callee', 'compose-caller-badaddr'], (out) => {
      capturedOutput = out;
      done();
    });
  });
  after((done) => stopServer(done));

  it('names both the module and the offending address in the server output', () => {
    assert.ok(/compose-caller-badaddr/.test(capturedOutput),
      `expected the module name "compose-caller-badaddr" in output:\n${capturedOutput}`);
    assert.ok(/compose-callee\/calleeService\.nonexistent/.test(capturedOutput),
      `expected the offending address in output:\n${capturedOutput}`);
  });

  it('leaves the module\'s own tool out of tools/list', (done) => {
    listTools((err, body) => {
      assert.ifError(err);
      const names = (body.result.tools || []).map((t) => t.name);
      assert.ok(names.indexOf('compose_caller_badaddr_callerservice_ping') === -1,
        `did not expect compose-caller-badaddr's tool in: ${JSON.stringify(names)}`);
      done();
    });
  });
});

describe('verifyComposition: refusal at call time, against the real spawned server', function() {
  this.timeout(40000);

  before((done) => startServer(['compose-callee', 'compose-caller'], () => done()));
  after((done) => stopServer(done));

  it('undeclared (an address outside countinghouse.calls) is refused, identity bound or not', (done) => {
    callTool('compose_caller_callerservice_undeclared', {}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, true, JSON.stringify(body));
      assert.strictEqual(body.result.structuredContent.code, 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(body));
      done();
    });
  });
});

describe('verifyComposition: a declared address with no bound identity', function() {
  this.timeout(40000);

  let capturedOutput = '';

  before((done) => {
    startServer(['compose-callee', 'compose-caller-noident'], (out) => {
      capturedOutput = out;
      done();
    });
  });
  after((done) => stopServer(done));

  it('mentions runsModules in the server output', () => {
    assert.ok(/compose-caller-noident/.test(capturedOutput),
      `expected the module name "compose-caller-noident" in output:\n${capturedOutput}`);
    assert.ok(/runsModules/.test(capturedOutput),
      `expected "runsModules" in output:\n${capturedOutput}`);
  });

  it('leaves the module\'s own tool out of tools/list', (done) => {
    listTools((err, body) => {
      assert.ifError(err);
      const names = (body.result.tools || []).map((t) => t.name);
      assert.ok(names.indexOf('compose_caller_noident_callerservice_ping') === -1,
        `did not expect compose-caller-noident's tool in: ${JSON.stringify(names)}`);
      done();
    });
  });
});

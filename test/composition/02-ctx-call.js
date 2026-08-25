// ctx.call: composition by name (compose-caller/calleeService.double instead
// of a pasted UUID, a service URN, an identity string and two promise
// wrappers).
//
// This file covers what is real and testable in THIS task. The
// success-path assertion (viaCall returns 42) is deliberately NOT here --
// ctx.call refuses to run at all until a module's identity is bound, and
// that binding is written by Task 5's load-time verification
// (DeviceManager.prototype.verifyComposition, which calls
// handlerCtx.setComposition). Nothing in this branch calls setComposition
// yet, so device._composition is always undefined right now, and Task 5
// adds the success case to this same describe block once it exists.
//
// What ctx.call must already do, regardless of Task 5, is refuse correctly:
//   1. no identity bound            -> rejects, message names "runsModules"
//   2. address not in countinghouse.calls -> rejects, message names
//      "countinghouse.calls"
//
// Both are asserted below. (1) is asserted twice: once against the real
// spawned server on port 9556 (proving the whole stack -- MCP layer,
// worker-thread dispatch, doActionCall's async-rejection handling -- turns
// ctx.call's rejection into a real MCP error instead of hanging or
// crashing), and again in-process against the exact message. That split is
// not a style choice -- it is forced by something verified by hand while
// writing this test (see the probe transcript below): under
// --workerThread, DeviceManager.prototype.invokeAction re-wraps a worker's
// error reply as `new DeviceError(err.code != null ? err.code : err.message)`
// (lib/device-manager.js, the `device.sendInvokeActionMessage(...)` branch).
// Since ctx.call's rejection carries a `code` (DEVICE_INVOKE_EXCEPTION, from
// lib/service.js's `fail`), only the code survives the hop back to the main
// thread -- the detailed message ("...no auth identity is bound...") does
// not. A real `tools/call` in worker-thread mode therefore always shows the
// client the same generic "Device interface call threw an exception" text,
// no matter which of ctx.call's two guard clauses actually fired. This was
// confirmed by hand: a probe server on port 9556 with these exact fixtures
// returned the identical isError:true / structuredContent.code shape for
// viaCall, undeclared and viaBoom alike. That collapsing behavior predates
// this task and is out of scope here, but it means (2) can only be checked
// for its real message text by calling ctx.call directly, in-process,
// against the same production code (lib/handler-ctx.js's buildCtx and
// setComposition) rather than through the worker boundary.
//
// Real tool name and MCP envelope, recorded by hand before writing the
// assertions below (server started with the fixtures and auth config this
// file uses, on port 9556):
//
//   tools/list includes:
//     {"name":"compose_caller_callerservice_viacall", ...}
//     {"name":"compose_caller_callerservice_undeclared", ...}
//     {"name":"compose_caller_callerservice_viaboom", ...}
//
//   tools/call (any of the three, right now, with no Task 5 wiring):
//     {"jsonrpc":"2.0","id":2,"result":{"isError":true,
//      "content":[{"type":"text","text":"Device interface call threw an exception"}],
//      "structuredContent":{"code":"DEVICE_INVOKE_EXCEPTION"}}}
const assert  = require('assert');
const path    = require('path');
const request = require('supertest');
const spawn   = require('child_process').spawn;

// Needed before requiring anything that reaches lib/countinghouse-util.js
// (handler-ctx's buildCtx does, lazily, on first call): without this,
// options.redisUrl is unset and redis.createClient(undefined, {db: 10})
// blows up trying to resolve a hostname. Same pattern as
// test/module-authoring/01-module-validator.js and
// test/composition/05-module-identity.js.
require('../../lib/cli-options').setOptions({});
const handlerCtx = require('../../lib/handler-ctx');

const PORT = 9556;
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const BASE = `http://127.0.0.1:${PORT}`;

let server;

function startServer(done) {
  server = spawn(process.execPath, [
    path.join(__dirname, '..', '..', 'framework.js'),
    '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(PORT),
    '--authConfigPath', path.join(__dirname, 'fixtures-auth.json'),
    '--loadModule', path.join(FIXTURES, 'compose-callee'),
    '--loadModule', path.join(FIXTURES, 'compose-caller')
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  let out = '';
  const onData = (buf) => {
    out += buf.toString();
    if (/device list ready|server listening|new device online/i.test(out)) {
      // give discovery a beat to finish registering the second module
      setTimeout(done, 1500);
      server.stdout.removeListener('data', onData);
    }
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
}

function callTool(name, args, cb) {
  request(BASE)
    .post('/mcp')
    .set('X-CH-Key', 'composition-test-key')
    .set('Accept', 'application/json, text/event-stream')
    .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: name, arguments: args}})
    .expect(200)
    .end((err, res) => {
      if (err) return cb(err);
      // Recorded by hand (see the header comment): a synchronous tools/call
      // reply comes back as content-type application/json, not an SSE
      // stream -- superagent parses that straight into res.body, so there
      // is no "data: " prefix to strip here.
      return cb(null, res.body);
    });
}

describe('ctx.call: refusal path, against the real spawned server', function() {
  this.timeout(40000);

  before((done) => startServer(done));
  after(() => { if (server != null) server.kill('SIGKILL'); });

  // compose-caller declares countinghouse.calls, but nothing in this branch
  // has called handlerCtx.setComposition yet -- that is Task 5's job. So
  // every call through ctx.call fails the very first guard clause
  // ("no auth identity is bound") no matter which address the handler
  // names. This proves ctx.call's rejection reaches the client as a real
  // MCP error, through worker-thread dispatch and doActionCall's async
  // rejection path -- not a hang, not an unhandled rejection.
  it('viaCall (a declared address) fails: no identity is bound to compose-caller yet', (done) => {
    callTool('compose_caller_callerservice_viacall', {n: 21}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, true, JSON.stringify(body));
      assert.strictEqual(body.result.structuredContent.code, 'DEVICE_INVOKE_EXCEPTION');
      done();
    });
    // Task 5 adds the success case here: once verifyComposition binds
    // compose-caller's identity, this same call should return {n: 42}.
  });

  it('undeclared (an address outside countinghouse.calls) fails the same way', (done) => {
    callTool('compose_caller_callerservice_undeclared', {}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, true, JSON.stringify(body));
      assert.strictEqual(body.result.structuredContent.code, 'DEVICE_INVOKE_EXCEPTION');
      done();
    });
  });
});

// The identity-bound and declared-address checks, exercised directly
// in-process against the production code (lib/handler-ctx.js), because --
// as recorded above -- the detailed rejection message does not survive the
// worker-thread hop, so it cannot be asserted through the spawned server.
// No mocking: buildCtx and setComposition are the exact functions Task 5's
// load-time verification and every real handler invocation use.
describe('ctx.call: guard clause messages (in-process, same production code)', () => {
  function fakeDevice() {
    return {deviceID: 'unit-test-device', spec: {device: {friendlyName: 'compose-caller'}}};
  }

  it('rejects with no identity bound, naming runsModules', async () => {
    const device = fakeDevice();
    // no setComposition call: device._composition stays unset, exactly as
    // it is on this branch before Task 5 exists.
    const ctx = handlerCtx.buildCtx(device, {ctx: {appKey: 'irrelevant'}}, {});

    await assert.rejects(
      ctx.call('compose-callee/calleeService.double', {n: 21}),
      (err) => {
        assert.ok(/runsModules/.test(err.message), `expected "runsModules" in: ${err.message}`);
        return true;
      }
    );
  });

  it('rejects an address the module did not declare, naming countinghouse.calls', async () => {
    const device = fakeDevice();
    handlerCtx.setComposition(device, {
      identity: 'compose-caller-internal',
      allowed: {'compose-callee/calleeService.double': true}
    });
    const ctx = handlerCtx.buildCtx(device, {ctx: {appKey: 'irrelevant'}}, {});

    await assert.rejects(
      ctx.call('compose-callee/calleeService.triple', {}),
      (err) => {
        assert.ok(/countinghouse\.calls/.test(err.message),
          `expected "countinghouse.calls" in: ${err.message}`);
        return true;
      }
    );
  });
});

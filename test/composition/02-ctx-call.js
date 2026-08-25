// ctx.call: composition by name (compose-caller/calleeService.double instead
// of a pasted UUID, a service URN, an identity string and two promise
// wrappers).
//
// UPDATED by Task 5. The success-path assertion (viaCall returns 42) now
// lives here: DeviceManager.prototype.verifyComposition runs after discovery
// completes, binds compose-caller's identity from fixtures-auth.json's
// "runsModules", and calls handlerCtx.setComposition -- under --workerThread
// that binding is relayed into compose-caller's own worker thread
// (WorkerMessage.prototype.sendSetCompositionMessage / lib/sandbox.js's
// 'set-composition' case), since the real CHDevice buildCtx reads
// _composition off of lives there, not on the main thread's WorkerMessage
// proxy. That is also why the OLD "viaCall fails: no identity is bound"
// assertion is gone rather than kept alongside the new one -- once Task 5's
// wiring runs, that premise is simply false in this file's own spawned
// server (its fixtures-auth.json already binds compose-caller's identity),
// so the call now succeeds instead of failing the first guard clause.
//
// What ctx.call must still do, now that identity IS bound, is refuse a call
// to an address outside "countinghouse.calls" ("undeclared", below) -- that
// assertion is unchanged from before Task 5 and must keep passing.
//
// The refusal is asserted twice: once against the real
// spawned server on port 9556 (proving the whole stack -- MCP layer,
// worker-thread dispatch, doActionCall's async-rejection handling -- turns
// ctx.call's rejection into a real MCP error instead of hanging or
// crashing), and again in-process against the exact message. That split is
// not a style choice -- it is forced by something confirmed by hand while
// writing this test (see the probe transcript below), and traced to its
// root cause on code review: lib/mcp/gateway.js's toolCallResult (~lines
// 121-136) builds the client-facing error shape from `err.message` and
// `err.code` alone -- it never reads the `data`/fault argument in its
// error branch, so any detail that only lives there is discarded for
// every MCP client, in both threading modes. Under --workerThread there is
// a second, compounding loss on top of that: DeviceManager.prototype.
// invokeAction re-wraps a worker's error reply as
// `new DeviceError(err.code != null ? err.code : err.message)`
// (lib/device-manager.js, the `device.sendInvokeActionMessage(...)`
// branch) -- since ctx.call's rejection carries a `code`
// (DEVICE_INVOKE_EXCEPTION, from lib/service.js's `fail`), even
// `err.message` itself does not survive the hop back to the main thread,
// so gateway.js never has the detail to drop in the first place. Either
// way, a real `tools/call` in worker-thread mode shows the client the same
// generic "Device interface call threw an exception" text, no matter which
// of ctx.call's two guard clauses actually fired. This was confirmed by
// hand: a probe server on port 9556 with these exact fixtures returned the
// identical isError:true / structuredContent.code shape for viaCall,
// undeclared and viaBoom alike (pre-Task-5, when every call failed the
// first guard). Both of these are pre-existing, general MCP-layer
// behaviors, out of scope for this task -- but together they mean the
// refusal can only be checked for its real message text by calling
// ctx.call directly, in-process, against the same production code
// (lib/handler-ctx.js's buildCtx and setComposition) rather than through
// the worker boundary and the gateway.
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
//   tools/call "viaCall" with {n: 21}, with Task 5's wiring in place:
//     {"jsonrpc":"2.0","id":1,"result":{"isError":false,
//      "content":[{"type":"text","text":"{\"output\":{\"n\":42}}"}],
//      "structuredContent":{"output":{"n":42}}}}
//   (structuredContent nests under "output" because that is the raw shape a
//   6.0.0 handler returns/receives -- see docs/module-development.md -- and
//   ctx.call resolves with exactly what the callee returned, unwrapped no
//   further than any other ServiceClient.invoke caller sees it.)
//
//   tools/call "undeclared", with Task 5's wiring in place (identity bound,
//   but "compose-callee/calleeService.triple" is not in "countinghouse.calls"):
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
    // Wait for "all module discovered" specifically, not just the first
    // device announcing itself: DeviceManager.prototype.verifyComposition
    // (Task 5) now runs after that point, and it does its own async work --
    // a 'querydevice' resolution plus an authenticate() round trip per
    // declared address, then (under --workerThread) a further main<->worker
    // relay of the result via WorkerMessage.prototype.
    // sendSetCompositionMessage -- before compose-caller's ctx.call is
    // actually usable. The older "new device online" trigger fired too
    // early for that extra work to have finished yet.
    if (/all module discovered/i.test(out)) {
      setTimeout(done, 2500);
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

describe('ctx.call: success and refusal, against the real spawned server', function() {
  this.timeout(40000);

  before((done) => startServer(done));
  after(() => { if (server != null) server.kill('SIGKILL'); });

  // compose-caller's identity is now bound (DeviceManager.prototype.
  // verifyComposition, run by the framework right after discovery, before
  // this server ever accepts a request) and "compose-callee/calleeService.
  // double" is declared in its countinghouse.calls. viaCall's handler does
  // `await ctx.call('compose-callee/calleeService.double', {n: input.n})`
  // and doubles input.n server-side -- a real two-hop call: MCP -> worker
  // thread A (compose-caller) -> ctx.call -> worker thread B
  // (compose-callee) -> back. 21 doubled is 42.
  it('viaCall (a declared address) succeeds end-to-end: a real two-hop ctx.call', (done) => {
    callTool('compose_caller_callerservice_viacall', {n: 21}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, false, JSON.stringify(body));
      assert.strictEqual(body.result.structuredContent.output.n, 42, JSON.stringify(body));
      done();
    });
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

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
// The refusal is asserted twice: once against the real spawned server on
// port 9556 (proving the whole stack -- MCP layer, worker-thread dispatch,
// doActionCall's async-rejection handling -- turns ctx.call's rejection
// into a real MCP error instead of hanging or crashing), and again
// in-process against the exact message. That split is not a style choice --
// it is forced by where the detail is lost, which was confirmed by hand
// while writing this test and traced to its root cause on code review:
// lib/mcp/gateway.js's toolCallResult (~lines 121-136) builds the
// client-facing error shape from `err.message` and `err.code` alone -- it
// never reads the `data`/fault argument in its error branch, so any detail
// that only lives there is discarded for every MCP client, in both
// threading modes. Under --workerThread there is a second, compounding
// loss on top of that: DeviceManager.prototype.invokeAction re-wraps a
// worker's error reply as
// `new DeviceError(err.code != null ? err.code : err.message)`
// (lib/device-manager.js, the `device.sendInvokeActionMessage(...)`
// branch), so the per-call text -- which address, which module -- does not
// survive the hop back to the main thread either.
//
// What DOES survive that hop is the code, and it is now a meaningful one.
// ctx.call's guard clauses reject with a DeviceError rather than a plain
// Error (lib/handler-ctx.js), which lib/service.js's `fail` passes through
// intact instead of flattening to DEVICE_INVOKE_EXCEPTION -- so an
// undeclared address arrives at the client as CTX_CALL_UNDECLARED, and the
// message text is that code's actionable head from error-info.*.json. It
// was not always so: a probe server on port 9556 with these exact fixtures
// once returned the identical isError:true / DEVICE_INVOKE_EXCEPTION shape
// for viaCall, undeclared and viaBoom alike. test/composition/
// 09-refusal-codes.js owns the full code set and the startup-window case;
// what remains asserted in-process here is the per-call message text, which
// still reaches no MCP client under --workerThread.
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
//      "content":[{"type":"text","text":"ctx.call refused: this address is not
//        declared in the module's \"countinghouse.calls\" (package.json)"}],
//      "structuredContent":{"code":"CTX_CALL_UNDECLARED"}}}
//   (before the guards became typed errors this was the generic "Device
//   interface call threw an exception" / DEVICE_INVOKE_EXCEPTION pair, which
//   a callee that actually crashed returns too -- indistinguishable.)
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
      // Was DEVICE_INVOKE_EXCEPTION -- the generic code every failed
      // tools/call collapsed into, which is what made this refusal
      // indistinguishable from a callee that crashed. ctx.call's guards now
      // reject with a DeviceError, and a code survives the worker hop and
      // the gateway untouched. test/composition/09-refusal-codes.js owns
      // the full set; this file keeps its own assertion honest.
      assert.strictEqual(body.result.structuredContent.code, 'CTX_CALL_UNDECLARED',
        JSON.stringify(body));
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
    // setComposition(device, null) is the verdict "verification ran and had
    // nothing to bind". It is required now: an untouched device means
    // verification has not reached it yet, and ctx.call refuses that with
    // CTX_CALL_NOT_READY rather than sending the caller off to fix an auth
    // config that may be perfectly correct (09-refusal-codes.js).
    handlerCtx.setComposition(device, null);
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

// Single-thread mode (no --workerThread): the OTHER half of
// DeviceManager.prototype.verifyComposition's callback in
// onAllModulesDiscovered. Under --workerThread, this.deviceMap[deviceID] on
// the main thread is a WorkerMessage proxy, so the resolved {identity,
// allowed} has to be relayed into the composing module's own worker thread
// (WorkerMessage.prototype.sendSetCompositionMessage / lib/sandbox.js's
// 'set-composition' case) before ctx.call can see it -- that is what the
// describe block above exercises. Without --workerThread,
// this.deviceMap[deviceID] IS the real CHDevice directly, so verifyComposition
// takes its `else` branch instead: a plain, synchronous
// handlerCtx.setComposition(cdifDevice, composition) call, no relay at all.
// That branch has no other coverage in this suite -- this is it.
//
// Reuses this file's fixtures and auth config (compose-callee/compose-caller,
// fixtures-auth.json's "compose-caller-internal" binding), on a different
// port (9560) from the worker-mode server above (9556) so the two servers,
// which this file's own before/after hooks keep alive for the whole
// duration of their respective describe blocks, never collide. 9560, not
// 9557: 03-declaration.js's server also uses 9557, and mocha runs these
// files back to back -- see this file's after() below for the other half
// of that fix (waiting for the process to actually exit before the next
// file's before() tries to bind the port it just freed).
const PORT_SINGLE_THREAD = 9560;
const BASE_SINGLE_THREAD = `http://127.0.0.1:${PORT_SINGLE_THREAD}`;

let singleThreadServer;

function startSingleThreadServer(done) {
  singleThreadServer = spawn(process.execPath, [
    path.join(__dirname, '..', '..', 'framework.js'),
    // Deliberately no --workerThread.
    '--bindAddr', '127.0.0.1', '--port', String(PORT_SINGLE_THREAD),
    '--authConfigPath', path.join(__dirname, 'fixtures-auth.json'),
    '--loadModule', path.join(FIXTURES, 'compose-callee'),
    '--loadModule', path.join(FIXTURES, 'compose-caller')
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  let out = '';
  const onData = (buf) => {
    out += buf.toString();
    if (/all module discovered/i.test(out)) {
      setTimeout(done, 2500);
      singleThreadServer.stdout.removeListener('data', onData);
    }
  };
  singleThreadServer.stdout.on('data', onData);
  singleThreadServer.stderr.on('data', onData);
}

function callToolSingleThread(name, args, cb) {
  request(BASE_SINGLE_THREAD)
    .post('/mcp')
    .set('X-CH-Key', 'composition-test-key')
    .set('Accept', 'application/json, text/event-stream')
    .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: name, arguments: args}})
    .expect(200)
    .end((err, res) => {
      if (err) return cb(err);
      return cb(null, res.body);
    });
}

describe('ctx.call: success in single-thread mode (no --workerThread)', function() {
  this.timeout(40000);

  before((done) => startSingleThreadServer(done));
  // Await 'exit', not just issuing the kill -- SIGKILL is asynchronous, and
  // 03-declaration.js's own server binds this same port range right after
  // this file finishes. Returning before the process has actually released
  // the port is what produced the measured EADDRINUSE flakes (3/10 at 0ms
  // delay between the two files, 0/10 once this waits on 'exit').
  after((done) => {
    if (singleThreadServer == null) return done();
    singleThreadServer.on('exit', () => done());
    singleThreadServer.kill('SIGKILL');
  });

  it('viaCall (a declared address) succeeds end-to-end: a real two-hop ctx.call, single-thread mode', (done) => {
    callToolSingleThread('compose_caller_callerservice_viacall', {n: 21}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, false, JSON.stringify(body));
      assert.strictEqual(body.result.structuredContent.output.n, 42, JSON.stringify(body));
      done();
    });
  });
});

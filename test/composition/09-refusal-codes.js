// ctx.call's refusals, as an MCP client actually sees them.
//
// Two fixes are pinned here.
//
// 1. TYPED CODES. Every guard clause in lib/handler-ctx.js's ctx.call used
//    to reject with a plain Error. lib/service.js's `fail` only preserves a
//    DeviceError/CHError; anything else is flattened to
//    DEVICE_INVOKE_EXCEPTION with the original text pushed into the fault
//    payload -- and lib/mcp/gateway.js's toolCallResult builds the client
//    shape from `err.message`/`err.code` alone, so the fault payload is
//    dropped. Result: a typo'd address, a missing runsModules binding and a
//    callee that genuinely threw were byte-identical to an MCP client.
//    Rejecting with a DeviceError instead makes the code survive both the
//    worker hop (DeviceManager.prototype.invokeAction re-wraps as
//    `new DeviceError(err.code)`) and the gateway, with no change to either.
//
//    Because that re-wrap keeps the code and discards the message, each
//    code's message head in error-info.*.json has to be actionable on its
//    own -- the per-call detail (which address) only survives in
//    single-thread mode and over REST /invoke-action.
//
// 2. "NOT READY" IS NOT "MISCONFIGURED". Composition verification runs
//    asynchronously after discovery, so there is a startup window where a
//    device is already in tools/list and already serving. A ctx.call landing
//    in that window used to be told "no auth identity is bound to this
//    module. Add its friendlyName to ... runsModules" -- against an auth
//    config that was completely correct. handlerCtx.setComposition is now
//    the delivery of a verdict (including the empty verdict for a module
//    with no "countinghouse.calls"), and a device that has not received one
//    yet refuses with CTX_CALL_NOT_READY instead of blaming the config.
const assert = require('assert');

// Before requiring anything that reaches lib/countinghouse-util.js -- same
// reason as test/composition/02-ctx-call.js's copy of this line.
require('../../lib/cli-options').setOptions({});
const handlerCtx = require('../../lib/handler-ctx');

function fakeDevice() {
  return {deviceID: 'unit-test-device', spec: {device: {friendlyName: 'compose-caller'}}};
}

function buildCtx(device) {
  return handlerCtx.buildCtx(device, {ctx: {appKey: 'irrelevant'}}, {});
}

async function refusalOf(ctx, address) {
  try {
    await ctx.call(address, {});
  } catch (err) {
    return err;
  }
  throw new Error(`expected ctx.call("${address}") to reject`);
}

describe('ctx.call refusals carry a code an MCP client can branch on', () => {
  it('refuses with CTX_CALL_NOT_READY before verification has delivered a verdict', async () => {
    // No setComposition call at all: this is the startup window, not a
    // misconfigured module.
    const err = await refusalOf(buildCtx(fakeDevice()), 'compose-callee/calleeService.double');

    assert.strictEqual(err.code, 'CTX_CALL_NOT_READY', err.message);
    assert.ok(!/runsModules/.test(err.message),
      `must not blame the auth config while verification is still in flight: ${err.message}`);
  });

  it('refuses with CTX_CALL_UNBOUND once a verdict says nothing is bound', async () => {
    const device = fakeDevice();
    handlerCtx.setComposition(device, null);   // the verdict: verified, bound nothing

    const err = await refusalOf(buildCtx(device), 'compose-callee/calleeService.double');

    assert.strictEqual(err.code, 'CTX_CALL_UNBOUND', err.message);
    assert.ok(/runsModules/.test(err.message), `expected "runsModules" in: ${err.message}`);
  });

  it('refuses an undeclared address with CTX_CALL_UNDECLARED', async () => {
    const device = fakeDevice();
    handlerCtx.setComposition(device, {
      identity: 'compose-caller-internal',
      allowed: {'compose-callee/calleeService.double': true}
    });

    const err = await refusalOf(buildCtx(device), 'compose-callee/calleeService.triple');

    assert.strictEqual(err.code, 'CTX_CALL_UNDECLARED', err.message);
    assert.ok(/countinghouse\.calls/.test(err.message),
      `expected "countinghouse.calls" in: ${err.message}`);
  });

  it('refuses a malformed address with CTX_CALL_BAD_ADDRESS', async () => {
    const device = fakeDevice();
    handlerCtx.setComposition(device, {identity: 'compose-caller-internal', allowed: {'nonsense': true}});

    const err = await refusalOf(buildCtx(device), 'nonsense');

    assert.strictEqual(err.code, 'CTX_CALL_BAD_ADDRESS', err.message);
  });

  // The message head has to stand on its own, because under --workerThread
  // it is all that reaches the client (see the header).
  it('gives each code a head message that is actionable without the detail', () => {
    const DeviceError = require('../../lib/countinghouse-error').DeviceError;

    for (const code of ['CTX_CALL_NOT_READY', 'CTX_CALL_UNBOUND',
                        'CTX_CALL_UNDECLARED', 'CTX_CALL_BAD_ADDRESS',
                        'CTX_CALL_UNRESOLVED']) {
      const head = new DeviceError(code).message;
      assert.notStrictEqual(head, code, `${code} has no entry in error-info.*.json`);
      assert.ok(/ctx\.call/.test(head), `${code}'s head should name ctx.call: ${head}`);
    }
  });
});

// The other half: the same codes, seen the way a real MCP client sees them,
// through --workerThread (where only `code` survives the hop back to the
// main thread) and through lib/mcp/gateway.js.
//
// compose-caller-nocalls is the fixture that pins the verdict-delivery half
// of the fix. It declares no "countinghouse.calls", so verifyComposition
// takes its documented early return and has nothing to bind -- but that is
// still an answer, and it has to be delivered, or the module sits in the
// startup window forever and reports CTX_CALL_NOT_READY on a server that
// finished starting minutes ago.
const path    = require('path');
const request = require('supertest');
const spawn   = require('child_process').spawn;

const PORT     = 9564;
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const BASE     = `http://127.0.0.1:${PORT}`;

let server;

// Same shape as 02-ctx-call.js's startServer: "all module discovered" plus a
// settle buffer, because verifyComposition's own async work (a querydevice
// resolution, an authenticate() round trip, then the main<->worker relay)
// runs after that line is printed.
function startServer(done) {
  server = spawn(process.execPath, [
    path.join(__dirname, '..', '..', 'framework.js'),
    '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(PORT),
    '--authConfigPath', path.join(__dirname, 'fixtures-auth.json'),
    '--loadModule', path.join(FIXTURES, 'compose-callee'),
    '--loadModule', path.join(FIXTURES, 'compose-caller'),
    '--loadModule', path.join(FIXTURES, 'compose-caller-nocalls')
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  let out = '';
  const onData = (buf) => {
    out += buf.toString();
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
    .end((err, res) => (err ? cb(err) : cb(null, res.body)));
}

describe('ctx.call refusal codes reach an MCP client through the worker hop', function() {
  this.timeout(40000);

  before((done) => startServer(done));
  after(() => { if (server != null) server.kill('SIGKILL'); });

  it('an undeclared address arrives as CTX_CALL_UNDECLARED, not DEVICE_INVOKE_EXCEPTION', (done) => {
    callTool('compose_caller_callerservice_undeclared', {}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, true, JSON.stringify(body));
      assert.strictEqual(body.result.structuredContent.code, 'CTX_CALL_UNDECLARED',
        JSON.stringify(body));
      // And the text is the actionable head, not "Device interface call
      // threw an exception".
      assert.ok(/countinghouse\.calls/.test(body.result.content[0].text), JSON.stringify(body));
      done();
    });
  });

  it('a module with no countinghouse.calls settles as CTX_CALL_UNBOUND, not NOT_READY', (done) => {
    callTool('compose_caller_nocalls_callerservice_trycall', {}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, true, JSON.stringify(body));
      assert.strictEqual(body.result.structuredContent.code, 'CTX_CALL_UNBOUND',
        JSON.stringify(body));
      done();
    });
  });

  // A callee that genuinely crashed must stay DEVICE_INVOKE_EXCEPTION: the
  // point of the typed codes is to tell a misconfigured chain apart from a
  // failing one, so collapsing this into the CTX_CALL_* family would give
  // back exactly the ambiguity being fixed.
  it('still reports a genuinely failing callee as DEVICE_INVOKE_EXCEPTION', (done) => {
    callTool('compose_caller_callerservice_viaboom', {}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, true, JSON.stringify(body));
      assert.strictEqual(body.result.structuredContent.code, 'DEVICE_INVOKE_EXCEPTION',
        JSON.stringify(body));
      done();
    });
  });
});

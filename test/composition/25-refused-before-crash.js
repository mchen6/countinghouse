'use strict';
// A module call that fails as a crash (DEVICE_INVOKE_EXCEPTION) says what the
// runtime refused that call's module calls with before it failed, the code
// the module itself saw: only when the main thread itself refused one, never
// from anything the worker says, and never naming the other module.
// (A pack check saw bare DEVICE_INVOKE_EXCEPTIONs with no
// detail anywhere a user could see; the cold-call case was a ctx.call the
// main thread refused because its callee was not there, then the handler
// threw. Here the callee is unloaded at run time, so the main thread refuses
// the crasher's declared, granted call the same way.)
const assert  = require('assert');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const {ROOT, startServer, stopServer, mcpCall, post} = require('../helpers/sandbox-server');
const {toolErrorCode} = require('../helpers/tool-result');
const {deviceIDForName} = require('../../lib/call-address');
const {testPort} = require('../helpers/test-env');

const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const LINE     = /Before it failed, the runtime refused its call to another module: ([A-Z][A-Z0-9_]+)\./;
const hex      = () => crypto.randomBytes(6).toString('hex');
const tmp      = require('../helpers/test-tmp').forFile(['ch-refused-25-']);

// (each path: the direct peer channels, on by default, and the routed one,
// where a hop passes the main thread's hop path)
for (const [label, port, flags] of [['peer channels', testPort(9678), []], ['routed', testPort(9679), ['--no-directPeerChannels']]]) {
describe(`composition 25 (${label}): a crash after the runtime refused one of its module calls says that refusal`, function() {
  this.timeout(120000);
  const KEYS = {user: `user-key-${hex()}`, admin: `admin-key-${hex()}`, crasher: `crasher-internal-${hex()}`, caller: `caller-internal-${hex()}`, relay: `relay-internal-${hex()}`, rethrower: `rethrower-internal-${hex()}`};
  let server = null;

  before(async () => {
    const base = tmp.mkdtemp('ch-refused-25-');
    const authPath = path.join(base, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({
      [KEYS.user]: {userName: `user-${hex()}`, devices: ['*']},
      [KEYS.admin]: {userName: `admin-${hex()}`, devices: ['*'], admin: true},
      // granted the callee, so its declared call verifies at load
      [KEYS.crasher]: {userName: `crasher-${hex()}`, devices: [deviceIDForName('compose-callee')], runsModules: ['compose-crasher']},
      [KEYS.caller]: {userName: `caller-${hex()}`, devices: ['*'], runsModules: ['compose-caller']},
      [KEYS.relay]: {userName: `relay-${hex()}`, devices: ['compose-crasher', 'compose-rethrower', 'compose-big'].map(deviceIDForName), runsModules: ['compose-relay']},
      [KEYS.rethrower]: {userName: `rethrower-${hex()}`, devices: [deviceIDForName('compose-callee')], runsModules: ['compose-rethrower']}
    }), {mode: 0o600});
    server = await startServer(port, ['--workerThread', ...flags, '--authProvider', 'file', '--authConfigPath', authPath,
      '--moduleSandbox', 'off', '--moduleDataPath', path.join(base, 'store'),
      '--loadModule', path.join(FIXTURES, 'compose-callee'),
      '--loadModule', path.join(FIXTURES, 'compose-caller'),
      '--loadModule', path.join(FIXTURES, 'compose-crasher'),
      '--loadModule', path.join(FIXTURES, 'compose-rethrower'),
      '--loadModule', path.join(FIXTURES, 'compose-big'),
      '--loadModule', path.join(FIXTURES, 'compose-relay')]);
  });
  after(() => stopServer(server));

  const call = (name) => mcpCall(port, KEYS.user, name, {});
  // a line the server logs, waited for (bounded), never read once and hoped for
  const logged = async (re) => { for (let i = 0; i < 50 && !re.test(server.output); i++) await new Promise((r) => setTimeout(r, 100)); return re.test(server.output); };
  const textOf = (result) => result.content.map((c) => c.text).join('\n');

  it('an untyped throw with no module call refused: no such line, whatever the module wrote', async () => {
    const result = await call('compose_crasher_crasherservice_throwsalone');
    assert.strictEqual(toolErrorCode(result), 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(result));
    assert.ok(!LINE.test(textOf(result)), textOf(result));
  });

  it('a callee\'s own crash relayed back is not the runtime\'s refusal: no line', async () => {
    const result = await call('compose_caller_callerservice_viaboom');
    assert.strictEqual(toolErrorCode(result), 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(result));
    assert.ok(!LINE.test(textOf(result)), textOf(result));
  });

  it('a call the runtime refused, then an untyped throw: DEVICE_INVOKE_EXCEPTION, and the refusal\'s code in one line, never the other module\'s name', async () => {
    assert.strictEqual((await post(port, KEYS.admin, '/unload-module', {name: 'compose-callee'})).status, 200);
    const result = await call('compose_crasher_crasherservice_refusedthenthrow');
    assert.strictEqual(result.isError, true, JSON.stringify(result));
    assert.strictEqual(toolErrorCode(result), 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(result));
    const m = LINE.exec(textOf(result));
    // (an unloaded part is said as DEVICE_NOT_FOUND, whatever its state; the log keeps the exact code)
    assert.ok(m != null && m[1] === 'DEVICE_NOT_FOUND', textOf(result));
    assert.ok(await logged(/a call failed: compose-crasher\/refusedThenThrow: DEVICE_INVOKE_EXCEPTION \(the module crashed\), after the runtime refused its call to another module: MODULE_UNLOADED/), server.output.slice(-3000));
    assert.ok(!/compose-callee|calleeService|double/.test(textOf(result)), textOf(result));
    // (the module's own text never crosses)
    assert.ok(!/the call failed/.test(textOf(result)), textOf(result));
  });

  it('a module two calls down: its refusal is not said, a plain crash answer (main sees a part\'s failure only through its worker\'s report)', async () => {
    // (compose-callee was unloaded above: compose-crasher's own call is refused by
    // the main thread, it throws, and compose-relay throws in turn. Over a direct
    // peer channel whether the part failed reaches the main thread only as the
    // callee worker's own report, which is not trusted for this: the sentence is
    // honestly absent.)
    const result = await call('compose_relay_relayservice_relaythrow');
    assert.strictEqual(toolErrorCode(result), 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(result));
    assert.ok(!LINE.test(textOf(result)), textOf(result));
    assert.ok(!/compose-callee|compose-crasher|the relay failed/.test(textOf(result)), textOf(result));
  });

  it('a part that rethrew the typed refusal it got: that code came back in its reply, never noted as the runtime\'s refusal of the caller\'s call', async () => {
    // (compose-callee was unloaded above; compose-rethrower's own call is refused
    // and it rethrows that error, whose code crosses back in its reply. On the
    // routed path the hop's answer passes the main thread, which notes only what
    // it raised itself: no sentence.)
    const result = await call('compose_relay_relayservice_relayrethrow');
    assert.strictEqual(toolErrorCode(result), 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(result));
    assert.ok(!LINE.test(textOf(result)), textOf(result));
  });

  (label === 'routed' ? it : it.skip)('a hop the runtime refused after it was sent (its answer fails its schema in the main thread\'s validator): the runtime\'s own refusal, said as it is', async () => {
    const result = await call('compose_relay_relayservice_relaybig');
    assert.strictEqual(toolErrorCode(result), 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(result));
    const m = LINE.exec(textOf(result));
    assert.ok(m != null && m[1] === 'OUTPUT_DATA_VALIDATION_FAIL', textOf(result));
  });

  it('the runtime logs each such failure without --debug: the tool, the code and its class, and the refusal; no module text', async () => {
    assert.ok(await logged(/a call failed: \S+: DEVICE_INVOKE_EXCEPTION \(the module crashed\), after the runtime refused its call to another module: [A-Z][A-Z0-9_]+/), server.output.slice(-3000));
    assert.ok(!/the call failed: /.test(server.output), 'the module\'s own text is never logged');
    // (a callee's crash relayed to its caller is one user call: logged once, as the caller's tool, never again as the callee's)
    assert.ok(await logged(/a call failed: compose-caller\/viaBoom: DEVICE_INVOKE_EXCEPTION/), server.output.slice(-3000));
    assert.ok(!/a call failed: compose-callee\//.test(server.output), 'a hop\'s own session is not logged');
  });
  tmp.hooks();
});
}

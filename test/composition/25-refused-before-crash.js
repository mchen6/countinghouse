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
const request = require('supertest');
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
      [KEYS.relay]: {userName: `relay-${hex()}`, devices: ['compose-crasher', 'compose-rethrower', 'compose-big', 'compose-slowbad', 'compose-callee'].map(deviceIDForName), runsModules: ['compose-relay']},
      [KEYS.rethrower]: {userName: `rethrower-${hex()}`, devices: [deviceIDForName('compose-callee')], runsModules: ['compose-rethrower']}
    }), {mode: 0o600});
    server = await startServer(port, ['--workerThread', ...flags, '--authProvider', 'file', '--authConfigPath', authPath,
      '--moduleSandbox', 'off', '--moduleDataPath', path.join(base, 'store'), '--store', 'local', '--storePath', path.join(base, 'jobs'),
      '--loadModule', path.join(FIXTURES, 'compose-callee'),
      '--loadModule', path.join(FIXTURES, 'compose-caller'),
      '--loadModule', path.join(FIXTURES, 'compose-crasher'),
      '--loadModule', path.join(FIXTURES, 'compose-rethrower'),
      '--loadModule', path.join(FIXTURES, 'compose-big'),
      '--loadModule', path.join(FIXTURES, 'compose-slowbad'),
      '--loadModule', path.join(FIXTURES, 'compose-relay')]);
  });
  after(() => stopServer(server));

  const call = (name) => mcpCall(port, KEYS.user, name, {});
  // a line the server logs, waited for (bounded), never read once and hoped for
  const logged = async (re) => { for (let i = 0; i < 50 && !re.test(server.output); i++) await new Promise((r) => setTimeout(r, 100)); return re.test(server.output); };
  const textOf = (result) => result.content.map((c) => c.text).join('\n');

  const V = '2026-07-28';
  const EXT = 'io.modelcontextprotocol/tasks';
  const modern = (method, params) => request(`http://127.0.0.1:${port}`).post('/mcp').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream')
    .set('X-CH-Key', KEYS.user).set('MCP-Protocol-Version', V).set('Mcp-Method', method).set('Mcp-Name', String(params.name || params.taskId))
    .send({jsonrpc: '2.0', id: 1, method, params: Object.assign({_meta: {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {extensions: {[EXT]: {}}}}}, params)})
    .then((r) => r.body);
  const runTask = async (name) => {
    const started = await modern('tools/call', {name, arguments: {}});
    assert.strictEqual((started.result || {}).resultType, 'task', JSON.stringify(started));
    let task = null;
    for (let i = 0; i < 300; i++) {
      task = (await modern('tasks/get', {taskId: started.result.taskId})).result;
      if (task != null && task.status !== 'working') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return task;
  };

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

  it('a refusal two calls down: the part\'s token, main\'s own note on it, passes up when the part is done, so the user\'s answer says it', async () => {
    // (compose-callee was unloaded above: compose-crasher's own call is refused by
    // the main thread, which notes it on the crasher's token; the crasher throws,
    // its token goes, and the note passes to compose-relay's call, which throws in
    // turn. Nothing a worker reports is trusted for it.)
    const result = await call('compose_relay_relayservice_relaythrow');
    assert.strictEqual(toolErrorCode(result), 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(result));
    const m = LINE.exec(textOf(result));
    assert.ok(m != null && m[1] === 'DEVICE_NOT_FOUND', textOf(result));
    assert.ok(!/compose-callee|compose-crasher|the relay failed/.test(textOf(result)), textOf(result));
  });

  it('a task run (a task-augmented tools/call) adds the sentence to its failure, and is logged', async () => {
    const started = await modern('tools/call', {name: 'compose_crasher_crasherservice_refusedthenthrowtask', arguments: {}});
    assert.strictEqual((started.result || {}).resultType, 'task', JSON.stringify(started));
    let task = null;
    for (let i = 0; i < 200; i++) {
      task = (await modern('tasks/get', {taskId: started.result.taskId})).result;
      if (task != null && task.status !== 'working') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // (a task's answer: its result, an isError tool result, once it is done)
    assert.ok(task.status === 'completed' && task.result != null && task.result.isError === true, JSON.stringify(task));
    assert.ok(/Before it failed, the runtime refused its call to another module: DEVICE_NOT_FOUND\./.test(textOf(task.result)), JSON.stringify(task));
    assert.ok(await logged(/a call failed: compose-crasher\/refusedThenThrowTask: DEVICE_INVOKE_EXCEPTION \(the module crashed\), after the runtime refused its call to another module: MODULE_UNLOADED/), server.output.slice(-3000));
  });

  // (a job added over HTTP runs through the same runner as a task: the
  // CHANGELOG's "a task run (a task-augmented tools/call or a job)")
  it('a job added over HTTP (add-job) adds the sentence to its failure, and is logged', async () => {
    const LOGGED = /a call failed: compose-crasher\/refusedThenThrowTask: DEVICE_INVOKE_EXCEPTION \(the module crashed\), after the runtime refused its call to another module: MODULE_UNLOADED/g;
    const before = (server.output.match(LOGGED) || []).length;
    const added = await request(`http://127.0.0.1:${port}`).post(`/devices/${deviceIDForName('compose-crasher')}/add-job`).set('X-CH-Key', KEYS.user)
      .send({serviceID: 'urn:countinghouse-test:serviceID:crasherService', actionName: 'refusedThenThrowTask', opts: {name: `refused-job-${hex()}`}, input: {}});
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));
    let rec = null;
    for (let i = 0; i < 200; i++) {
      rec = (await request(`http://127.0.0.1:${port}`).post(`/devices/${deviceIDForName('compose-crasher')}/get-job`).set('X-CH-Key', KEYS.user).send({id: added.body.id})).body;
      if (rec != null && rec.job != null && rec.job.failedReason != null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const reason = rec && rec.job ? String(rec.job.failedReason) : '';
    assert.ok(/^DEVICE_INVOKE_EXCEPTION: /.test(reason), JSON.stringify(rec));
    assert.ok(/Before it failed, the runtime refused its call to another module: DEVICE_NOT_FOUND\./.test(reason), JSON.stringify(rec));
    // (its own line, beside the task's: one more than before)
    let now = before;
    for (let i = 0; i < 50 && now <= before; i++) { await new Promise((r) => setTimeout(r, 100)); now = (server.output.match(LOGGED) || []).length; }
    assert.ok(now === before + 1, `${before} -> ${now}: ${server.output.slice(-1500)}`);
  });

  it('a part that rethrew the typed refusal it got: said from main\'s own note on the part\'s token, passed up when it is done, never from its reply\'s code', async () => {
    // (compose-callee was unloaded above; compose-rethrower's own call is refused
    // through the device query, which the main thread notes on its token, and it
    // rethrows that error, whose code also crosses back in its reply. The hop's
    // answer notes only what main raised itself; the sentence comes from the
    // part's token, dropped when it is done: a part's state, so DEVICE_NOT_FOUND.)
    const result = await call('compose_relay_relayservice_relayrethrow');
    assert.strictEqual(toolErrorCode(result), 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(result));
    const m = LINE.exec(textOf(result));
    assert.ok(m != null && m[1] === 'DEVICE_NOT_FOUND', textOf(result));
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

// A hop's own timer firing, then its late answer refused by the main thread:
// by its nature a case of time (the timer is what is tested), so it has a
// server of its own with a short hop timeout and wide margins around it
// (the part answers 2 s after its hop's timeout; the relay throws 3 s after
// that), on the routed path where the answer passes the main thread.
describe('composition 25 (routed, a hop\'s timer): a late answer after it fired is not the caller\'s refusal', function() {
  this.timeout(120000);
  const port = testPort(9711);
  const KEYS = {user: `user-key-${hex()}`, relay: `relay-internal-${hex()}`, crasher: `crasher-internal-${hex()}`, rethrower: `rethrower-internal-${hex()}`};
  const textOf = (result) => result.content.map((c) => c.text).join('\n');
  const V = '2026-07-28';
  const EXT = 'io.modelcontextprotocol/tasks';
  const modern = (method, params) => request(`http://127.0.0.1:${port}`).post('/mcp').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream')
    .set('X-CH-Key', KEYS.user).set('MCP-Protocol-Version', V).set('Mcp-Method', method).set('Mcp-Name', String(params.name || params.taskId))
    .send({jsonrpc: '2.0', id: 1, method, params: Object.assign({_meta: {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {extensions: {[EXT]: {}}}}}, params)})
    .then((r) => r.body);
  let server = null;
  before(async () => {
    const base = tmp.mkdtemp('ch-refused-25-');
    const authPath = path.join(base, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({
      [KEYS.user]: {userName: `user-${hex()}`, devices: ['*']},
      [KEYS.relay]: {userName: `relay-${hex()}`, devices: ['compose-slowbad', 'compose-callee', 'compose-crasher', 'compose-rethrower', 'compose-big'].map(deviceIDForName), runsModules: ['compose-relay']},
      // (each composing module bound and granted its own calls, so all verify at the start)
      [KEYS.crasher]: {userName: `crasher-${hex()}`, devices: [deviceIDForName('compose-callee')], runsModules: ['compose-crasher']},
      [KEYS.rethrower]: {userName: `rethrower-${hex()}`, devices: [deviceIDForName('compose-callee')], runsModules: ['compose-rethrower']}
    }), {mode: 0o600});
    server = await startServer(port, ['--workerThread', '--no-directPeerChannels', '--requestTimeout', '2', '--authProvider', 'file', '--authConfigPath', authPath,
      '--moduleSandbox', 'off', '--moduleDataPath', path.join(base, 'store'), '--store', 'local', '--storePath', path.join(base, 'jobs'),
      '--loadModule', path.join(FIXTURES, 'compose-callee'),
      '--loadModule', path.join(FIXTURES, 'compose-crasher'),
      '--loadModule', path.join(FIXTURES, 'compose-rethrower'),
      '--loadModule', path.join(FIXTURES, 'compose-big'),
      '--loadModule', path.join(FIXTURES, 'compose-slowbad'),
      '--loadModule', path.join(FIXTURES, 'compose-relay')]);
    // (the server answers before its modules have loaded: wait, bounded, for the tool to be listed)
    for (let i = 0; i < 300; i++) {
      const listed = (await request(`http://127.0.0.1:${port}`).post('/mcp').set('X-CH-Key', KEYS.user).set('Accept', 'application/json, text/event-stream')
        .send({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}})).body;
      if (listed != null && listed.result != null && listed.result.tools.some((x) => x.name === 'compose_relay_relayservice_relayslowtask')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`compose_relay_relayservice_relayslowtask was never listed: ${server.output.slice(-2000)}`);
  });
  after(() => stopServer(server));

  it('a part\'s late answer, refused by the runtime after its hop timed out and a later call went through, is not named', async () => {
    const started = await modern('tools/call', {name: 'compose_relay_relayservice_relayslowtask', arguments: {}});
    assert.strictEqual((started.result || {}).resultType, 'task', JSON.stringify(started));
    let task = null;
    // (bounded: the run ends by itself, at about 7 s)
    for (let i = 0; i < 400; i++) {
      task = (await modern('tasks/get', {taskId: started.result.taskId})).result;
      if (task != null && task.status !== 'working') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(task.status === 'completed' && task.result != null && task.result.isError === true, JSON.stringify(task));
    assert.ok(!LINE.test(textOf(task.result)), textOf(task.result));
  });
  tmp.hooks();
});

// ctx.call on a module whose composition has not been verified yet waits for
// the verdict, bounded (reviewer, 2026-11-12; LM1 part C). An agent calls a
// tool the moment tools/list shows it, and a scenario is listed (and serving)
// before its composition has been verified and the verdict delivered into its
// worker, so that call used to answer CTX_CALL_NOT_READY. The wait is in
// ctx.call itself, so every path that reaches a handler is covered: a direct
// call, a job, a hop from another module.
// - A call made right after the listing succeeds once the verdict lands.
// - A hop into a part whose own verdict is late waits too.
// - Still unverified at the bound, ctx.call answers CTX_CALL_NOT_READY as
//   before. The bound is min(25 s, requestTimeout - 2 s), under the request's
//   own timer, so the code reaches the client rather than a timeout.
// COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MS (test suite only) holds the verdict's
// delivery back; COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MODULE limits it to one
// package.
//
// tools/list over stdio waits for the startup discovery, which ends when every
// verdict has been decided (a module failing verification is purged, never
// listed), not when the verdicts reach their workers. So a listed tool can
// still be waiting for its verdict, which is the window these cases test. The
// last case lists past that gate (its bound shortened to 1 ms, the suite's own
// knob), the only way a client sees a module before it fails verification.
//
// The server is the local single-identity profile over stdio: no Redis and
// no port. The modules are written to a temporary directory, the parts under
// the scenario's node_modules, where the runtime resolves parts.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const ENTRY = path.join(__dirname, '..', '..', 'bin', 'countinghouse-stdio.js');

function writeModule(dir, {name, role, calls, service, action, handler, resource}) {
  fs.mkdirSync(path.join(dir, 'handlers', service), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', countinghouse: {role, ...(calls ? {calls} : {})}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'countinghouse-test', modelDescription: `${name}: composition 19`,
    serviceList: {[`urn:countinghouse-test:serviceID:${service}`]: {actionList: [{name: action, description: `${action} (composition 19)`,
      input: {schema: `/${service}/${action}/input`}, output: {schema: `/${service}/${action}/output`}, ...(resource != null ? {resource} : {})}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    [service]: {[action]: {input: {type: 'object', properties: {n: {type: 'number'}}, additionalProperties: false},
      output: {type: 'object', properties: {n: {type: 'number'}}, required: ['n'], additionalProperties: false}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', service, `${action}.js`), handler);
}

const callNext = (address, op) => `module.exports = async (input, ctx) => ({output: {n: (await ctx.call('${address}', {n: input.n})).output.n ${op}}});\n`;

// compose-wait (scenario) -> compose-wait-mid (part, calls on) -> compose-wait-end (part).
function fixture(root, {slowStartMs = 0, badCall = false, resource = null} = {}) {
  const scenario = path.join(root, 'compose-wait');
  const nm = path.join(scenario, 'node_modules');
  const first = badCall ? 'compose-wait-mid/midService.nonexistent' : 'compose-wait-mid/midService.inc';
  const slow = slowStartMs > 0 ? `await new Promise((r) => setTimeout(r, ${slowStartMs})); ` : '';
  writeModule(scenario, {name: 'compose-wait', role: 'scenario', calls: [first], service: 'waitService', action: 'compose_wait', resource,
    handler: `module.exports = async (input, ctx) => { ${slow}return {output: {n: (await ctx.call('${first}', {n: input.n})).output.n}}; };\n`});
  writeModule(path.join(nm, 'compose-wait-mid'), {name: 'compose-wait-mid', role: 'part', calls: ['compose-wait-end/endService.double'], service: 'midService', action: 'inc',
    handler: callNext('compose-wait-end/endService.double', '+ 1')});
  writeModule(path.join(nm, 'compose-wait-end'), {name: 'compose-wait-end', role: 'part', service: 'endService', action: 'double',
    handler: 'module.exports = async (input) => ({output: {n: input.n * 2}});\n'});
  return scenario;
}

// A stdio server and a newline-delimited JSON-RPC client for it.
function serve({delayMs, delayModule, args = [], slowStartMs, badCall, stdioBoundMs, slowSibling, resource}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-composition-19-'));
  const more = [];
  if (slowSibling === true) {
    // A valid scenario, no calls, whose handler takes about 3 s to load.
    const sibling = path.join(root, 'compose-slow');
    writeModule(sibling, {name: 'compose-slow', role: 'scenario', service: 'slowService', action: 'compose_slow',
      handler: 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);\nmodule.exports = async (input) => ({output: {n: input.n}});\n'});
    more.push('--loadModule', sibling);
  }
  // The hook is honoured only under the test suite's marker.
  const env = {...process.env, COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG: '1', COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MS: String(delayMs)};
  if (delayModule != null) env.COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MODULE = delayModule;
  if (stdioBoundMs != null) env.COUNTINGHOUSE_TEST_STDIO_READY_BOUND_MS = String(stdioBoundMs);
  const child = spawn(process.execPath, [ENTRY, '--workerThread', '--store', 'local', '--storePath', path.join(root, 'store'),
    '--moduleDataPath', path.join(root, 'module_data'), '--modulePath', path.join(root, 'modules'), '--loadModule', fixture(root, {slowStartMs, badCall, resource}), ...more, ...args],
  {env, stdio: ['pipe', 'pipe', 'pipe']});
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  let id = 0;
  const answer = (n, ms) => new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const look = () => {
      const found = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).find((r) => r != null && r.id === n);
      if (found) return resolve(found);
      if (child.exitCode != null) return reject(new Error(`exited before answering ${n}; stderr: ${err.slice(-1500)}`));
      if (Date.now() > deadline) return reject(new Error(`no answer ${n} in ${ms} ms; stderr: ${err.slice(-1500)}`));
      return setTimeout(look, 50);
    };
    look();
  });
  const request = (method, params, ms = 30000) => {
    const n = ++id;
    child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: n, method, params})}\n`);
    return answer(n, ms);
  };
  const stop = () => { child.kill('SIGKILL'); fs.rmSync(root, {recursive: true, force: true}); };
  return {request, stop, stderr: () => err};
}

async function listed(s) {
  await s.request('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'composition-19', version: '0'}});
  for (const until = Date.now() + 30000; Date.now() < until;) {
    const r = await s.request('tools/list', {});
    if ((r.result.tools || []).some((t) => t.name === 'compose_wait')) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`compose_wait was never listed; stderr: ${s.stderr().slice(-1500)}`);
}

async function timedCall(s, ms) {
  const started = Date.now();
  const r = await s.request('tools/call', {name: 'compose_wait', arguments: {n: 20}}, ms);
  return {r, waited: Date.now() - started};
}

describe('composition 19: ctx.call waits for its module\'s composition verdict, bounded under the request timer', function() {
  this.timeout(120000);

  it('a call made right after the listing succeeds once the verdict lands', async () => {
    const s = serve({delayMs: 3000});
    try {
      await listed(s);
      const {r, waited} = await timedCall(s, 40000);
      assert.strictEqual(r.result.isError, false, `${JSON.stringify(r)}\n${s.stderr().slice(-1500)}`);
      assert.deepStrictEqual(r.result.structuredContent, {n: 41});
      assert.ok(waited >= 1500, `listed before the verdict reached the worker, so the call waited for it (${waited} ms)`);
      assert.ok(waited < 20000, `answered when the verdict landed (${waited} ms), not at the bound`);
      assert.match(s.stderr(), /test hook: composition verdicts delivered 3000 ms late/, 'the hook says it is active');
    } finally {
      s.stop();
    }
  });

  it('a hop into a part whose own verdict is late waits for it (only compose-wait-mid is held back)', async () => {
    const s = serve({delayMs: 3000, delayModule: 'compose-wait-mid'});
    try {
      await listed(s);
      const {r} = await timedCall(s, 40000);
      assert.strictEqual(r.result.isError, false, `${JSON.stringify(r)}\n${s.stderr().slice(-1500)}`);
      assert.deepStrictEqual(r.result.structuredContent, {n: 41});
    } finally {
      s.stop();
    }
  });

  it('still unverified at the bound, it answers CTX_CALL_NOT_READY: 25 s under the default 30 s request timer', async () => {
    const s = serve({delayMs: 60000});
    try {
      await listed(s);
      const {r, waited} = await timedCall(s, 40000);
      assert.strictEqual(r.result.isError, true, JSON.stringify(r));
      assert.strictEqual(r.result._meta['countinghouse/code'], 'CTX_CALL_NOT_READY', 'the code, not the request timeout');
      assert.ok(waited >= 24000 && waited < 29000, `waited ${waited} ms: the bound is 25 s`);
    } finally {
      s.stop();
    }
  });

  it('the bound follows a shorter request timer: requestTimeout - 2 s, so the code still reaches the client', async () => {
    const s = serve({delayMs: 60000, args: ['--requestTimeout', '10']});
    try {
      await listed(s);
      const {r, waited} = await timedCall(s, 20000);
      assert.strictEqual(r.result._meta['countinghouse/code'], 'CTX_CALL_NOT_READY', JSON.stringify(r));
      assert.ok(waited >= 7000 && waited < 10000, `waited ${waited} ms: the bound is 8 s under a 10 s timer`);
    } finally {
      s.stop();
    }
  });

  it('the bound counts from the handler\'s start: a handler that works first still gets the code before the timer', async () => {
    const s = serve({delayMs: 60000, slowStartMs: 3000, args: ['--requestTimeout', '10']});
    try {
      await listed(s);
      const {r, waited} = await timedCall(s, 20000);
      assert.strictEqual(r.result._meta['countinghouse/code'], 'CTX_CALL_NOT_READY', JSON.stringify(r));
      assert.ok(waited >= 7000 && waited < 10000, `waited ${waited} ms: 8 s from the handler's start, under the 10 s timer`);
    } finally {
      s.stop();
    }
  });

  // compose-slow, a valid scenario beside it, takes about 3 s to load: a
  // first list that has its tool was answered after the startup discovery.
  it('through the stdio gate, a module that fails verification at startup is never listed: the first list is final', async () => {
    const s = serve({delayMs: 3000, badCall: true, slowSibling: true});
    try {
      await s.request('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'composition-19', version: '0'}});
      const first = await s.request('tools/list', {});
      const names = (first.result.tools || []).map((t) => t.name);
      assert.ok(names.includes('compose_slow'), `the list waited for the startup discovery: ${names.join(', ')}`);
      assert.ok(!names.includes('compose_wait'), `purged before the list was answered: ${names.join(', ')}`);
      assert.doesNotMatch(s.stderr(), /stdio: the modules are still loading/, 'answered by the gate, not its bound');
    } finally {
      s.stop();
    }
  });

  // A call that reaches the runtime before its module's verdict was even decided (a shared runtime under load lists a module while its
  // parts still load): its token was issued with the module's binding as it was then, none, so its ctx.call was refused on the main
  // thread as a device not found. The call is now held on the main thread until the verdict is decided, bounded as ctx.call's own wait,
  // and its token issued with the binding the verdict gave. The window is compose-slow's ~3 s load (as the case below).
  it('a call sent before its module\'s verdict was decided is held until it is, and its ctx.call reaches the callee', async () => {
    const s = serve({delayMs: 0, stdioBoundMs: 1, slowSibling: true});
    try {
      await listed(s);
      const {r, waited} = await timedCall(s, 40000);
      assert.strictEqual(r.result.isError, false, `${JSON.stringify(r)}\n${s.stderr().slice(-1500)}`);
      assert.deepStrictEqual(r.result.structuredContent, {n: 41});
      assert.ok(waited < 15000, `sent when the verdict was decided (${waited} ms), not at the 25 s bound`);
    } finally {
      s.stop();
    }
  });

  it('held past its bound, such a call answers CTX_CALL_NOT_READY under its request timer: retryable, never sent', async () => {
    const s = serve({delayMs: 0, stdioBoundMs: 1, slowSibling: true, args: ['--requestTimeout', '3']});
    try {
      await listed(s);
      const {r, waited} = await timedCall(s, 20000);
      assert.strictEqual(r.result.isError, true, JSON.stringify(r));
      assert.strictEqual(r.result._meta['countinghouse/code'], 'CTX_CALL_NOT_READY', JSON.stringify(r));
      assert.ok(waited < 3000, `answered at the bound, 1 s under a 3 s timer (${waited} ms)`);
    } finally {
      s.stop();
    }
  });

  // A task (a legacy task-augmented call) to a module whose verdict is not decided: not created until it is, so its run's token has
  // the binding; a purge answers at the creation as any tool the caller can't use, before any task exists.
  async function taskOf(s, ms = 40000) {
    const started = Date.now();
    const created = await s.request('tools/call', {name: 'compose_wait', arguments: {n: 20}, task: {}}, ms);
    return {created, waited: Date.now() - started};
  }
  it('a task created before its module\'s verdict was decided is created once it is, and its run reaches the callee', async () => {
    const s = serve({delayMs: 0, stdioBoundMs: 1, slowSibling: true});
    try {
      await listed(s);
      const {created} = await taskOf(s);
      assert.ok(created.result != null && created.result.task != null, `${JSON.stringify(created)}\n${s.stderr().slice(-1500)}`);
      const taskId = created.result.task.taskId;
      let status = null;
      for (let i = 0; i < 200 && status !== 'completed' && status !== 'failed'; i++) {
        status = (await s.request('tasks/get', {taskId})).result.status;
        if (status !== 'completed' && status !== 'failed') await new Promise((r) => setTimeout(r, 100));
      }
      const res = await s.request('tasks/result', {taskId});
      assert.strictEqual(status, 'completed', JSON.stringify(res));
      assert.deepStrictEqual(res.result.structuredContent, {n: 41});
    } finally {
      s.stop();
    }
  });

  it('a task held past its bound at its creation answers CTX_CALL_NOT_READY under its request timer, no task made', async () => {
    const s = serve({delayMs: 0, stdioBoundMs: 1, slowSibling: true, args: ['--requestTimeout', '3']});
    try {
      await listed(s);
      const {created, waited} = await taskOf(s, 20000);
      assert.ok(waited < 3000, `answered at the bound, 1 s under a 3 s timer (${waited} ms)`);
      assert.ok(created.result != null && created.result.task == null, `no task: ${JSON.stringify(created)}`);
      assert.strictEqual(created.result._meta['countinghouse/code'], 'CTX_CALL_NOT_READY', JSON.stringify(created));
    } finally {
      s.stop();
    }
  });

  it('a task to a module that fails its verification is answered at its creation as any tool the caller can\'t use, no task made', async () => {
    const s = serve({delayMs: 3000, badCall: true, stdioBoundMs: 1, slowSibling: true});
    try {
      await listed(s);
      const {created, waited} = await taskOf(s);
      assert.ok(waited < 15000, `answered when it was purged (${waited} ms)`);
      assert.strictEqual(created.result, undefined, JSON.stringify(created));
      assert.strictEqual(created.error.code, -32602);
      assert.strictEqual(created.error.message, 'unknown tool: compose_wait; countinghouse_overview shows what is installed here and which tools you can use');
    } finally {
      s.stop();
    }
  });

  // The window this case needs, a listed tool whose verification has not
  // failed yet, closes when the startup discovery ends (the purge is part of
  // the decision; the hook delays only the delivery). The window is
  // compose-slow's: its ~3 s load holds the discovery open, whatever the
  // parts' load time. It must not come from how long compose-wait's parts
  // take to load after it: lean workers made that shorter than one
  // list-and-call (#177's CI: "compose_wait was never listed", or listed and
  // then purged before the call reached it, "unknown tool"), and any later
  // speed-up would close it again.
  // A resource read is run as its action's call (runModuleTarget), so it is held the same way; released by a purge, it is answered in
  // its own words, as a URI never served, never as a tool (no tool name, no hint a tool lies behind it)
  it('a resource read held for a module that fails its verification is answered as a URI never served', async () => {
    const s = serve({delayMs: 3000, badCall: true, stdioBoundMs: 1, slowSibling: true, slowStartMs: 20000, resource: {uriTemplate: 'all', name: 'all'}});
    try {
      await s.request('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'composition-19', version: '0'}});
      let uri = null;
      for (const until = Date.now() + 30000; uri == null && Date.now() < until;) {
        const r = await s.request('resources/list', {});
        const found = ((r.result && r.result.resources) || []).find((x) => x.name === 'all');
        if (found != null) uri = found.uri; else await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(uri != null, `never listed; stderr: ${s.stderr().slice(-1500)}`);
      const started = Date.now();
      const r = await s.request('resources/read', {uri}, 40000);
      const waited = Date.now() - started;
      assert.ok(waited < 15000, `released when it was purged (${waited} ms), not at the bound`);
      const fresh = await s.request('resources/read', {uri: uri.replace(/all$/, 'never_served')});
      const shape = (x) => ({keys: Object.keys(x).sort(), code: x.error && x.error.code, message: x.error && x.error.message, data: x.error && x.error.data});
      assert.deepStrictEqual(shape(r), shape(fresh), `${JSON.stringify(r)} / ${JSON.stringify(fresh)}`);
      assert.strictEqual(r.error.message, 'Resource not found');
    } finally {
      s.stop();
    }
  });

  it('a module that fails verification at startup releases its waiting calls at once (listed past the stdio gate)', async () => {
    // (its handler would pause 20 s before its ctx.call: a call sent would answer after it; one held and released never runs it)
    const s = serve({delayMs: 3000, badCall: true, stdioBoundMs: 1, slowSibling: true, slowStartMs: 20000});
    try {
      await listed(s);
      const {r, waited} = await timedCall(s, 40000);
      assert.ok(waited < 15000, `released when it was purged (${waited} ms), not at the bound`);
      // (a retry would never help: answered as any tool the caller can't use is, field by field as a name never registered, nothing run)
      const fresh = await s.request('tools/call', {name: 'never_registered_tool', arguments: {}});
      const shape = (x) => ({keys: Object.keys(x).sort(), code: x.error && x.error.code, message: x.error && x.error.message.replace(/never_registered_tool|compose_wait/, '<name>'), data: x.error && x.error.data});
      assert.deepStrictEqual(shape(r), shape(fresh), `${JSON.stringify(r)} / ${JSON.stringify(fresh)}`);
      assert.strictEqual(r.result, undefined);
      assert.strictEqual(r.error.message, 'unknown tool: compose_wait; countinghouse_overview shows what is installed here and which tools you can use');
    } finally {
      s.stop();
    }
  });
});

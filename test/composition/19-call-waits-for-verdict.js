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
// The server is the local single-identity profile over stdio: no Redis and
// no port. The modules are written to a temporary directory, the parts under
// the scenario's node_modules, where the runtime resolves parts.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const ENTRY = path.join(__dirname, '..', '..', 'bin', 'countinghouse-stdio.js');

function writeModule(dir, {name, role, calls, service, action, handler}) {
  fs.mkdirSync(path.join(dir, 'handlers', service), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', countinghouse: {role, ...(calls ? {calls} : {})}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'countinghouse-test', modelDescription: `${name}: composition 19`,
    serviceList: {[`urn:countinghouse-test:serviceID:${service}`]: {actionList: [{name: action, description: `${action} (composition 19)`,
      input: {schema: `/${service}/${action}/input`}, output: {schema: `/${service}/${action}/output`}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    [service]: {[action]: {input: {type: 'object', properties: {n: {type: 'number'}}, additionalProperties: false},
      output: {type: 'object', properties: {n: {type: 'number'}}, required: ['n'], additionalProperties: false}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', service, `${action}.js`), handler);
}

const callNext = (address, op) => `module.exports = async (input, ctx) => ({output: {n: (await ctx.call('${address}', {n: input.n})).output.n ${op}}});\n`;

// compose-wait (scenario) -> compose-wait-mid (part, calls on) -> compose-wait-end (part).
function fixture(root, {slowStartMs = 0, badCall = false} = {}) {
  const scenario = path.join(root, 'compose-wait');
  const nm = path.join(scenario, 'node_modules');
  const first = badCall ? 'compose-wait-mid/midService.nonexistent' : 'compose-wait-mid/midService.inc';
  const slow = slowStartMs > 0 ? `await new Promise((r) => setTimeout(r, ${slowStartMs})); ` : '';
  writeModule(scenario, {name: 'compose-wait', role: 'scenario', calls: [first], service: 'waitService', action: 'compose_wait',
    handler: `module.exports = async (input, ctx) => { ${slow}return {output: {n: (await ctx.call('${first}', {n: input.n})).output.n}}; };\n`});
  writeModule(path.join(nm, 'compose-wait-mid'), {name: 'compose-wait-mid', role: 'part', calls: ['compose-wait-end/endService.double'], service: 'midService', action: 'inc',
    handler: callNext('compose-wait-end/endService.double', '+ 1')});
  writeModule(path.join(nm, 'compose-wait-end'), {name: 'compose-wait-end', role: 'part', service: 'endService', action: 'double',
    handler: 'module.exports = async (input) => ({output: {n: input.n * 2}});\n'});
  return scenario;
}

// A stdio server and a newline-delimited JSON-RPC client for it.
function serve({delayMs, delayModule, args = [], slowStartMs, badCall}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-composition-19-'));
  // The hook is honoured only under the test suite's marker.
  const env = {...process.env, COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG: '1', COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MS: String(delayMs)};
  if (delayModule != null) env.COUNTINGHOUSE_TEST_COMPOSITION_DELAY_MODULE = delayModule;
  const child = spawn(process.execPath, [ENTRY, '--workerThread', '--store', 'local', '--storePath', path.join(root, 'store'),
    '--moduleDataPath', path.join(root, 'module_data'), '--modulePath', path.join(root, 'modules'), '--loadModule', fixture(root, {slowStartMs, badCall}), ...args],
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
  await s.request('initialize', {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'composition-19', version: '0'}});
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

  it('a module that fails verification at startup releases its waiting calls at once', async () => {
    const s = serve({delayMs: 3000, badCall: true});
    try {
      await listed(s);
      const {r, waited} = await timedCall(s, 40000);
      assert.strictEqual(r.result.isError, true, JSON.stringify(r));
      assert.strictEqual(r.result._meta['countinghouse/code'], 'CTX_CALL_NOT_READY', JSON.stringify(r));
      assert.ok(waited < 15000, `released when it was purged (${waited} ms), not at the bound`);
    } finally {
      s.stop();
    }
  });
});

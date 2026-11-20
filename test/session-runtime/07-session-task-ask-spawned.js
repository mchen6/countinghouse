'use strict';
// MCP completeness M22 in a real shared runtime (--sessionSocket, the local
// store, two sessions through the test's shim; the review of #374): a task
// made by session A, whose handler asks, reads input_required to A; to
// session B, tasks/get and tasks/update of it are the one -32602 an id never
// issued gets, and B's answer is never taken; A's own answer runs it again
// to completion. (The record's own session check is server-free:
// test/questions/08-task-asks.js.)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const handshake = require('../../lib/session-transport/handshake');
const shim = require('../session-transport/helpers/shim');
// (one copy: the runtime's listening tell, null if it exited first)
const {listening} = require('./helpers/per-session');

const ROOT = path.join(__dirname, '..', '..');
const FRAMEWORK = path.join(ROOT, 'framework.js');
const V = '2026-07-28';
const EXT = 'io.modelcontextprotocol/tasks';
// the tasks extension, and form elicitation: a task it makes may ask
const MODERN = {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {extensions: {[EXT]: {}}, elicitation: {form: {}}}};
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 30000) => {
  const end = Date.now() + ms;
  while (!(await test()) && Date.now() < end) await tick(100);
  return test();
};

// a scenario (the single-identity profile lists scenarios) whose long-running
// action asks its user first, from inside its task
function scenario(home) {
  const dir = path.join(home, 'pack', 'ch-session-ask');
  const svc = 'askService';
  fs.mkdirSync(path.join(dir, 'handlers', svc), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'ch-session-ask', version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'ch-session-ask', manufacturer: 'countinghouse-test', modelDescription: 'a task that asks',
    serviceList: {[`urn:countinghouse-test:serviceID:${svc}`]: {actionList: [{name: 'probe', description: 'asks, then answers', longRunning: true,
      input: {schema: `/${svc}/probe/input`}, output: {schema: `/${svc}/probe/output`},
      questions: {confirm: {message: 'Go on?', schema: `/${svc}/probe/questions/confirm`}}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    [svc]: {probe: {input: {type: 'object'}, output: {type: 'object'},
      questions: {confirm: {type: 'object', properties: {yes: {type: 'boolean', title: 'Yes'}}, required: ['yes']}}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', svc, 'probe.js'), 'module.exports = async (input, ctx) => ({output: {answer: await ctx.ask(\'confirm\', {})}});\n');
  return dir;
}

function runtime(home, extra = []) {
  const run = path.join(home, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  fs.chmodSync(run, 0o700);
  const socket = path.join(run, 's');
  const child = spawn(process.execPath, [FRAMEWORK, '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
    '--sessionSocket', socket, ...extra], {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: ''})});
  const r = {child, socket, run, err: '', out: '', told: []};
  child.on('message', (m) => {
    if (m != null && m.type === 'ready') child.send({id: 'restore-1', type: 'restore', sessions: [], declines: [], reset: []});
    // (what the runtime tells unasked: its 'listening', among others)
    if (m != null && m.id === undefined && m.type !== 'ready') r.told.push(m);
  });
  child.stderr.on('data', (d) => { r.err += d; });
  child.stdout.on('data', (d) => { r.out += d; });
  r.exited = new Promise((res) => child.on('exit', (code, signal) => { r.code = code; res({code, signal}); }));
  child.on('error', () => {});
  return r;
}
const secretOf = (r) => {
  try { return handshake.parseSecret(fs.readFileSync(path.join(r.run, 'secret'), 'utf8')); } catch (e) { return null; }
};
let nextSeq = 1;
async function request(c, method, params, meta) {
  const seq = nextSeq++;
  shim.message(c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method, params: Object.assign({}, meta != null ? {_meta: meta} : {}, params)}));
  for (;;) {
    const m = await shim.readM(c, 60000);
    if (m == null) return null;
    if (m.header != null && m.header.seq === seq) return JSON.parse(m.line.toString('utf8'));
  }
}
const modern = (s, method, params) => request(s.c, method, params, MODERN);
// an answer with its JSON-RPC id and the task id it names taken out, so two can be compared
const shape = (got, id) => JSON.stringify(Object.assign({}, got, {id: null})).split(id).join('<id>');

describe('session-runtime 07: a task\'s question in a shared runtime, spawned (M22)', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return;   // the named pipe is C2's
  let home;
  let r;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr7-')); });
  afterEach(async() => {
    if (r != null && r.child.exitCode === null) { r.child.kill('SIGKILL'); await r.exited; }
    r = null;
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('only the task\'s own session sees and answers its question: to another session it is an id never issued', async() => {
    r = runtime(home, ['--loadModule', scenario(home)]);
    assert.ok(await listening(r) != null, `the runtime is not listening (exit ${r.code}): ${(r.err || '').slice(-1500)}`);
    const secret = secretOf(r);
    const open = async() => { try { return await shim.session(r.socket, secret); } catch (e) { throw new Error(`${e.message}\n${r.err.slice(-2000)}`); } };
    const a = await open();
    const b = await open();
    assert.ok(await until(async() => {
      const list = await modern(a, 'tools/list', {});
      return list != null && list.result != null && list.result.tools.some((t) => t.name === 'probe');
    }), r.err.slice(-1500));

    const made = await modern(a, 'tools/call', {name: 'probe', arguments: {}});
    assert.strictEqual(made.result.resultType, 'task', JSON.stringify(made));
    const tid = made.result.taskId;
    let waiting = null;
    assert.ok(await until(async() => {
      waiting = (await modern(a, 'tasks/get', {taskId: tid})).result;
      return waiting != null && waiting.status === 'input_required';
    }), `${JSON.stringify(waiting)}\n${r.err.slice(-1500)}`);
    const key = Object.keys(waiting.inputRequests)[0];
    const never = `t-${'0'.repeat(32)}`;
    // B's get and update of A's task, the whole answer, against B's for an id never issued
    for (const [method, extra] of [['tasks/get', {}], ['tasks/update', {inputResponses: {[key]: {action: 'accept', content: {yes: false}}}}]]) {
      const fromB = await modern(b, method, Object.assign({taskId: tid}, extra));
      const unknown = await modern(b, method, Object.assign({taskId: never}, extra));
      assert.strictEqual(fromB.error && fromB.error.code, -32602, `${method}: ${JSON.stringify(fromB)}`);
      assert.strictEqual(shape(fromB, tid), shape(unknown, never), method);
    }
    // B's answer was never taken: A's task still waits on the same key
    const still = (await modern(a, 'tasks/get', {taskId: tid})).result;
    assert.deepStrictEqual([still.status, Object.keys(still.inputRequests)], ['input_required', [key]]);
    // A answers its own: the run again completes with that answer
    const acked = await modern(a, 'tasks/update', {taskId: tid, inputResponses: {[key]: {action: 'accept', content: {yes: true}}}});
    assert.strictEqual(acked.result && acked.result.resultType, 'complete', JSON.stringify(acked));
    let done = null;
    assert.ok(await until(async() => {
      done = (await modern(a, 'tasks/get', {taskId: tid})).result;
      return done != null && done.status === 'completed';
    }), JSON.stringify(done));
    assert.deepStrictEqual(done.result.structuredContent, {answer: {yes: true}});
    a.c.end();
    b.c.end();
  });
});

'use strict';
// MCP completeness M15, spec section 9: the tasks extension for 2026-07-28
// clients, over HTTP (a spawned server, --workerThread --store local, two
// synthetic keys). A modern tools/call becomes a task only when the action
// declares longRunning, the request's _meta declares the extension, and jobs
// can run; its taskId is minted (128 random bits), never the runner's own.
// tasks/get, tasks/update and tasks/cancel are the owner's: another key's
// task, an unknown one and a malformed id get one -32602 that echoes no id.
// A tasks/* request that does not declare the extension is -32021. A
// cancelled task reads `cancelled` from a tombstone, to its owner only. The
// legacy era is unchanged.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {withoutRedisNoise} = require('../helpers/stdio-client');

const PORT = testPort(9637);
const KEY_A = `test-a-${'a'.repeat(24)}`;
const KEY_B = `test-b-${'b'.repeat(24)}`;
const V = '2026-07-28';
const EXT = 'io.modelcontextprotocol/tasks';
const tool = (a) => `m15_tasks_taskservice_${a}`;
const NAME_PARAM = {'tools/call': 'name', 'tasks/get': 'taskId', 'tasks/update': 'taskId', 'tasks/cancel': 'taskId'};

// a 2026-07-28 request over HTTP, its headers matching its body; ext: whether
// its _meta declares the tasks extension
function modern(key, method, params = {}, {ext = true, headers = {}} = {}) {
  const meta = {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': ext ? {extensions: {[EXT]: {}}} : {}};
  const body = {jsonrpc: '2.0', id: 1, method, params: Object.assign({_meta: meta}, params)};
  let r = request(`http://127.0.0.1:${PORT}`).post('/mcp').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream')
    .set('X-CH-Key', key).set('MCP-Protocol-Version', V).set('Mcp-Method', method);
  const named = NAME_PARAM[method];
  if (named != null && typeof(params[named]) === 'string' && headers['Mcp-Name'] === undefined) r = r.set('Mcp-Name', params[named]);
  for (const [k, v] of Object.entries(headers)) if (v != null) r = r.set(k, v);
  return r.send(body).then((res) => ({status: res.status, body: res.body}));
}
const legacy = (key, method, params) => request(`http://127.0.0.1:${PORT}`).post('/mcp').set('X-CH-Key', key)
  .set('Accept', 'application/json, text/event-stream').send({jsonrpc: '2.0', id: 1, method, params}).then((res) => res.body);

describe('mcp-contract 27: tasks for 2026-07-28 clients (M15)', function() {
  this.timeout(120000);
  let server = null;
  let dir = null;
  const log = () => `\n${withoutRedisNoise((server && server.output) || '', 3000)}`;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-27-'));
    const auth = path.join(dir, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY_A]: {userName: 'a', devices: ['*']}, [KEY_B]: {userName: 'b', devices: ['*']}}));
    server = await startServer(PORT, ['--workerThread', '--store', 'local', '--storePath', path.join(dir, 'store'),
      '--moduleDataPath', path.join(dir, 'module_data'), '--authConfigPath', auth, '--loadModule', path.join(ROOT, 'test', 'fixtures', 'm15-tasks')]);
  });
  after(() => {
    stopServer(server);
    if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
  });

  const created = async (a, args = {}) => {
    const r = await modern(KEY_A, 'tools/call', {name: tool(a), arguments: args});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body) + log());
    return r.body.result;
  };
  const until = async (key, taskId, done) => {
    for (let i = 0; i < 200; i++) {
      const r = await modern(key, 'tasks/get', {taskId});
      if (r.body.result != null && done(r.body.result)) return r.body.result;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`task ${taskId} never got there${log()}`);
  };

  it('discover declares the extension', async () => {
    const r = await modern(KEY_A, 'server/discover');
    assert.deepStrictEqual(r.body.result.capabilities.extensions, {[EXT]: {}}, JSON.stringify(r.body));
  });

  it('a call becomes a task only with longRunning and the extension declared; otherwise it runs inline', async () => {
    const quick = await created('quick');
    assert.strictEqual(quick.resultType, 'complete', 'not long-running: inline');
    const noExt = await modern(KEY_A, 'tools/call', {name: tool('slow'), arguments: {ms: 0}}, {ext: false});
    assert.strictEqual(noExt.body.result.resultType, 'complete', 'the extension not declared: inline');
    assert.deepStrictEqual(noExt.body.result.structuredContent, {done: true});
    const legacyField = await modern(KEY_A, 'tools/call', {name: tool('slow'), arguments: {ms: 0}, task: {}}, {ext: false});
    assert.strictEqual(legacyField.body.result.resultType, 'complete', 'a legacy params.task on a modern request is ignored');
  });

  it('a task is answered once its job exists, with a minted 128-bit taskId; get shows it working, then completed with its result', async () => {
    const t = await created('slow', {ms: 400});
    assert.strictEqual(t.resultType, 'task', JSON.stringify(t));
    assert.match(t.taskId, /^t-[0-9a-f]{32}$/);
    assert.strictEqual(t.status, 'working');
    assert.strictEqual(t.pollIntervalMs, 2000);
    assert.ok(Number.isInteger(t.ttlMs) && t.ttlMs > 0, 'under --store local: the job timeout and the result retention');
    assert.ok(!Number.isNaN(Date.parse(t.createdAt)) && !Number.isNaN(Date.parse(t.lastUpdatedAt)));
    const working = await modern(KEY_A, 'tasks/get', {taskId: t.taskId});
    assert.strictEqual(working.body.result.status, 'working');
    const done = await until(KEY_A, t.taskId, (x) => x.status !== 'working');
    assert.strictEqual(done.status, 'completed', JSON.stringify(done));
    assert.deepStrictEqual(done.result.structuredContent, {done: true});
    assert.notStrictEqual(done.result.isError, true);
  });

  it('a completed task\'s result is shaped for the 2026-07-28 era: a non-object output keeps its structuredContent', async () => {
    const t = await created('scalar');
    const done = await until(KEY_A, t.taskId, (x) => x.status !== 'working');
    assert.strictEqual(done.status, 'completed', JSON.stringify(done));
    assert.strictEqual(done.result.structuredContent, 'a bare string');
  });

  it('a failed task inlines its error: its code kept, its text (the module\'s own words) cut and cleaned', async () => {
    const t = await created('fails');
    const done = await until(KEY_A, t.taskId, (x) => x.status !== 'working');
    assert.strictEqual(done.status, 'failed', JSON.stringify(done));
    assert.strictEqual(done.error.code, -32603);
    assert.match(done.error.message, /it failed. here. and there and on/, 'the module\'s words, cleaned');
    assert.ok(!/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(done.error.message), JSON.stringify(done.error.message));
    assert.ok(done.error.message.length <= 512, `cut: ${done.error.message.length}`);
    assert.strictEqual(done.error.data['countinghouse/code'], 'M15_FAILED', 'its code kept');
  });

  it('a failed task whose code is over 64 characters keeps no code: the whole text is the message, cut and cleaned', async () => {
    const t = await created('fails', {code: `M15_${'X'.repeat(100)}`});
    const done = await until(KEY_A, t.taskId, (x) => x.status !== 'working');
    assert.strictEqual(done.status, 'failed', JSON.stringify(done));
    assert.strictEqual(done.error.data, undefined, JSON.stringify(done.error));
    assert.ok(done.error.message.length <= 512, `cut: ${done.error.message.length}`);
  });

  it('another key\'s task, an unknown id and a malformed one get one -32602, which echoes no id, for get, update and cancel', async () => {
    const t = await created('slow', {ms: 300});
    const answers = [];
    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
      for (const [key, taskId] of [[KEY_B, t.taskId], [KEY_A, `t-${'0'.repeat(32)}`], [KEY_A, 'not-a-task'], [KEY_A, '1']]) {
        const r = await modern(key, method, {taskId});
        assert.ok(r.body.error != null, `${method} ${taskId}: ${JSON.stringify(r.body)}`);
        assert.ok(!JSON.stringify(r.body.error).includes(taskId), 'no id echoed');
        answers.push(JSON.stringify(r.body.error));
      }
    }
    assert.strictEqual(new Set(answers).size, 1, [...new Set(answers)].join(' / '));
    assert.strictEqual(JSON.parse(answers[0]).code, -32602);
    assert.strictEqual((await modern(KEY_A, 'tasks/get', {taskId: t.taskId})).body.result.taskId, t.taskId, 'the owner still has it');
  });

  it('update acknowledges the owner\'s task; cancel removes it, and get then reads cancelled to its owner only', async () => {
    const t = await created('slow', {ms: 3000});
    const updated = await modern(KEY_A, 'tasks/update', {taskId: t.taskId, inputResponses: {}});
    assert.deepStrictEqual(Object.keys(updated.body.result).filter((k) => k !== '_meta' && k !== 'resultType'), [], JSON.stringify(updated.body));
    const cancelled = await modern(KEY_A, 'tasks/cancel', {taskId: t.taskId});
    assert.ok(cancelled.body.result != null, JSON.stringify(cancelled.body));
    const after = await modern(KEY_A, 'tasks/get', {taskId: t.taskId});
    assert.strictEqual(after.body.result && after.body.result.status, 'cancelled', JSON.stringify(after.body));
    const foreign = await modern(KEY_B, 'tasks/get', {taskId: t.taskId});
    assert.strictEqual(foreign.body.error && foreign.body.error.code, -32602, 'another key learns nothing of the tombstone');
  });

  it('a tasks/* request that does not declare the extension is -32021, naming it', async () => {
    const t = await created('slow', {ms: 0});
    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
      const r = await modern(KEY_A, method, {taskId: t.taskId}, {ext: false});
      assert.strictEqual(r.body.error && r.body.error.code, -32021, `${method}: ${JSON.stringify(r.body)}`);
      assert.deepStrictEqual(r.body.error.data.requiredCapabilities, {extensions: {[EXT]: {}}});
    }
  });

  it('Mcp-Name is the taskId for the three methods', async () => {
    const t = await created('slow', {ms: 0});
    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
      const wrong = await modern(KEY_A, method, {taskId: t.taskId}, {headers: {'Mcp-Name': 't-other'}});
      assert.deepStrictEqual([wrong.status, wrong.body.error && wrong.body.error.code], [400, -32020], method);
    }
  });

  it('tasks/result and tasks/list stay unknown to a modern request', async () => {
    for (const method of ['tasks/result', 'tasks/list']) {
      const r = await modern(KEY_A, method, {taskId: 't-x'});
      assert.strictEqual(r.body.error && r.body.error.code, -32601, method);
    }
  });

  it('the legacy era: a failed task\'s statusMessage is its code and the module\'s words, cut and cleaned', async () => {
    const made = await legacy(KEY_A, 'tools/call', {name: tool('fails'), arguments: {}, task: {}});
    assert.ok(made.result != null && made.result.task != null, JSON.stringify(made));
    let got = null;
    for (let i = 0; i < 200; i++) {
      got = (await legacy(KEY_A, 'tasks/get', {taskId: made.result.task.taskId})).result;
      if (got.status !== 'working') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.strictEqual(got.status, 'failed', JSON.stringify(got));
    assert.match(got.statusMessage, /^M15_FAILED: .*it failed. here. and there and on/, JSON.stringify(got.statusMessage).slice(0, 200));
    assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(got.statusMessage), JSON.stringify(got.statusMessage));
    assert.ok(got.statusMessage.length <= 512, `cut: ${got.statusMessage.length}`);
  });

  it('the legacy era is unchanged: params.task, the runner\'s id, tasks/get and tasks/result', async () => {
    const made = await legacy(KEY_A, 'tools/call', {name: tool('slow'), arguments: {ms: 0}, task: {}});
    assert.ok(made.result && made.result.task, JSON.stringify(made));
    assert.match(made.result.task.taskId, /^\d+$/, 'the runner\'s own id');
    let status = null;
    for (let i = 0; i < 100 && status !== 'completed'; i++) {
      status = (await legacy(KEY_A, 'tasks/get', {taskId: made.result.task.taskId})).result.status;
      if (status !== 'completed') await new Promise((res) => setTimeout(res, 50));
    }
    assert.strictEqual(status, 'completed');
    assert.deepStrictEqual((await legacy(KEY_A, 'tasks/result', {taskId: made.result.task.taskId})).result.structuredContent, {done: true});
  });
});

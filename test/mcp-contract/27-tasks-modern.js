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
const {testPort, redisUrlFor} = require('../helpers/test-env');
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
function modern(key, method, params = {}, {ext = true, headers = {}, port = PORT} = {}) {
  const meta = {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': ext ? {extensions: {[EXT]: {}}} : {}};
  const body = {jsonrpc: '2.0', id: 1, method, params: Object.assign({_meta: meta}, params)};
  let r = request(`http://127.0.0.1:${port}`).post('/mcp').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream')
    .set('X-CH-Key', key).set('MCP-Protocol-Version', V).set('Mcp-Method', method);
  const named = NAME_PARAM[method];
  if (named != null && typeof(params[named]) === 'string' && headers['Mcp-Name'] === undefined) r = r.set('Mcp-Name', params[named]);
  for (const [k, v] of Object.entries(headers)) if (v != null) r = r.set(k, v);
  return r.send(body).then((res) => ({status: res.status, body: res.body}));
}
const modernOn = (port, key, method, params) => modern(key, method, params, {port});
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
    server = await startServer(PORT, ['--workerThread', '--store', 'local', '--storePath', path.join(dir, 'store'), '--jobTimeout', '5',
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

  // spec section 9 (the review of #329): `completed` inlines the CallToolResult
  // a synchronous call would have returned, an isError result included;
  // `failed` is only for a run that left no result
  it('a task whose handler fails is completed with the isError result: its code kept, its text (the module\'s own words) cut and cleaned', async () => {
    const t = await created('fails');
    const done = await until(KEY_A, t.taskId, (x) => x.status !== 'working');
    assert.strictEqual(done.status, 'completed', JSON.stringify(done));
    assert.strictEqual(done.error, undefined);
    assert.strictEqual(done.result.isError, true, JSON.stringify(done.result));
    assert.strictEqual(done.result._meta['countinghouse/code'], 'M15_FAILED', 'its code kept');
    const text = done.result.content[0].text;
    assert.match(text, /it failed. here. and there and on/, 'the module\'s words, cleaned');
    assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(text), JSON.stringify(text));
    assert.ok(text.length <= 512, `cut: ${text.length}`);
  });

  it('a handler\'s error whose code is over 64 characters keeps no code: the whole text is the result\'s, cut and cleaned', async () => {
    const t = await created('fails', {code: `M15_${'X'.repeat(100)}`});
    const done = await until(KEY_A, t.taskId, (x) => x.status !== 'working');
    assert.strictEqual(done.status, 'completed', JSON.stringify(done));
    assert.strictEqual(done.result.isError, true);
    assert.strictEqual(done.result._meta, undefined, JSON.stringify(done.result));
    assert.ok(done.result.content[0].text.length <= 512, `cut: ${done.result.content[0].text.length}`);
  });

  it('a run that left no result (past --jobTimeout) is failed, with its error', async () => {
    const t = await created('slow', {ms: 8000});
    const done = await until(KEY_A, t.taskId, (x) => x.status !== 'working');
    assert.strictEqual(done.status, 'failed', JSON.stringify(done));
    assert.strictEqual(done.statusMessage, 'failed', 'M16 D3: its code, or "failed" for none');
    assert.strictEqual(done.result, undefined);
    // l.891: a failed task carries the JSON-RPC error. The runner's timeout
    // has no code of its own, so it carries no data. (Its statusMessage, a
    // SHOULD, is M16 Task 1's.)
    assert.deepStrictEqual(Object.keys(done.error).sort(), ['code', 'message'], JSON.stringify(done.error));
    assert.strictEqual(done.error.code, -32603);
    assert.match(done.error.message, /^Promise timed out after 5000 milliseconds$/);
  });

  // M16 Task 1, D3: a working task's statusMessage is its last
  // ctx.job.progress as "NN%" (rounded); nothing for a value that isn't a
  // positive number, and nothing once it has completed
  it('a working task\'s statusMessage is its progress, "NN%"; none once completed', async () => {
    const t = await created('progress', {values: [42.4], holdMs: 1500});
    const working = await until(KEY_A, t.taskId, (x) => x.status !== 'working' || x.statusMessage != null);
    assert.strictEqual(working.status, 'working', JSON.stringify(working));
    assert.strictEqual(working.statusMessage, '42%');
    const done = await until(KEY_A, t.taskId, (x) => x.status !== 'working');
    assert.strictEqual(done.status, 'completed', JSON.stringify(done));
    assert.strictEqual(done.statusMessage, undefined);
  });

  // (ctx.job.progress drops anything but a number from 0 to 100 in the
  // worker; the gateway's own check is the second guard for the record)
  it('a progress that isn\'t a number from 1 to 100 gives no statusMessage: "half", {}, 0, -5, 150', async () => {
    for (const v of ['half', {}, 0, -5, 150]) {
      const t = await created('progress', {values: [v], holdMs: 600});
      const seen = new Set();
      const done = await until(KEY_A, t.taskId, (x) => { seen.add(x.statusMessage); return x.status !== 'working'; });
      assert.strictEqual(done.status, 'completed', JSON.stringify(done));
      assert.deepStrictEqual([...seen], [undefined], `${JSON.stringify(v)}: ${JSON.stringify([...seen])}`);
    }
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
    const again = await modern(KEY_A, 'tasks/cancel', {taskId: t.taskId});
    assert.ok(again.body.result != null, `cancelled twice: acknowledged twice ${JSON.stringify(again.body)}`);
    // the run was already in a worker: it goes on to its end (cooperative),
    // and is still read cancelled after it, with no result (the review of #329)
    await new Promise((res) => setTimeout(res, 3500));
    const ended = await modern(KEY_A, 'tasks/get', {taskId: t.taskId});
    assert.strictEqual(ended.body.result && ended.body.result.status, 'cancelled', JSON.stringify(ended.body));
    assert.strictEqual(ended.body.result.result, undefined, 'no result');
  });

  // ext-tasks 2026-07-28 has no terminal-status rule for tasks/cancel: a known
  // task is acknowledged, and a finished one is left as it is (the Reviewer's
  // ruling on #329): no job removed, no tombstone, its status and result kept
  it('cancel on a finished task is acknowledged and changes nothing: get still reads it completed, with its result', async () => {
    const t = await created('slow', {ms: 0});
    await until(KEY_A, t.taskId, (x) => x.status === 'completed');
    for (let n = 0; n < 2; n++) {
      const r = await modern(KEY_A, 'tasks/cancel', {taskId: t.taskId});
      assert.ok(r.body.result != null, `cancel ${n + 1}: ${JSON.stringify(r.body)}`);
    }
    const got = await modern(KEY_A, 'tasks/get', {taskId: t.taskId});
    assert.strictEqual(got.body.result.status, 'completed', JSON.stringify(got.body));
    assert.deepStrictEqual(got.body.result.result.structuredContent, {done: true});
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
    // and its tasks/result: the isError result, its code kept, its text cut
    // and cleaned as a 2026-07-28 task's is (the review of #329)
    const result = (await legacy(KEY_A, 'tasks/result', {taskId: made.result.task.taskId})).result;
    assert.strictEqual(result.isError, true, JSON.stringify(result).slice(0, 300));
    assert.strictEqual(result._meta['countinghouse/code'], 'M15_FAILED');
    const text = result.content[0].text;
    assert.match(text, /it failed. here. and there and on/);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202A-\u202E\u2066-\u2069]/.test(text), JSON.stringify(text));
    assert.ok(text.length <= 512, `cut: ${text.length}`);
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
    // a 2026-07-28 task is the extension's: never in the legacy list
    const listed = (await legacy(KEY_A, 'tasks/list', {})).result.tasks.map((x) => x.taskId);
    assert.ok(listed.includes(made.result.task.taskId), JSON.stringify(listed));
    assert.ok(!listed.some((id) => /^t-/.test(id)), JSON.stringify(listed));
  });
});

// The review of #329: under --store redis a finished job is kept, while a
// tombstone lasted an hour. A task cancelled while it ran went on to its end
// and, once the tombstone went, read completed with its result. Its tombstone
// now lasts as long as the job is kept: no expiry under Redis (a mark on the
// job would not hold: the runner writes its own copy of the data back).
describe('mcp-contract 27: a task cancelled while it runs, under --store redis', function() {
  this.timeout(120000);
  const RPORT = testPort(9639);
  let server = null;
  let dir = null;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-27r-'));
    const auth = path.join(dir, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY_A]: {userName: 'a', devices: ['*']}}));
    server = await startServer(RPORT, ['--workerThread', '--moduleDataPath', path.join(dir, 'module_data'), '--authConfigPath', auth,
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'm15-tasks')]);
  });
  after(() => {
    stopServer(server);
    if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
  });

  it('stays cancelled, with no result, after its run ends: its tombstone lasts as long as its job', async () => {
    const on = (method, params) => modernOn(RPORT, KEY_A, method, params);
    const made = await on('tools/call', {name: tool('slow'), arguments: {ms: 1500}});
    const taskId = made.body.result && made.body.result.taskId;
    assert.match(String(taskId), /^t-/, JSON.stringify(made.body));
    await new Promise((res) => setTimeout(res, 400));   // in a worker now
    assert.ok((await on('tasks/cancel', {taskId})).body.result != null);
    // the store's kv (Redis db 5): the tombstone never expires while the job is kept
    const kv = require('redis').createClient(redisUrlFor(), {db: 5});
    try {
      const pttl = await new Promise((res, rej) => kv.pttl(`task-tombstone:${taskId}`, (e, n) => (e ? rej(e) : res(n))));
      assert.strictEqual(pttl, -1, `no expiry (PTTL ${pttl})`);
    } finally {
      kv.quit();
    }
    await new Promise((res) => setTimeout(res, 2000));   // past its run's end: the job is kept, completed
    const got = await on('tasks/get', {taskId});
    assert.strictEqual(got.body.result && got.body.result.status, 'cancelled', JSON.stringify(got.body));
    assert.strictEqual(got.body.result.result, undefined, 'no result');
  });
});

// ext-tasks (tasks.md l.157-158, l.835-837): `failed` only for a request
// that fails with a JSON-RPC error, never for a tool result with isError,
// which is `completed`. So a task's status mirrors how the same tools/call is
// answered inline. The module unloaded, reloaded or suspended under a call
// is answered inline with an isError result; a task meeting the same event
// is completed with that result, its code kept (before: failed). A second
// server, --debug for the module routes; the inline call is the same
// long-running tool without the extension declared.
describe('mcp-contract 27: a task\'s status mirrors the inline answer, the module gone under it', function() {
  this.timeout(120000);
  const DPORT = testPort(9660);
  const KEY_D = `test-d-${'d'.repeat(24)}`;
  const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'm15-tasks');
  const {post, waitFor} = require('../helpers/sandbox-server');
  const {toolErrorCode} = require('../helpers/tool-result');
  let server = null;
  let dir = null;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-27d-'));
    server = await startServer(DPORT, ['--debug', '--debugKey', KEY_D, '--workerThread', '--store', 'local', '--storePath', path.join(dir, 'store'),
      '--jobTimeout', '30', '--moduleDataPath', path.join(dir, 'module_data'), '--loadModule', FIXTURE]);
  });
  after(() => {
    stopServer(server);
    if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
  });
  const on = (method, params, opts = {}) => modern(KEY_D, method, params, Object.assign({port: DPORT}, opts));
  // a tools/call answered inline (the extension not declared)
  const inline = (a, args = {}) => on('tools/call', {name: tool(a), arguments: args}, {ext: false}).then((r) => r.body);
  const answerOf = (result) => ({isError: result.isError === true, code: toolErrorCode(result)});
  const up = () => waitFor(async () => (await inline('quick')).result.isError !== true, 20000, 'm15-tasks to answer');
  const settled = async (taskId) => waitFor(async () => {
    const got = (await on('tasks/get', {taskId})).body.result;
    return (got != null && got.status !== 'working') ? got : null;
  }, 20000, `task ${taskId} to settle`);
  // an inline call and a task, both in flight when `event` happens: the
  // inline answer, and the task as it settled
  async function bothUnder(event) {
    const call = inline('slow', {ms: 8000});
    const made = (await on('tools/call', {name: tool('slow'), arguments: {ms: 8000}})).body.result;
    assert.match(String(made && made.taskId), /^t-/, JSON.stringify(made));
    await new Promise((r) => setTimeout(r, 600));   // both running in the worker
    await event();
    return {inlineBody: await call, task: await settled(made.taskId)};
  }
  // the mirror: an inline isError result (no JSON-RPC error) is a completed
  // task with the same result
  function mirrors({inlineBody, task}, code) {
    assert.strictEqual(inlineBody.error, undefined, `inline: a result, not a JSON-RPC error: ${JSON.stringify(inlineBody)}`);
    assert.deepStrictEqual(answerOf(inlineBody.result), {isError: true, code}, JSON.stringify(inlineBody.result));
    assert.strictEqual(task.status, 'completed', JSON.stringify(task));
    assert.strictEqual(task.error, undefined);
    assert.deepStrictEqual(answerOf(task.result), answerOf(inlineBody.result), JSON.stringify(task.result));
  }

  it('unloaded under it: inline an isError MODULE_UNLOADED, the task completed with the same', async () => {
    await up();
    const both = await bothUnder(async () => assert.strictEqual((await post(DPORT, KEY_D, '/unload-module', {name: 'm15-tasks'})).status, 200));
    mirrors(both, 'MODULE_UNLOADED');
    await post(DPORT, KEY_D, '/load-module', {path: FIXTURE, name: 'm15-tasks'});
  });

  it('reloaded under it: inline an isError MODULE_RELOADING, the task completed with the same', async () => {
    await up();
    const both = await bothUnder(() => post(DPORT, KEY_D, '/load-module', {path: FIXTURE, name: 'm15-tasks'}));
    mirrors(both, 'MODULE_RELOADING');
  });

  it('suspended (three exits): inline an isError MODULE_SUSPENDED, a task run then completed with the same', async () => {
    // three crashes in the supervisor's window, each once the restart is up
    for (let i = 0; i < 3; i++) {
      await up();
      await inline('exit');
      // down (restarting, or suspended on the third): never the dying worker's answer
      await waitFor(async () => (await inline('quick')).result.isError === true, 20000, `exit ${i + 1} seen`);
    }
    const inlineBody = await waitFor(async () => {
      const b = await inline('slow', {ms: 0});
      return (b.result != null && toolErrorCode(b.result) === 'MODULE_SUSPENDED') ? b : null;
    }, 20000, 'the module to be suspended');
    const made = (await on('tools/call', {name: tool('slow'), arguments: {ms: 0}})).body.result;
    assert.match(String(made && made.taskId), /^t-/, JSON.stringify(made));
    mirrors({inlineBody, task: await settled(made.taskId)}, 'MODULE_SUSPENDED');
  });
});

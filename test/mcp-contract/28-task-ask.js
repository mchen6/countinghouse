'use strict';
// MCP completeness M22 (spec sections 8 and 9, ext-tasks 2026-07-28): a
// module's question asked from inside a task. The handler runs again, as on
// a call (M13): the pass that asks ends, the task reads input_required with
// one form in inputRequests, the client answers by tasks/update, and the
// run is retried under the same taskId with the answer. State is held on the
// server (the task-ask record), bound to the task's owner and session.
//
// The task is its job (jobId = taskId); tasks/update finds it as tasks/get
// does (findModernTask: the caller's own, in its session); a cancel leaves
// M15's tombstone and takes the question with it. Three runtimes: the local
// store's job runner, the same with --jobResultTtl 0, and the Redis store
// (BullMQ, whose run again is a retry of the completed job under its id).
// Server free: test/questions/08-task-asks.js (the record's compare-and-set,
// rounds, expiry, caps, session hash, the local runner's billing).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {withoutRedisNoise} = require('../helpers/stdio-client');

const V = '2026-07-28';
const EXT = 'io.modelcontextprotocol/tasks';
const KEY_A = `test-a-${'a'.repeat(24)}`;
const KEY_B = `test-b-${'b'.repeat(24)}`;
// its balance is read by the billing case alone
const KEY_C = `test-c-${'c'.repeat(24)}`;
const TOOL = 'm22_task_ask_askservice_probe';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'm22-task-ask');
const NAME_PARAM = {'tools/call': 'name', 'tasks/get': 'taskId', 'tasks/update': 'taskId', 'tasks/cancel': 'taskId'};
const WAITING = 'waiting for an answer';

// a 2026-07-28 request over HTTP; forms: whether its _meta declares form
// elicitation beside the tasks extension
function client(port) {
  return function modern(key, method, params = {}, {forms = true} = {}) {
    const caps = Object.assign({extensions: {[EXT]: {}}}, forms ? {elicitation: {form: {}}} : {});
    const body = {jsonrpc: '2.0', id: 1, method, params: Object.assign({_meta: {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': caps}}, params)};
    let r = request(`http://127.0.0.1:${port}`).post('/mcp').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream')
      .set('X-CH-Key', key).set('MCP-Protocol-Version', V).set('Mcp-Method', method);
    const named = NAME_PARAM[method];
    if (named != null && typeof(params[named]) === 'string') r = r.set('Mcp-Name', params[named]);
    return r.send(body).then((res) => ({status: res.status, body: res.body}));
  };
}

// a key's balance (--meter, each call billed --mcpToolCallCost 1)
function balanceOf(port, key) {
  return request(`http://127.0.0.1:${port}`).get('/balance').set('X-CH-Key', key).then((res) => res.body.balance);
}

// store: 'local' (the local job runner) or 'redis' (BullMQ, and the record's
// take as a script on Redis)
function suite(title, {port, extra = [], store = 'local'}) {
  describe(title, function() {
    this.timeout(120000);
    const modern = client(port);
    let server = null;
    let dir = null;
    const log = () => `\n${withoutRedisNoise((server && server.output) || '', 3000)}`;
    before(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-28-'));
      const auth = path.join(dir, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[KEY_A]: {userName: 'a', devices: ['*']}, [KEY_B]: {userName: 'b', devices: ['*']}, [KEY_C]: {userName: 'c', devices: ['*']}}));
      const stored = store === 'local' ? ['--store', 'local', '--storePath', path.join(dir, 'store')] : [];
      server = await startServer(port, ['--workerThread', ...stored, '--meter', '--mcpToolCallCost', '1',
        '--moduleDataPath', path.join(dir, 'module_data'), '--authConfigPath', auth, '--loadModule', FIXTURE, ...extra]);
      // the server answers before its module has loaded: wait for its tool
      let listed = null;
      for (let i = 0; i < 300; i++) {
        listed = await modern(KEY_A, 'tools/list', {});
        if (listed.body.result != null && listed.body.result.tools.some((t) => t.name === TOOL)) return;
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error(`${TOOL} never listed: ${JSON.stringify(listed && listed.body).slice(0, 1500)}${log()}`);
    });
    after(() => {
      stopServer(server);
      if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
    });

    const task = async (args, opts) => {
      const r = await modern(KEY_A, 'tools/call', {name: TOOL, arguments: Object.assign({what: 'it'}, args)}, opts);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body) + log());
      assert.strictEqual((r.body.result || {}).resultType, 'task', JSON.stringify(r.body) + log());
      return r.body.result.taskId;
    };
    const get = async (taskId, key = KEY_A) => (await modern(key, 'tasks/get', {taskId})).body;
    const until = async (taskId, want) => {
      for (let i = 0; i < 200; i++) {
        const b = await get(taskId);
        if (b.result != null && want(b.result)) return b.result;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error(`task ${taskId} never got there: ${JSON.stringify(await get(taskId))}${log()}`);
    };
    const asking = (taskId) => until(taskId, (t) => t.status === 'input_required');
    const settled = (taskId) => until(taskId, (t) => t.status !== 'working' && t.status !== 'input_required');
    const update = async (taskId, responses, key = KEY_A) => (await modern(key, 'tasks/update', {taskId, inputResponses: responses})).body;
    // a result without its _meta (serverInfo rides on every 2026-07-28 result)
    const ack = (b) => { const r = Object.assign({}, b.result); delete r._meta; return r; };
    const onlyKey = (t) => { const keys = Object.keys(t.inputRequests); assert.strictEqual(keys.length, 1, JSON.stringify(t)); return keys[0]; };

    it('the pass that asks leaves the task input_required with one form: the declared text, the question\'s schema, a fixed statusMessage', async () => {
      const id = await task({what: 'the thing'});
      const t = await asking(id);
      const key = onlyKey(t);
      const req = t.inputRequests[key];
      assert.strictEqual(req.method, 'elicitation/create');
      assert.strictEqual(req.params.mode, 'form');
      assert.match(req.params.message, /^m22-task-ask: Do the thing\?$/);
      assert.strictEqual(req.params.requestedSchema.type, 'object');
      assert.ok(req.params.requestedSchema.properties.yes != null);
      assert.strictEqual(t.statusMessage, WAITING);
      // asked again before an answer: the same request, the same key (ext-tasks' snapshot)
      assert.deepStrictEqual((await asking(id)).inputRequests, t.inputRequests);
    });

    it('accept: an empty acknowledgement, then the run again under the same taskId, completed with the answer', async () => {
      const id = await task();
      const key = onlyKey(await asking(id));
      assert.deepStrictEqual(ack(await update(id, {[key]: {action: 'accept', content: {yes: true}}})), {resultType: 'complete'});
      const done = await settled(id);
      assert.strictEqual(done.status, 'completed', JSON.stringify(done));
      assert.strictEqual(done.taskId, id);
      assert.deepStrictEqual(done.result.structuredContent.answer, {yes: true});
      assert.strictEqual(done.result.structuredContent.asked, true);
    });

    it('decline and cancel: the handler is given null', async () => {
      for (const action of ['decline', 'cancel']) {
        const id = await task();
        const key = onlyKey(await asking(id));
        await update(id, {[key]: {action}});
        const done = await settled(id);
        assert.strictEqual(done.result.structuredContent.answer, null, action);
      }
    });

    it('content its schema refuses: the same question again under a new key, the old key no longer outstanding', async () => {
      const id = await task();
      const first = onlyKey(await asking(id));
      await update(id, {[first]: {action: 'accept', content: {yes: 'not a boolean'}}});
      const again = await until(id, (t) => t.status === 'input_required' && onlyKey(t) !== first);
      const second = onlyKey(again);
      assert.notStrictEqual(second, first, 'keys are unique over the task\'s life');
      // the old key is ignored: the task waits on the new one
      await update(id, {[first]: {action: 'accept', content: {yes: true}}});
      assert.strictEqual(onlyKey(await asking(id)), second);
      await update(id, {[second]: {action: 'accept', content: {yes: false}}});
      assert.deepStrictEqual((await settled(id)).result.structuredContent.answer, {yes: false});
    });

    it('three rounds with no answer: the run again, and ctx.ask is ASK_UNAVAILABLE', async () => {
      const id = await task();
      let seen = null;
      for (let round = 0; round < 3; round++) {
        const t = await until(id, (x) => x.status === 'input_required' && onlyKey(x) !== seen);
        seen = onlyKey(t);
        await update(id, {[seen]: {action: 'accept', content: {}}});
      }
      const done = await settled(id);
      assert.deepStrictEqual([done.result.structuredContent.asked, done.result.structuredContent.code], [false, 'ASK_UNAVAILABLE'], JSON.stringify(done));
    });

    it('keys never issued, already answered or stale are ignored with the same empty acknowledgement; the task is unchanged', async () => {
      const id = await task();
      const key = onlyKey(await asking(id));
      for (const k of ['q-never-issued', `${key}-x`]) {
        assert.deepStrictEqual(ack(await update(id, {[k]: {action: 'accept', content: {yes: true}}})), {resultType: 'complete'});
      }
      assert.strictEqual(onlyKey(await asking(id)), key);
      await update(id, {[key]: {action: 'accept', content: {yes: true}}});
      // the same answer again: already answered, ignored
      assert.deepStrictEqual(ack(await update(id, {[key]: {action: 'accept', content: {yes: false}}})), {resultType: 'complete'});
      assert.deepStrictEqual((await settled(id)).result.structuredContent.answer, {yes: true});
    });

    it('two updates raced on one key: exactly one is taken, and the run happens once', async () => {
      const id = await task();
      const key = onlyKey(await asking(id));
      await Promise.all([update(id, {[key]: {action: 'accept', content: {yes: true}}}), update(id, {[key]: {action: 'accept', content: {yes: false}}})]);
      const done = await settled(id);
      assert.strictEqual(done.status, 'completed');
      assert.ok([true, false].includes(done.result.structuredContent.answer.yes));
    });

    it('another key\'s task: get and update are the one -32602, and its answer is never taken [A]', async () => {
      const id = await task();
      const key = onlyKey(await asking(id));
      assert.strictEqual((await get(id, KEY_B)).error.code, -32602);
      assert.strictEqual((await update(id, {[key]: {action: 'accept', content: {yes: true}}}, KEY_B)).error.code, -32602);
      assert.strictEqual(onlyKey(await asking(id)), key, 'still waiting on its own owner');
    });

    // F2-5: capabilities are per request: the form goes only to a poll that declared form elicitation
    it('a poll that did not declare form elicitation gets input_required with no form in it, and is told why; one that did gets the form', async () => {
      const id = await task();
      const key = onlyKey(await asking(id));
      const bare = (await modern(KEY_A, 'tasks/get', {taskId: id}, {forms: false})).body.result;
      assert.strictEqual(bare.status, 'input_required', JSON.stringify(bare));
      assert.deepStrictEqual(bare.inputRequests, {}, 'no form for it');
      assert.match(bare.statusMessage, /form elicitation declared/);
      assert.deepStrictEqual(Object.keys((await get(id)).result.inputRequests), [key], 'the form, to a poll that can show it');
      await update(id, {[key]: {action: 'accept', content: {yes: true}}});
      await settled(id);
    });

    it('an answer from a request that did not declare form elicitation is refused (-32021, naming it), and the task still waits; one that did is taken (F2-5)', async () => {
      const id = await task();
      const key = onlyKey(await asking(id));
      const answer = {[key]: {action: 'accept', content: {yes: true}}};
      const refusedUpdate = (await modern(KEY_A, 'tasks/update', {taskId: id, inputResponses: answer}, {forms: false})).body;
      assert.strictEqual(refusedUpdate.error && refusedUpdate.error.code, -32021, JSON.stringify(refusedUpdate));
      assert.match(refusedUpdate.error.message, /declare form elicitation/);
      assert.deepStrictEqual(refusedUpdate.error.data, {requiredCapabilities: {elicitation: {form: {}}}});
      // refused alike for a task that does not exist: it says nothing of one
      const unknown = (await modern(KEY_A, 'tasks/update', {taskId: 'no-such-task', inputResponses: answer}, {forms: false})).body;
      assert.deepStrictEqual(unknown.error, refusedUpdate.error);
      // an update with no answers is acknowledged as before, form or not
      assert.deepStrictEqual(ack((await modern(KEY_A, 'tasks/update', {taskId: id, inputResponses: {}}, {forms: false})).body), {resultType: 'complete'});
      assert.strictEqual((await get(id)).result.status, 'input_required', 'still waiting');
      assert.deepStrictEqual(ack(await update(id, {[key]: {action: 'accept', content: {yes: true}}})), {resultType: 'complete'});
      await settled(id);
    });

    it('a task made by a request that did not declare form elicitation is never input_required: ctx.ask is ASK_UNAVAILABLE', async () => {
      const id = await task({}, {forms: false});
      const done = await settled(id);
      assert.deepStrictEqual([done.status, done.result.structuredContent.code], ['completed', 'ASK_UNAVAILABLE'], JSON.stringify(done));
    });

    it('cancel while input_required: cancelled, a late answer ignored, nothing runs again [A]', async () => {
      const id = await task();
      const key = onlyKey(await asking(id));
      assert.deepStrictEqual(ack((await modern(KEY_A, 'tasks/cancel', {taskId: id})).body), {resultType: 'complete'});
      assert.strictEqual((await get(id)).result.status, 'cancelled');
      assert.deepStrictEqual(ack(await update(id, {[key]: {action: 'accept', content: {yes: true}}})), {resultType: 'complete'});
      await new Promise((res) => setTimeout(res, 500));
      assert.strictEqual((await get(id)).result.status, 'cancelled');
    });

    it('a cancel racing the answer always wins: the retried run, if it started, is never read', async () => {
      const id = await task({afterMs: 1500});
      const key = onlyKey(await asking(id));
      await update(id, {[key]: {action: 'accept', content: {yes: true}}});
      // the answered pass is running (afterMs holds it) when the cancel comes
      await new Promise((res) => setTimeout(res, 300));
      await modern(KEY_A, 'tasks/cancel', {taskId: id});
      await new Promise((res) => setTimeout(res, 2000));
      const t = (await get(id)).result;
      assert.strictEqual(t.status, 'cancelled', JSON.stringify(t));
      assert.ok(t.result === undefined, 'a cancelled task carries no result');
    });

    it('billing: the pass that asks is not billed, a refused answer runs nothing, and the answered pass is billed once', async () => {
      const r = await modern(KEY_C, 'tools/call', {name: TOOL, arguments: {what: 'it'}});
      const id = r.body.result.taskId;
      const getC = async () => (await modern(KEY_C, 'tasks/get', {taskId: id})).body.result;
      const untilC = async (want) => {
        for (let i = 0; i < 200; i++) {
          const t = await getC();
          if (t != null && want(t)) return t;
          await new Promise((res) => setTimeout(res, 50));
        }
        throw new Error(`task ${id}: ${JSON.stringify(await getC())}${log()}`);
      };
      const first = onlyKey(await untilC((t) => t.status === 'input_required'));
      const before = await balanceOf(port, KEY_C);
      await modern(KEY_C, 'tasks/update', {taskId: id, inputResponses: {[first]: {action: 'accept', content: {yes: 'no'}}}});
      const second = onlyKey(await untilC((t) => t.status === 'input_required' && onlyKey(t) !== first));
      assert.strictEqual(await balanceOf(port, KEY_C), before, 'nothing billed for asking, nor for a refused answer');
      await modern(KEY_C, 'tasks/update', {taskId: id, inputResponses: {[second]: {action: 'accept', content: {yes: true}}}});
      const done = await untilC((t) => t.status === 'completed');
      assert.deepStrictEqual(done.result.structuredContent.answer, {yes: true});
      for (let i = 0; i < 100 && (await balanceOf(port, KEY_C)) === before; i++) await new Promise((res) => setTimeout(res, 50));
      await new Promise((res) => setTimeout(res, 300));
      assert.strictEqual(await balanceOf(port, KEY_C), before - 1, 'the answered pass, billed once');
    });

    it('a module\'s ctx.redis never reaches a task\'s question: it reads nothing of the record, and its write leaves it as it was', async () => {
      const id = await task();
      const key = onlyKey(await asking(id));
      const peek = await modern(KEY_A, 'tools/call', {name: TOOL.replace(/probe$/, 'peek'), arguments: {key: `task-ask:${id}`}});
      assert.deepStrictEqual(peek.body.result.structuredContent, {seen: null, wrote: true}, JSON.stringify(peek.body));
      // the record as it was: the same key waits, and its answer is taken
      assert.strictEqual(onlyKey(await asking(id)), key);
      assert.deepStrictEqual(ack(await update(id, {'q-forged': {action: 'accept', content: {yes: false}}})), {resultType: 'complete'});
      await update(id, {[key]: {action: 'accept', content: {yes: true}}});
      assert.deepStrictEqual((await settled(id)).result.structuredContent.answer, {yes: true});
    });
  });
}

suite('mcp-contract 28: a question from inside a task (M22)', {port: testPort(9690)});
// --store local forgets a finished job --jobResultTtl after it finished: a
// task waiting on its question keeps its job, or is run again fresh under
// the same id once answered
suite('mcp-contract 28: a question from inside a task, with --jobResultTtl 0 (M22)', {port: testPort(9691), extra: ['--jobResultTtl', '0']});
// the Redis store: BullMQ runs the task, and its run again is a retry of the
// completed job under the same id
suite('mcp-contract 28: a question from inside a task, on the Redis store (M22)', {port: testPort(9692), store: 'redis'});

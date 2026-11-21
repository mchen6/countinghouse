'use strict';
// MCP completeness M18, the final security pass (b): identity never reaches
// a module through the newer surfaces either (spec section 11). A resource
// read (M7) runs module code as a call does: its handler gets the same
// ctx.caller as a call ({id, isAdmin}, the same id for the same key), and
// nothing it can reach (ctx, globalThis, every loaded file's exports) holds
// an API key, a user name or the Redis URL. Over a 2026-07-28 request and a
// legacy one. So does a task's run after its answer (M22: the runtime starts
// it again from the record it held its question in), and a completion action
// (M11), which answers what it found as values. (test/auth/30 checks calls,
// tasks and hops; the scan is its.)
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');

const PORT = testPort(9757);
const V = '2026-07-28';
const hex = () => crypto.randomBytes(8).toString('hex');
const ALICE = `alice-key-${hex()}`;
const NAME = `alice-${hex()}`;
const NEEDLES = [ALICE, NAME, 'redis://'];
const reversed = NEEDLES.map((n) => n.split('').reverse().join(''));
const ID_SHAPE = /^u_[A-Za-z0-9_-]{22}$/;
const URI = 'countinghouse://m/key_dump_read/peek';

const post = (body, headers = {}) => {
  let r = request(`http://127.0.0.1:${PORT}`).post('/mcp').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream').set('X-CH-Key', ALICE);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body).then((res) => res.body);
};
const modern = (method, params, name, caps = {}) => post({jsonrpc: '2.0', id: 1, method, params: Object.assign({_meta: {'io.modelcontextprotocol/protocolVersion': V,
  'io.modelcontextprotocol/clientCapabilities': caps}}, params)}, Object.assign({'MCP-Protocol-Version': V, 'Mcp-Method': method}, name != null ? {'Mcp-Name': name} : {}));
// a client that runs tasks and answers forms
const TASKS = {extensions: {'io.modelcontextprotocol/tasks': {}}, elicitation: {form: {}}};
const legacy = (method, params) => post({jsonrpc: '2.0', id: 1, method, params});

function assertClean(view, label) {
  assert.strictEqual(view.budgetExhausted, false, `${label}: the walk ran out of budget, so it proves nothing`);
  assert.strictEqual(view.hitCount, 0, `${label}: ${view.hitCount} found: ${JSON.stringify(view.hits)}`);
  assert.deepStrictEqual(Object.keys(view.caller || {}).sort(), ['id', 'isAdmin'], `${label}: ctx.caller is ${JSON.stringify(view.caller)}`);
  assert.match(view.caller.id, ID_SHAPE);
  assert.strictEqual(view.caller.isAdmin, false);
}

describe('auth 53: no API key, user name or Redis URL reaches a resource read\'s, an answered task\'s or a completion action\'s module code (M18)', function() {
  this.timeout(120000);
  let base = null;
  let server = null;
  before(async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-key-dump-read-'));
    const auth = path.join(base, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[ALICE]: {userName: NAME, devices: ['*']}}), {mode: 0o600});
    // what the read's handler searches for, reversed, in its own data
    const data = path.join(base, 'store', 'key-dump-read', 'data');
    fs.mkdirSync(data, {recursive: true});
    fs.writeFileSync(path.join(data, 'needles.json'), JSON.stringify(reversed));
    server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', auth, '--moduleDataPath', path.join(base, 'store'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'key-dump-read')]);
    for (let i = 0; i < 300; i++) {
      const listed = await legacy('tools/list', {});
      if (listed.result != null && listed.result.tools.some((t) => /readservice_who$/.test(t.name))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the module never listed');
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  // what a plain call sees: {caller, ctxKeys}
  const whoCalled = async () => {
    const name = (await legacy('tools/list', {})).result.tools.find((t) => /readservice_who$/.test(t.name)).name;
    return (await modern('tools/call', {name, arguments: {}}, name)).result.structuredContent;
  };

  const readView = (got) => {
    assert.ok(got.result != null && Array.isArray(got.result.contents), JSON.stringify(got).slice(0, 600));
    return JSON.parse(got.result.contents[0].text);
  };

  it('a 2026-07-28 resources/read: nothing found, and the caller a call sees', async () => {
    const view = readView(await modern('resources/read', {uri: URI}, URI));
    assertClean(view, 'a modern read');
    const who = await whoCalled();
    assert.deepStrictEqual(view.caller, who.caller, 'a read and a call see the same caller');
    assert.deepStrictEqual(view.ctxKeys, who.ctxKeys, 'and the same ctx');
  });

  it('a legacy resources/read: nothing found', async () => {
    assertClean(readView(await legacy('resources/read', {uri: URI})), 'a legacy read');
  });


  it('a task\'s run after its answer (M22): nothing found, and the caller a call sees', async () => {
    const name = (await legacy('tools/list', {})).result.tools.find((t) => /readservice_askthenpeek$/.test(t.name)).name;
    const made = await modern('tools/call', {name, arguments: {}}, name, TASKS);
    assert.strictEqual((made.result || {}).resultType, 'task', JSON.stringify(made).slice(0, 600));
    const taskId = made.result.taskId;
    const until = async (want) => {
      for (let i = 0; i < 300; i++) {
        const got = await modern('tasks/get', {taskId}, taskId, TASKS);
        if (got.result != null && want(got.result)) return got.result;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`task ${taskId} never got there: ${JSON.stringify(await modern('tasks/get', {taskId}, taskId, TASKS)).slice(0, 600)}`);
    };
    const asking = await until((t) => t.status === 'input_required');
    const key = Object.keys(asking.inputRequests)[0];
    await modern('tasks/update', {taskId, inputResponses: {[key]: {action: 'accept', content: {yes: true}}}}, taskId, TASKS);
    const done = await until((t) => t.status !== 'working' && t.status !== 'input_required');
    assert.strictEqual(done.status, 'completed', JSON.stringify(done).slice(0, 600));
    const view = done.result.structuredContent;
    assert.deepStrictEqual(view.answer, {yes: true}, 'the run after the answer');
    assertClean(view, 'a task\'s run after its answer');
    const who = await whoCalled();
    assert.deepStrictEqual(view.caller, who.caller, 'a task and a call see the same caller');
    assert.deepStrictEqual(view.ctxKeys, who.ctxKeys, 'and the same ctx');
  });

  it('a completion action (M11): nothing found, and the caller a call sees', async () => {
    const got = await modern('completion/complete', {ref: {type: 'ref/prompt', name: 'key_dump_read_pick'}, argument: {name: 'thing', value: ''}});
    assert.ok(got.result != null && got.result.completion != null, JSON.stringify(got).slice(0, 600));
    const values = Object.fromEntries(got.result.completion.values.map((v) => [v.slice(0, v.indexOf(':')), v.slice(v.indexOf(':') + 1)]));
    // the action answered (not the schema's fallback, which has none)
    assert.deepStrictEqual(Object.keys(values).sort(), ['admin', 'budget', 'callerKeys', 'ctxKeys', 'first', 'hits', 'id'], JSON.stringify(got.result));
    assert.strictEqual(values.budget, 'false', `the walk ran out of budget, so it proves nothing: ${JSON.stringify(values)}`);
    assert.strictEqual(values.hits, '0', `found: ${values.first}`);
    assert.strictEqual(values.callerKeys, 'id,isAdmin', JSON.stringify(values));
    assert.match(values.id, ID_SHAPE);
    assert.strictEqual(values.admin, 'false');
    const who = await whoCalled();
    assert.strictEqual(values.id, who.caller.id, 'a completion action and a call see the same caller');
    assert.strictEqual(values.ctxKeys, who.ctxKeys.join(','), 'and the same ctx');
  });
});

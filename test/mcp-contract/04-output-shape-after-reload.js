// The output shape a result is sent in follows the module as it is loaded
// now: after a reload that changes an action's output schema, tools/list and
// tools/call both use the new schema. A task's result is stamped at
// completion with a hash of the output schema it was produced under, and
// tasks/result sends structuredContent only while the advertised schema
// still has that hash -- otherwise text only, even when the old result
// would happen to validate against the new schema. No module schema is
// compiled on the main thread to decide it.
//
// Each task here finishes before the reload that follows it; the ordering
// is never forced the other way, because the stamp is taken from whatever
// is loaded at completion, so a task that completed after a reload is
// simply stamped with the new schema.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const net     = require('net');
const spawn   = require('child_process').spawn;
const request = require('supertest');
const waitForReady = require('../helpers/wait-for-ready');

const ROOT    = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'reload-output-schema');
const KEY     = 'reload-output-schema-key';
const TOOL    = 'reload_output_schema_greetservice_hello';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
  });
}

function mcp(port, method, params) {
  return request(`http://127.0.0.1:${port}`).post('/mcp')
    .set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream').set('X-CH-Key', KEY)
    .send({jsonrpc: '2.0', id: Date.now(), method, params}).then((res) => res.body);
}

const V1_SCHEMA  = fs.readFileSync(path.join(FIXTURE, 'schema.json'), 'utf8');
const V1_HANDLER = fs.readFileSync(path.join(FIXTURE, 'handlers', 'greetService', 'hello.js'), 'utf8');
function writeV1(dir) {
  fs.writeFileSync(path.join(dir, 'schema.json'), V1_SCHEMA);
  fs.writeFileSync(path.join(dir, 'handlers', 'greetService', 'hello.js'), V1_HANDLER);
}

// v3: v1 plus an optional field. A v1 result still validates against it,
// but it is not the schema the result was produced under.
function writeV3(dir) {
  writeV1(dir);
  const schemaFile = path.join(dir, 'schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  schema.greetService.hello.output.properties.lang = {type: 'string'};
  fs.writeFileSync(schemaFile, JSON.stringify(schema, null, 2));
}

// v2: a different, strict output, so a v1 result cannot pass for it.
function writeV2(dir) {
  const schemaFile = path.join(dir, 'schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  schema.greetService.hello.output = {type: 'object', properties: {upper: {type: 'string'}}, required: ['upper'], additionalProperties: false};
  fs.writeFileSync(schemaFile, JSON.stringify(schema, null, 2));
  fs.writeFileSync(path.join(dir, 'handlers', 'greetService', 'hello.js'), "module.exports = async () => ({output: {upper: 'V2'}});\n");
}

async function load(port, dir) {
  const body = await mcp(port, 'tools/call', {name: 'countinghouse_load_module',
    arguments: {path: dir, name: 'reload-output-schema', version: '1.0.0'}});
  assert.strictEqual(body.result.isError, false, `load_module failed: ${JSON.stringify(body.result)}`);
}

// The device can be briefly absent while a reload replaces it.
async function callUntil(port, predicate) {
  const deadline = Date.now() + 20000;
  let last = null;
  while (Date.now() < deadline) {
    const body = await mcp(port, 'tools/call', {name: TOOL, arguments: {}});
    last = body.result || body.error;
    if (body.result != null && body.result.isError === false && predicate(body.result)) return body.result;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no matching answer after reload, last: ${JSON.stringify(last)}`);
}

async function finishedTask(port) {
  const created = await mcp(port, 'tools/call', {name: TOOL, arguments: {}, task: {}});
  const taskId = created.result.task.taskId;
  for (let i = 0; i < 100; i++) {
    const got = await mcp(port, 'tasks/get', {taskId});
    if (got.result && got.result.status === 'completed') return taskId;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`task ${taskId} never completed`);
}

describe('mcp-contract 04: the result shape follows the module after a reload', function() {
  this.timeout(120000);

  let tmp, port, server, v1TaskId, v2TaskId;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-reload-output-schema-'));
    fs.cpSync(FIXTURE, tmp, {recursive: true});
    port = await freePort();
    await new Promise((resolve, reject) => {
      server = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--debug', '--debugKey', KEY,
        '--authoringTools', '--bindAddr', '127.0.0.1', '--port', String(port)],
      {cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], detached: true});
      server.output = '';
      server.stdout.on('data', (c) => { server.output += c.toString(); });
      waitForReady(server, (err) => (err ? reject(err) : resolve()));
    });
    await load(port, tmp);
    await callUntil(port, () => true);
  });

  after(() => {
    if (server != null && server.pid != null) { try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
    if (tmp != null) fs.rmSync(tmp, {recursive: true, force: true});
  });

  // The positive control for the stale-task case below: if the task record
  // ever stopped carrying the device, service and action main-side, this
  // would go text-only here and fail loudly, instead of the stale case
  // passing for the wrong reason.
  it('a task on v1, read on v1, comes back as v1 structuredContent', async () => {
    v1TaskId = await finishedTask(port);
    const res = await mcp(port, 'tasks/result', {taskId: v1TaskId});
    assert.deepStrictEqual(res.result.structuredContent, {text: 'v1'});
  });

  it('tools/list and tools/call follow the reloaded schema', async () => {
    writeV2(tmp);
    await load(port, tmp);
    const r = await callUntil(port, (res) => res.structuredContent != null && res.structuredContent.upper === 'V2');
    assert.deepStrictEqual(r.structuredContent, {upper: 'V2'});
    const list = await mcp(port, 'tools/list', {});
    const tool = list.result.tools.find((t) => t.name === TOOL);
    assert.deepStrictEqual(Object.keys(tool.outputSchema.properties), ['upper']);
  });

  it('a task finished before the reload reads back text-only when its result no longer conforms', async () => {
    const res = await mcp(port, 'tasks/result', {taskId: v1TaskId});
    assert.strictEqual(res.result.isError, false);
    assert.strictEqual(res.result.structuredContent, undefined);
    assert.deepStrictEqual(JSON.parse(res.result.content[0].text), {text: 'v1'});
  });

  it('a task finished on v2, read after a reload back to v1, is text-only', async () => {
    v2TaskId = await finishedTask(port);
    writeV1(tmp);
    await load(port, tmp);
    await callUntil(port, (res) => res.structuredContent != null && res.structuredContent.text === 'v1');
    const res = await mcp(port, 'tasks/result', {taskId: v2TaskId});
    assert.strictEqual(res.result.isError, false);
    assert.strictEqual(res.result.structuredContent, undefined);
    assert.deepStrictEqual(JSON.parse(res.result.content[0].text), {upper: 'V2'});
  });

  it('reloading the same v1 schema keeps a v1 task as structuredContent', async () => {
    const res = await mcp(port, 'tasks/result', {taskId: v1TaskId});
    assert.deepStrictEqual(res.result.structuredContent, {text: 'v1'});
    await load(port, tmp);
    await callUntil(port, (r) => r.structuredContent != null && r.structuredContent.text === 'v1');
    const again = await mcp(port, 'tasks/result', {taskId: v1TaskId});
    assert.deepStrictEqual(again.result.structuredContent, {text: 'v1'});
  });

  it('a compatible schema change still sends a v1 task text-only: the schema it was produced under is gone', async () => {
    writeV3(tmp);
    await load(port, tmp);
    const list = async () => (await mcp(port, 'tools/list', {})).result.tools.find((t) => t.name === TOOL);
    const deadline = Date.now() + 20000;
    while (!('lang' in ((await list()) || {outputSchema: {properties: {}}}).outputSchema.properties) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const res = await mcp(port, 'tasks/result', {taskId: v1TaskId});
    assert.strictEqual(res.result.isError, false);
    assert.strictEqual(res.result.structuredContent, undefined, JSON.stringify(res.result));
    assert.deepStrictEqual(JSON.parse(res.result.content[0].text), {text: 'v1'});
  });
});

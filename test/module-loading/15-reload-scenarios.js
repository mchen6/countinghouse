// Reload scenarios that already behave as the operator expects (the table in
// the 2026-11-07 fixes ledger, rows c, h, k). The ones that do not yet --
// work in flight when a worker ends, the reload window -- are pinned by their
// own tests alongside their fixes. Already covered elsewhere: d (a stored
// task result after a reload, mcp-contract/04), g (peer channels across a
// restart, direct-peer-channels/02; a reload takes the same unload-and-spawn
// path), j (a reload during a supervised restart or suspension, sandbox/07).
//
// Not under --debug: a scheduler's ownership is part of what survives (h),
// and --debug makes every key an admin.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');
const {testPort} = require('../helpers/test-env');

const PORT    = testPort(9606);
const URL     = `http://127.0.0.1:${PORT}`;
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'reload-output-schema');
const TOOL    = 'reload_output_schema_greetservice_hello';
const BYE     = 'reload_output_schema_greetservice_bye';
const DEVICE  = deviceIDForName('reload-output-schema');
const SERVICE = 'urn:countinghouse-test:serviceID:greetService';

const ADMIN = 'reload-15-admin-key';
const OWNER = 'reload-15-owner-key';
const OTHER = 'reload-15-other-key';

const V1_SCHEMA  = fs.readFileSync(path.join(FIXTURE, 'schema.json'), 'utf8');
const V1_API     = fs.readFileSync(path.join(FIXTURE, 'api.json'), 'utf8');
const V1_HANDLER = fs.readFileSync(path.join(FIXTURE, 'handlers', 'greetService', 'hello.js'), 'utf8');

function writeV1(dir) {
  fs.writeFileSync(path.join(dir, 'schema.json'), V1_SCHEMA);
  fs.writeFileSync(path.join(dir, 'api.json'), V1_API);
  fs.writeFileSync(path.join(dir, 'handlers', 'greetService', 'hello.js'), V1_HANDLER);
  fs.rmSync(path.join(dir, 'handlers', 'greetService', 'bye.js'), {force: true});
}

// v2: hello returns {upper: 'V2'} under a strict schema of its own.
function writeV2(dir) {
  writeV1(dir);
  const schema = JSON.parse(V1_SCHEMA);
  schema.greetService.hello.output = {type: 'object', properties: {upper: {type: 'string'}}, required: ['upper'], additionalProperties: false};
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(schema, null, 2));
  fs.writeFileSync(path.join(dir, 'handlers', 'greetService', 'hello.js'), "module.exports = async () => ({output: {upper: 'V2'}});\n");
}

// v3: v1 plus a second action, bye.
function writeV3(dir) {
  writeV1(dir);
  const api = JSON.parse(V1_API);
  const actions = api.device.serviceList[SERVICE].actionList;
  actions.push(Object.assign(JSON.parse(JSON.stringify(actions[0])), {name: 'bye', description: 'Says goodbye.',
    input: {schema: '/greetService/bye/input'}, output: {schema: '/greetService/bye/output'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify(api, null, 2));
  const schema = JSON.parse(V1_SCHEMA);
  schema.greetService.bye = JSON.parse(JSON.stringify(schema.greetService.hello));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(schema, null, 2));
  fs.writeFileSync(path.join(dir, 'handlers', 'greetService', 'bye.js'), "module.exports = async () => ({output: {text: 'bye'}});\n");
}

const mcp = (key, method, params) => request(URL).post('/mcp').set('Content-Type', 'application/json')
  .set('Accept', 'application/json, text/event-stream').set('X-CH-Key', key)
  .send({jsonrpc: '2.0', id: Date.now(), method, params}).then((res) => res.body);
const http = (key, route, body) => request(URL).post(`/devices/${DEVICE}/${route}`).set('X-CH-Key', key).send(body)
  .then((res) => ({status: res.status, body: res.body}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms) {
  const deadline = Date.now() + (ms || 20000);
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last.ok) return last.value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last && last.value)}`);
}

async function load(dir) {
  const body = await mcp(ADMIN, 'tools/call', {name: 'countinghouse_load_module',
    arguments: {path: dir, name: 'reload-output-schema', version: '1.0.0'}});
  assert.strictEqual(body.result && body.result.isError, false, `load_module failed: ${JSON.stringify(body)}`);
}

// A reload has taken effect once a call answers from the new code.
const answers = (want) => until(`hello to answer ${JSON.stringify(want)}`, async () => {
  const b = await mcp(OWNER, 'tools/call', {name: TOOL, arguments: {}});
  const sc = b.result != null ? b.result.structuredContent : null;
  return {ok: sc != null && JSON.stringify(sc) === JSON.stringify(want), value: b};
});

const toolNames = async () => (await mcp(OWNER, 'tools/list', {})).result.tools.map((t) => t.name)
  .filter((n) => n.startsWith('reload_output_schema_')).sort();

describe('module-loading 15: reload scenarios that already hold', function() {
  this.timeout(180000);
  let base = null;
  let tmp = null;
  let server = null;

  before(async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-reload-15-'));
    tmp = path.join(base, 'module');
    fs.cpSync(FIXTURE, tmp, {recursive: true});
    const authPath = path.join(base, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({
      [ADMIN]: {userName: 'admin', devices: ['*'], admin: true},
      [OWNER]: {userName: 'owner', devices: ['*']},
      [OTHER]: {userName: 'other', devices: ['*']}
    }));
    server = await startServer(PORT, ['--workerThread', '--authoringTools', '--authProvider', 'file', '--authConfigPath', authPath,
      '--moduleDataPath', path.join(base, 'store')]);
    await load(tmp);
    await answers({text: 'v1'});
  });

  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('c: a delayed task created on v1 and run after a reload to v2 runs on v2, with v2\'s shape', async () => {
    const added = await http(OWNER, 'add-job', {serviceID: SERVICE, actionName: 'hello', input: {},
      opts: {name: 'reload-15-delayed', delay: 10000}});
    assert.strictEqual(added.status, 200, JSON.stringify(added));
    const jobId = added.body.id;
    writeV2(tmp);
    await load(tmp);
    await answers({upper: 'V2'});
    const reloadedAt = Date.now();
    const done = await until('the delayed job to complete', async () => {
      const r = await http(OWNER, 'get-job', {id: jobId});
      return {ok: r.body != null && (r.body.state === 'completed' || r.body.state === 'failed'), value: r.body};
    }, 30000);
    // The ordering is checked, not assumed from the delay: a slow reload
    // under load would otherwise read as the scenario failing.
    assert.ok(done.job.processedOn >= reloadedAt,
      `the reload finished after the job ran (processedOn ${done.job.processedOn} < reloaded ${reloadedAt}): the test did not set up scenario c`);
    assert.strictEqual(done.state, 'completed', JSON.stringify(done));
    assert.deepStrictEqual(done.job.returnvalue, {output: {upper: 'V2'}});
    const res = await mcp(OWNER, 'tasks/result', {taskId: String(jobId)});
    assert.deepStrictEqual(res.result.structuredContent, {upper: 'V2'}, JSON.stringify(res));
  });

  it('h: a scheduler survives a reload: its next run is on the new module, and it is still its owner\'s alone', async () => {
    writeV1(tmp);
    await load(tmp);
    await answers({text: 'v1'});
    const name = 'reload-15-scheduler';
    const added = await http(OWNER, 'add-job', {serviceID: SERVICE, actionName: 'hello', input: {},
      opts: {name: name, repeat: {every: 1500, limit: 20}}});
    assert.strictEqual(added.status, 200, JSON.stringify(added));
    // A run is matched by when it started, not by how many have gone by.
    const completed = async (want, after) => until(`a scheduled run after ${after} returning ${JSON.stringify(want)}`, async () => {
      const r = await http(OWNER, 'get-job-history', {name: name});
      const hit = (Array.isArray(r.body) ? r.body : []).find((e) => e.state === 'completed' && e.job.processedOn > after &&
        JSON.stringify(e.job.returnvalue) === JSON.stringify({output: want}));
      return {ok: hit != null, value: r.body};
    }, 30000);
    await completed({text: 'v1'}, 0);
    writeV2(tmp);
    await load(tmp);
    await answers({upper: 'V2'});
    const reloadedAt = Date.now();
    await completed({upper: 'V2'}, reloadedAt);
    const others = await http(OTHER, 'get-job-history', {name: name});
    assert.deepStrictEqual(Array.isArray(others.body) ? others.body : [], [], JSON.stringify(others.body).slice(0, 300));
    const removed = await http(OWNER, 'remove-job', {name: name, isRepeat: true});
    assert.strictEqual(removed.status, 200, JSON.stringify(removed));
  });

  it('k: tools/list after a reload lists exactly the new actions', async () => {
    writeV3(tmp);
    await load(tmp);
    await until('bye to appear', async () => { const n = await toolNames(); return {ok: n.includes(BYE), value: n}; });
    assert.deepStrictEqual(await toolNames(), [BYE, TOOL]);
    writeV1(tmp);
    await load(tmp);
    await until('bye to go', async () => { const n = await toolNames(); return {ok: !n.includes(BYE), value: n}; });
    assert.deepStrictEqual(await toolNames(), [TOOL]);
  });
});

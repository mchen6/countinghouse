'use strict';

// LM1 B5, Task 9 (plan 2026-11-11-lm1-store-and-identity.md; spec section
// 1 and "Tests": a local-mode smoke test with no Redis): a server started
// with --store local makes no Redis client and loads no queue library (a
// preloaded trap ends the process if it does), lists and calls a tool, keeps
// a module's ctx.redis data, runs a task to its result, and on SIGTERM
// leaves the data in <storePath>/kv.json. CI runs it on ubuntu, macos and
// windows with no Redis service; C extends it to --stdio.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');

const PORT = 9732;
const KEY = 'local-smoke-key-0001';
const TOOL = 'local_store_probe_probeservice_remember';

function rpc(method, params) {
  return request(`http://127.0.0.1:${PORT}`).post('/mcp').set('X-CH-Key', KEY)
    .set('Accept', 'application/json, text/event-stream')
    .send({jsonrpc: '2.0', id: 1, method: method, params: params}).then((res) => res.body);
}

describe('store 05: --store local with no Redis (LM1 B5)', function() {
  this.timeout(120000);
  let server = null;
  let storePath = null;

  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-store-05-'));
    storePath = path.join(dir, 'store');
    const auth = path.join(dir, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'smoke', devices: ['*']}}));
    server = await startServer(PORT, ['--workerThread', '--store', 'local', '--storePath', storePath,
      '--moduleDataPath', path.join(dir, 'module_data'), '--authConfigPath', auth,
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'local-store-probe')],
      {env: {NODE_OPTIONS: `--require ${path.join(ROOT, 'test', 'helpers', 'no-redis-trap.js')}`}});
  });
  after(() => stopServer(server));

  it('lists and calls the tool, and a module\'s ctx.redis keeps its value', async () => {
    const listed = await rpc('tools/list', {});
    assert.ok(listed.result.tools.some((t) => t.name === TOOL), JSON.stringify(listed).slice(0, 500));
    const r = await mcpCall(PORT, KEY, TOOL, {key: 'k', value: 'kept'});
    assert.deepStrictEqual(toolOutput(r), {value: 'kept'});
  });

  it('runs a task to its result', async () => {
    const created = await rpc('tools/call', {name: TOOL, arguments: {key: 't', value: 'task'}, task: {}});
    const taskId = created.result.task.taskId;
    let status = null;
    for (let i = 0; i < 100 && status !== 'completed'; i++) {
      status = (await rpc('tasks/get', {taskId})).result.status;
      if (status !== 'completed') await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.strictEqual(status, 'completed');
    const res = await rpc('tasks/result', {taskId});
    assert.deepStrictEqual(res.result.structuredContent, {value: 'task'});
  });

  it('made no Redis client and loaded no queue library, and SIGTERM leaves the data in kv.json', async function() {
    assert.ok(!server.output.includes('NO-REDIS-TRAP'), server.output.slice(-2000));
    // a Windows process cannot be sent SIGTERM (it is terminated outright)
    if (process.platform === 'win32') return this.skip();
    // SIGTERM, not stopServer's SIGKILL: the store flushes on a signal
    await new Promise((resolve) => {
      if (server.exitCode != null) return resolve();
      server.once('exit', resolve);
      try { process.kill(-server.pid, 'SIGTERM'); } catch (e) { resolve(); }
    });
    server.output.includes('NO-REDIS-TRAP') && assert.fail(server.output.slice(-2000));
    const kv = JSON.parse(fs.readFileSync(path.join(storePath, 'kv.json'), 'utf8'));
    assert.strictEqual(kv.k.v, 'kept');
  });
});

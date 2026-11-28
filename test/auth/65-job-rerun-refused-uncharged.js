'use strict';
// A billed job's run started again within one run (its question could not
// be shown, so the next pass runs at once) asks for its charge again before
// that pass, on the Redis job runner (BullMQ), as its first pass does (the
// owner's decision, 11-27: a billed call runs only while its charge can be
// recorded). The first pass is let through, then -- while it waits for a go
// file -- the owner's balance is read and found not a number, which marks
// that key; the pass then asks a question no form can show, and the pass that
// would run next is refused LEDGER_RECORD_INVALID before it runs: the task
// fails with that code, and no second pass ran.
const assert  = require('assert');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const request = require('supertest');
const redis   = require('redis');
const {Queue} = require('bullmq');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {prefixFor} = require('../helpers/job-queue');
const {testPort, redisConnectionFor} = require('../helpers/test-env');
const {meterId} = require('../../lib/key-fingerprint');

const PORT    = testPort(9836);
const URL     = `http://127.0.0.1:${PORT}`;
const V       = '2026-07-28';
const EXT     = 'io.modelcontextprotocol/tasks';
const OWNER   = `k${crypto.randomBytes(12).toString('hex')}`;
const TOOL    = 'asks_unusable_askservice_probe';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'asks-unusable');
const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));

// a 2026-07-28 request, declaring the tasks extension and form elicitation
const modern = (method, params, name) => {
  const caps = {extensions: {[EXT]: {}}, elicitation: {form: {}}};
  let r = request(URL).post('/mcp').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream')
    .set('X-CH-Key', OWNER).set('MCP-Protocol-Version', V).set('Mcp-Method', method);
  if (name != null) r = r.set('Mcp-Name', name);
  return r.send({jsonrpc: '2.0', id: 1, method, params: Object.assign({_meta: {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': caps}}, params)})
    .then((res) => ({status: res.status, body: res.body}));
};

describe('auth 65: a job\'s run started again within its run waits for a charge that can be recorded (the Redis job runner)', function() {
  this.timeout(120000);
  const trees = require('../helpers/test-tmp').forFile(['ch-auth-65-']);
  let base = null;
  let data = null;
  let server = null;
  let ledger = null;
  let queue = null;
  let taskId = null;
  const cmd = (name, ...args) => new Promise((resolve, reject) => ledger[name](...args, (e, r) => (e ? reject(e) : resolve(r))));
  const until = async (what, ok, ms = 30000) => {
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) {
      last = await what();
      if (ok(last)) return last;
      await sleep(100);
    }
    throw new Error(`never got there: ${JSON.stringify(last)}\n${((server && server.output) || '').slice(-3000)}`);
  };

  before(async () => {
    base = trees.mkdtemp('ch-auth-65-');
    data = path.join(base, 'module_data', 'asks-unusable', 'data');
    const authPath = path.join(base, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({[OWNER]: {userName: 'owner', devices: ['*']}}), {mode: 0o600});
    ledger = redis.createClient(redisConnectionFor(0));
    ledger.on('error', () => {});
    // (the owner's balance, in the ledger's db, not a number: read, it marks the key)
    await cmd('hset', meterId(OWNER), 'balance', 'abc');
    server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath, '--mcpToolCallCost', '1',
      '--moduleDataPath', path.join(base, 'module_data'), '--loadModule', FIXTURE]);
    await until(() => modern('tools/list', {}), (r) => r.body.result != null && r.body.result.tools.some((t) => t.name === TOOL));
    // (this server's own queue: the task is its job, jobId = taskId)
    queue = new Queue('job-queue', {prefix: prefixFor(path.join(base, 'module_data')), connection: redisConnectionFor(11)});
  });
  after(async () => {
    if (queue != null) {
      if (taskId != null) { const j = await queue.getJob(taskId).catch(() => null); if (j != null) await j.remove().catch(() => {}); }
      await queue.close();
    }
    stopServer(server);
    if (ledger != null) { await cmd('del', meterId(OWNER)).catch(() => {}); ledger.quit(); }
  });

  it('the pass after an unavailable question is refused before it runs: the task failed LEDGER_RECORD_INVALID, one pass only', async () => {
    const started = await modern('tools/call', {name: TOOL, arguments: {}}, TOOL);
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    assert.strictEqual((started.body.result || {}).resultType, 'task', JSON.stringify(started.body));
    taskId = started.body.result.taskId;
    // (the first pass is under way, let through: now the key is marked)
    await until(() => fs.existsSync(path.join(data, 'started')), (x) => x === true);
    const balance = await request(URL).get('/balance').set('X-CH-Key', OWNER);
    assert.strictEqual(balance.body.code, 'LEDGER_RECORD_INVALID', JSON.stringify(balance.body));
    fs.writeFileSync(path.join(data, 'go'), '1');
    const done = await until(() => modern('tasks/get', {taskId}, taskId),
      (r) => r.body.result != null && !['working', 'input_required'].includes(r.body.result.status));
    assert.deepStrictEqual([done.body.result.status, done.body.result.statusMessage], ['failed', 'LEDGER_RECORD_INVALID'], JSON.stringify(done.body));
    // (the first pass ran and ended on its question -- the rerun's gate is
    // what refused, not a first pass's -- and nothing ran after it)
    assert.strictEqual(fs.readFileSync(path.join(data, 'passes'), 'utf8'), 'pass\n', 'a second pass ran');
    assert.strictEqual(fs.readFileSync(path.join(data, 'ask-codes'), 'utf8'), 'ASK_PENDING\n');
    const job = await queue.getJob(taskId);
    assert.ok(job != null, 'the task\'s job');
    assert.deepStrictEqual([await job.getState(), job.attemptsMade], ['failed', 1]);
  });

  trees.hooks();
});

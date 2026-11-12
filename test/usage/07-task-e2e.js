// End to end on a running server (needs Redis for the job queue: CI's
// functional tests). A scenario's direct tools/call and its task-augmented
// tools/call carry the same receipt: _meta['countinghouse/receipt'] and the
// sentence as a second text block, structuredContent the module's output.
// An output with a top-level receipt is refused RECEIPT_RESERVED both ways.
// countinghouse_usage_report counts all of them, from memory and the files.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer, waitFor} = require('../helpers/sandbox-server');

const PORT    = 9740; // C's block, 9740-9749 (test/ports.md)
const KEY     = 'usage-e2e-key';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'usage-scenario');
const OUTPUT  = {summary: 'first line\nsecond line'};

const mcp = (method, params) => request(`http://127.0.0.1:${PORT}`).post('/mcp').set('X-CH-Key', KEY)
  .set('Accept', 'application/json, text/event-stream').send({jsonrpc: '2.0', id: Date.now(), method, params}).then((r) => r.body);

async function taskResult(name) {
  const created = await mcp('tools/call', {name, arguments: {}, task: {}});
  assert.ok(created.result && created.result.task, JSON.stringify(created));
  const taskId = created.result.task.taskId;
  await waitFor(async () => ['completed', 'failed'].includes((await mcp('tasks/get', {taskId})).result.status), 20000, `task ${taskId} to settle`);
  return (await mcp('tasks/result', {taskId})).result;
}

function assertReceipt(result) {
  assert.strictEqual(result.isError, false, JSON.stringify(result));
  assert.deepStrictEqual(result.structuredContent, OUTPUT);
  assert.strictEqual(result.content.length, 2);
  assert.deepStrictEqual(JSON.parse(result.content[0].text), OUTPUT);
  const text = JSON.stringify(OUTPUT);
  assert.deepStrictEqual(result._meta['countinghouse/receipt'], {calls: 0, linesIn: 0, bytesIn: 0, linesOut: 1, bytesOut: Buffer.byteLength(text), servers: []});
  assert.strictEqual(result.content[1].text, `no server was called; 1 line (${Buffer.byteLength(text)} B) reached the model.`);
}

describe('usage 07: the receipt on a running server, direct and task-augmented', function() {
  this.timeout(120000);
  let server, usageDir;

  before(async () => {
    usageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-e2e-'));
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--usageDir', usageDir, '--loadModule', FIXTURE]);
    await waitFor(async () => {
      const listed = await mcp('tools/list', {});
      return listed.result != null && listed.result.tools.some((t) => t.name === 'usage_probe');
    }, 30000, 'the scenario to be listed');
  });
  after(() => {
    stopServer(server);
    fs.rmSync(usageDir, {recursive: true, force: true});
  });

  it('a direct call carries the receipt', async () => {
    assertReceipt((await mcp('tools/call', {name: 'usage_probe', arguments: {}})).result);
  });

  it('a task-augmented call carries the same receipt in tasks/result', async () => {
    assertReceipt(await taskResult('usage_probe'));
  });

  it('a top-level receipt in the output is refused RECEIPT_RESERVED, direct and as a task', async () => {
    for (const result of [(await mcp('tools/call', {name: 'usage_reserved', arguments: {}})).result, await taskResult('usage_reserved')]) {
      assert.strictEqual(result.isError, true, JSON.stringify(result));
      assert.strictEqual(result._meta['countinghouse/code'], 'RECEIPT_RESERVED');
      assert.strictEqual(result.content.length, 1);
    }
  });

  it('the usage report counts every call, the task runs included, and the files hold them', async () => {
    const report = (await mcp('tools/call', {name: 'countinghouse_usage_report', arguments: {groupBy: 'tool'}})).result;
    assert.strictEqual(report.isError, false, JSON.stringify(report));
    const byTool = Object.fromEntries(report.structuredContent.groups.map((g) => [g.tool, g]));
    assert.strictEqual(byTool.usage_probe.calls, 2);
    assert.strictEqual(byTool.usage_reserved.calls, 2);
    assert.ok(report.structuredContent.source.includes('memory'));
    const lines = fs.readdirSync(usageDir).flatMap((day) => fs.readdirSync(path.join(usageDir, day))
      .flatMap((f) => fs.readFileSync(path.join(usageDir, day, f), 'utf8').split('\n').filter(Boolean)));
    const outs = lines.map((l) => JSON.parse(l)).filter((r) => r.bytesOut !== undefined);
    assert.deepStrictEqual(outs.map((r) => [r.tool, r.outcome]).sort(), [['usage_probe', 'ok'], ['usage_probe', 'ok'], ['usage_reserved', 'error'], ['usage_reserved', 'error']]);
    assert.ok(!lines.some((l) => l.includes(KEY)), 'no key in a usage file');
  });
});

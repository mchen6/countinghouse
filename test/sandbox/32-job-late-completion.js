// A job that outlasts its timeout has been failed by bullmq, and may already
// be running again as a retry. Its late answer is then not a completion: it
// is not billed, the completion hook does not stamp the job, and nothing is
// written back over the retry's data. And the retry owns the job in the
// worker on its own: when the first attempt's handler finally returns, the
// retry's progress reports are still accepted. Before, the late answer was
// billed and stamped as if the job had completed, and the first attempt's
// return erased the retry's in-flight entry, so its progress was refused.
const assert = require('assert');
const path   = require('path');
const request = require('supertest');
const {Queue} = require('bullmq');
const {ROOT, startServer, stopServer, post, waitFor} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');

const PORT    = 9643;
const URL     = `http://127.0.0.1:${PORT}`;
const KEY     = `late-completion-${process.pid}`;
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'worker-end');
const DEVICE  = deviceIDForName('worker-end');
const SERVICE = 'urn:countinghouse-test:serviceID:endService';
const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));

const addLate = (opts, input) => post(PORT, KEY, `/devices/${DEVICE}/add-job`, {serviceID: SERVICE, actionName: 'late', input: input,
  opts: Object.assign({name: `late-${Date.now()}`}, opts)});
const jobState = async (id) => (await post(PORT, KEY, `/devices/${DEVICE}/get-job`, {id})).body;
const balance = () => request(URL).post('/mcp').set('X-CH-Key', KEY).set('Accept', 'application/json, text/event-stream')
  .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'countinghouse_check_balance', arguments: {}}})
  .then((r) => r.body.result.structuredContent.balance || 0);
const failed = (id) => waitFor(async () => { const b = await jobState(id); return b.state === 'failed' ? b : null; }, 15000, 'the job to time out');

describe('sandbox 32: a job\'s late answer, after its timeout', function() {
  this.timeout(90000);
  let server = null;
  let queue = null;
  before(async () => {
    // Every completion costs 1, so a billed late answer is visible.
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--mcpToolCallCost', '1', '--loadModule', FIXTURE]);
    await waitFor(async () => (await post(PORT, KEY, `/devices/${DEVICE}/invoke-action`, {serviceID: SERVICE, actionName: 'ping', input: {}})).status === 200,
      20000, 'worker-end to answer');
    queue = new Queue('job-queue', {prefix: '{cdifJob}', connection: {db: 11, host: '127.0.0.1', port: 6379}});
  });
  after(async () => {
    await queue.close();
    stopServer(server);
  });

  it('with one attempt: the late answer is not billed and the job is not stamped', async () => {
    const before = await balance();
    const added = await addLate({timeout: 2000, attempts: 1}, {ms: 6000});
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));
    const job = await failed(added.body.id);
    assert.match(job.job.failedReason, /timed out after 2000 milliseconds/);
    await sleep(6500);   // the handler has answered by now
    assert.strictEqual(await balance(), before, 'the late answer was billed');
    const raw = await queue.getJob(added.body.id);
    assert.strictEqual(await raw.getState(), 'failed');
    assert.strictEqual(raw.data.outputSchemaHash, undefined, 'the completion hook stamped a failed job');
    assert.strictEqual(raw.attemptsMade, 1);
  });

  it('with two attempts: the retry completes and is billed once; the first attempt\'s late answer is not', async () => {
    const before = await balance();
    const added = await addLate({timeout: 2000, attempts: 2}, {ms: 6000});
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));
    const job = await waitFor(async () => { const b = await jobState(added.body.id); return b.state === 'completed' ? b : null; }, 15000, 'the retry to complete');
    assert.deepStrictEqual(job.job.returnvalue, {output: {ok: true, attempt: 2}});
    await sleep(6500);   // the first attempt's handler has answered by now
    assert.strictEqual(await balance(), before - 1, 'billed other than once');
    assert.strictEqual((await jobState(added.body.id)).job.attemptsMade, 2);
  });

  it('the retry\'s progress is still accepted after the first attempt\'s handler returns', async () => {
    // Attempt 1 times out at 5 s and answers at 6 s; the retry starts at 5 s
    // and reports 1..10 every 400 ms, so most of its reports come after
    // attempt 1 has returned.
    const added = await addLate({timeout: 5000, attempts: 2}, {ms: 6000, steps: 10, stepMs: 400});
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));
    const job = await waitFor(async () => { const b = await jobState(added.body.id); return b.state === 'completed' ? b : null; }, 20000, 'the retry to complete');
    assert.strictEqual(job.job.progress, 10, `progress stopped at ${JSON.stringify(job.job.progress)}`);
  });
});

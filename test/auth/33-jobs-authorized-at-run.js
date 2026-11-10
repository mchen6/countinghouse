// A job is authorized when it runs, not only when it is added: its owner's
// key is checked against the device and action again before every run. A
// queued, delayed, retried or scheduled job whose owner lost the grant, or
// whose key is gone, fails for good (not retried) and is not billed, and a
// scheduler whose owner was refused is removed, so it stops firing. Before,
// such jobs kept running and billing the old key, and its owner could not
// even cancel them. The failure names the code, never the key.
const assert  = require('assert');
const crypto  = require('crypto');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const {Queue} = require('bullmq');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');

const PORT    = 9641;
const URL     = `http://127.0.0.1:${PORT}`;
const DEVICE  = deviceIDForName('job-snoop');
const SERVICE = 'urn:countinghouse-test:serviceID:jobService';
const ADMIN   = `k${crypto.randomBytes(12).toString('hex')}`;
const ALICE   = `k${crypto.randomBytes(12).toString('hex')}`;
const NAME    = `run-auth-${process.pid}`;
const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));

const reload  = () => request(URL).post('/reload-auth').set('X-CH-Key', ADMIN).send({});
const addJob  = (opts) => request(URL).post(`/devices/${DEVICE}/add-job`).set('X-CH-Key', ALICE)
  .send({serviceID: SERVICE, actionName: 'whoami', opts: Object.assign({name: NAME}, opts), input: {note: 'n'}});
const balance = () => request(URL).post('/mcp').set('X-CH-Key', ALICE).set('Accept', 'application/json, text/event-stream')
  .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'countinghouse_check_balance', arguments: {}}})
  .then((r) => r.body.result.structuredContent.balance);

describe('auth 33: a job is authorized when it runs', function() {
  this.timeout(120000);
  let base = null;
  let authPath = null;
  let server = null;
  let queue = null;
  const write = (alice) => fs.writeFileSync(authPath, JSON.stringify(Object.assign(
    {[ADMIN]: {userName: 'admin', devices: ['*'], admin: true}}, alice === undefined ? {} : {[ALICE]: alice})));
  const mine = async (state) => (await queue.getJobs([state], 0, -1)).filter((j) => j != null && j.name === NAME);
  const schedulers = async () => (await queue.getJobSchedulers(0, -1)).filter((s) => String(s.key || s.id || '').includes(NAME));

  before(async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-run-auth-'));
    authPath = path.join(base, 'auth.json');
    write({userName: 'alice', devices: [DEVICE]});
    server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath,
      '--moduleDataPath', path.join(base, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'job-snoop')]);
    queue = new Queue('job-queue', {prefix: '{cdifJob}', connection: {db: 11, host: '127.0.0.1', port: 6379}});
  });
  after(async () => {
    for (const s of await schedulers()) await queue.removeJobScheduler(s.key || s.id);
    for (const state of ['completed', 'failed', 'delayed', 'wait']) for (const j of await mine(state)) await j.remove().catch(() => {});
    await queue.close();
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('a scheduler whose owner loses the grant stops running and billing, and is removed', async () => {
    const added = await addJob({repeat: {every: 1000, limit: 1000}});
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));
    const deadline = Date.now() + 20000;
    while ((await mine('completed')).length < 2 && Date.now() < deadline) await sleep(200);
    assert.ok((await mine('completed')).length >= 2, 'the scheduler never ran');

    write({userName: 'alice', devices: []});
    assert.strictEqual((await reload()).status, 200);
    await sleep(1000);   // a run already under way may still finish
    const done = (await mine('completed')).length;
    const before = await balance();
    await sleep(2500);
    assert.strictEqual((await mine('completed')).length, done, 'the scheduler kept running after its owner lost the grant');
    assert.strictEqual(await balance(), before, 'the owner was billed after losing the grant');
    assert.deepStrictEqual((await schedulers()).map((s) => s.key || s.id), [], 'the refused scheduler is still there');
    const failed = await mine('failed');
    assert.ok(failed.length >= 1, 'no run was refused');
    assert.match(failed[0].failedReason, /^USER_HAS_NO_DEVICE: /);
  });

  it('a delayed job whose owner\'s key is removed before it runs fails, once, and is not billed', async () => {
    write({userName: 'alice', devices: [DEVICE]});
    assert.strictEqual((await reload()).status, 200);
    const before = await balance();
    const added = await addJob({delay: 2000, attempts: 3});
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));
    write(undefined);
    assert.strictEqual((await reload()).status, 200);

    let job = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      job = await queue.getJob(added.body.id);
      if (job != null && job.failedReason != null) break;
      await sleep(200);
    }
    assert.ok(job != null && job.failedReason != null, `the job did not fail: ${JSON.stringify(job && {state: await job.getState()})}`);
    assert.match(job.failedReason, /^SYSTEM_ERROR_UNKNOWN_USER: /);
    assert.ok(!job.failedReason.includes(ALICE), `the key is in the failure: ${job.failedReason}`);
    await sleep(1500);
    assert.strictEqual((await queue.getJob(added.body.id)).attemptsMade, 1, 'retried');

    write({userName: 'alice', devices: [DEVICE]});
    assert.strictEqual((await reload()).status, 200);
    assert.strictEqual(await balance(), before, 'the removed key was billed');
  });
});

'use strict';
// A billed job run, on the Redis job runner (BullMQ), runs only while its
// charge can be recorded (the owner's decision, 11-27): asked after the owner
// check, before the run. The owner's own ledger record is made one that can't
// be charged (not a hash): the first run goes, its charge fails and marks that
// key; the next run is refused before it runs, LEDGER_RECORD_INVALID, its code
// in the failure, and not retried (the refusal isn't retryable).
const assert  = require('assert');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const request = require('supertest');
const redis   = require('redis');
const {Queue} = require('bullmq');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {testPort, redisConnectionFor} = require('../helpers/test-env');
const {prefixFor} = require('../helpers/job-queue');
const {deviceIDForName} = require('../../lib/call-address');
const {meterId} = require('../../lib/key-fingerprint');

const PORT    = testPort(9839);
const URL     = `http://127.0.0.1:${PORT}`;
const DEVICE  = deviceIDForName('job-snoop');
const SERVICE = 'urn:countinghouse-test:serviceID:jobService';
const OWNER   = `k${crypto.randomBytes(12).toString('hex')}`;
const NAME    = `run-uncharged-${process.pid}`;
const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));
const addJob  = () => request(URL).post(`/devices/${DEVICE}/add-job`).set('X-CH-Key', OWNER)
  .send({serviceID: SERVICE, actionName: 'whoami', opts: {name: NAME, attempts: 3}, input: {note: 'n'}});

describe('auth 64: a billed job run waits for a charge that can be recorded (the Redis job runner)', function() {
  this.timeout(120000);
  const trees = require('../helpers/test-tmp').forFile(['ch-auth-64-']);
  let base = null;
  let server = null;
  let queue = null;
  let ledger = null;
  const cmd = (name, ...args) => new Promise((resolve, reject) => ledger[name](...args, (e, r) => (e ? reject(e) : resolve(r))));
  const settled = async (id) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const job = await queue.getJob(id);
      if (job != null && (job.finishedOn != null || job.failedReason != null)) return job;
      await sleep(200);
    }
    return queue.getJob(id);
  };

  before(async () => {
    base = trees.mkdtemp('ch-auth-64-');
    const authPath = path.join(base, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({[OWNER]: {userName: 'owner', devices: [DEVICE]}}), {mode: 0o600});
    ledger = redis.createClient(redisConnectionFor(0));
    ledger.on('error', () => {});
    // (the owner's record, in the ledger's db, of the wrong type: its charge can't be recorded)
    await cmd('set', meterId(OWNER), 'not a hash');
    server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath, '--mcpToolCallCost', '1',
      '--moduleDataPath', path.join(base, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'job-snoop')]);
    queue = new Queue('job-queue', {prefix: prefixFor(path.join(base, 'store')), connection: redisConnectionFor(11)});
  });
  after(async () => {
    if (queue != null) {
      for (const state of ['completed', 'failed', 'delayed', 'wait']) {
        for (const j of (await queue.getJobs([state], 0, -1)).filter((x) => x != null && x.name === NAME)) await j.remove().catch(() => {});
      }
      await queue.close();
    }
    stopServer(server);
    if (ledger != null) { await cmd('del', meterId(OWNER)).catch(() => {}); ledger.quit(); }
  });

  it('the run after a charge failed on the owner\'s record is refused before it runs: LEDGER_RECORD_INVALID, once, not retried', async () => {
    const first = await addJob();
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const ran = await settled(first.body.id);
    assert.ok(ran != null && ran.finishedOn != null && ran.failedReason == null, `the first run did not complete: ${JSON.stringify(ran && {failedReason: ran.failedReason})}`);
    const second = await addJob();
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    const refused = await settled(second.body.id);
    assert.ok(refused != null && /^LEDGER_RECORD_INVALID: /.test(String(refused.failedReason)), `not refused for the record: ${JSON.stringify(refused && {failedReason: refused.failedReason, returnvalue: refused.returnvalue})}`);
    assert.ok(!String(refused.failedReason).includes(OWNER), refused.failedReason);
    // (a retried run goes back to wait; one that isn't retried is failed for good)
    const end = Date.now() + 20000;
    while (await refused.getState() !== 'failed' && Date.now() < end) await sleep(100);
    const last = await queue.getJob(second.body.id);
    assert.strictEqual(await last.getState(), 'failed');
    assert.strictEqual(last.attemptsMade, 1, 'retried, though the refusal isn\'t retryable');
  });

  trees.hooks();
});

// --jobTimeout <seconds> (default 3600, 0 = none) bounds a job that sets no
// timeout of its own, so a handler that never answers cannot hold a job
// worker slot forever. It is applied by the job processor, so it also covers
// jobs queued before the flag existed and those a scheduler creates from a
// template stored earlier. A job's own timeout wins.
const assert = require('assert');
const path   = require('path');
const {ROOT, startServer, stopServer, post, waitFor} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');

const KEY     = 'job-timeout-key';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'worker-end');
const DEVICE  = deviceIDForName('worker-end');
const SERVICE = 'urn:countinghouse-test:serviceID:endService';
const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));

const addHang = (port, opts) => post(port, KEY, `/devices/${DEVICE}/add-job`, {serviceID: SERVICE, actionName: 'hang', input: {},
  opts: Object.assign({name: `job-timeout-${Date.now()}`}, opts)});
const jobState = async (port, id) => (await post(port, KEY, `/devices/${DEVICE}/get-job`, {id})).body;
const ready = (port) => waitFor(async () => (await post(port, KEY, `/devices/${DEVICE}/invoke-action`,
  {serviceID: SERVICE, actionName: 'ping', input: {}})).status === 200, 20000, 'worker-end to answer');

describe('sandbox 26: --jobTimeout bounds a job that sets no timeout', function() {
  this.timeout(60000);

  describe('--jobTimeout 2', () => {
    const PORT = 9624;
    let server = null;
    before(async () => {
      server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--jobTimeout', '2', '--loadModule', FIXTURE]);
      await ready(PORT);
    });
    after(() => stopServer(server));

    it('a job that never answers fails after about 2 s', async () => {
      const started = Date.now();
      const added = await addHang(PORT, {});
      const job = await waitFor(async () => {
        const b = await jobState(PORT, added.body.id);
        return b.state === 'failed' ? b : null;
      }, 15000, 'the job to time out');
      const ms = Date.now() - started;
      assert.match(job.job.failedReason, /timed out after 2000 milliseconds/);
      assert.ok(ms >= 1500 && ms < 8000, `failed after ${ms} ms`);
    });

    it('a job\'s own timeout wins', async () => {
      const added = await addHang(PORT, {timeout: 5000});
      await sleep(3500);
      assert.strictEqual((await jobState(PORT, added.body.id)).state, 'active');
      const job = await waitFor(async () => {
        const b = await jobState(PORT, added.body.id);
        return b.state === 'failed' ? b : null;
      }, 10000, 'the job to time out at its own 5 s');
      assert.match(job.job.failedReason, /timed out after 5000 milliseconds/);
    });
  });

  // setTimeout fires at once past 2^31-1 ms (about 24.8 days), so a larger
  // value is clamped to that, not taken as "fail every job immediately".
  describe('--jobTimeout 3000000 (about 35 days)', () => {
    const PORT = 9627;
    let server = null;
    before(async () => {
      server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--jobTimeout', '3000000', '--loadModule', FIXTURE]);
      await ready(PORT);
    });
    after(() => stopServer(server));

    it('a job that never answers is still running after 2 s', async () => {
      const added = await addHang(PORT, {});
      await sleep(2000);
      const b = await jobState(PORT, added.body.id);
      assert.strictEqual(b.state, 'active', JSON.stringify(b.job && b.job.failedReason));
    });

    it('nor does a job\'s own huge timeout fail it at once', async () => {
      const added = await addHang(PORT, {timeout: 3000000000});
      await sleep(2000);
      const b = await jobState(PORT, added.body.id);
      assert.strictEqual(b.state, 'active', JSON.stringify(b.job && b.job.failedReason));
    });
  });

  describe('--jobTimeout 0', () => {
    const PORT = 9625;
    let server = null;
    before(async () => {
      server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--jobTimeout', '0', '--loadModule', FIXTURE]);
      await ready(PORT);
    });
    after(() => stopServer(server));

    it('sets no timeout', async () => {
      const added = await addHang(PORT, {});
      await sleep(4000);
      assert.strictEqual((await jobState(PORT, added.body.id)).state, 'active');
    });
  });

  it('defaults to 3600 seconds', () => {
    const options = require('../../lib/cli-options');
    options.setOptions({});
    assert.strictEqual(options.getOptions().jobTimeout, 3600000);
    options.setOptions({jobTimeout: '0'});
    assert.strictEqual(options.getOptions().jobTimeout, 0);
    options.setOptions({jobTimeout: 'soon'});
    assert.strictEqual(options.getOptions().jobTimeout, 3600000);
  });
});

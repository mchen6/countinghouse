// A job's runs are not rate limited -- only creating it is (add-job and MCP
// task creation share the per-key budget) -- so what one creation may ask
// for is bounded: a repeating job at most once a second (repeat.every at
// least 1000 ms), and at most 10 attempts. Before, repeat.every: 1 with no
// limit, or attempts: 1e9, turned one rate-limited request into unbounded
// work billed to its owner. Anything that is not a whole number in range is
// refused with ADD_JOB_ERROR and no job is created.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const {Queue} = require('bullmq');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');

const PORT    = 9642;
const URL     = `http://127.0.0.1:${PORT}`;
const KEY     = `job-bounds-${process.pid}`;
const DEVICE  = deviceIDForName('job-snoop');
const SERVICE = 'urn:countinghouse-test:serviceID:jobService';
const NAME    = `job-bounds-${process.pid}`;

const addJob = (opts) => request(URL).post(`/devices/${DEVICE}/add-job`).set('X-CH-Key', KEY)
  .send({serviceID: SERVICE, actionName: 'whoami', opts: Object.assign({name: NAME}, opts), input: {}});

describe('auth 34: what one add-job may ask for is bounded', function() {
  this.timeout(60000);
  let base = null;
  let server = null;
  let queue = null;
  const schedulers = async () => (await queue.getJobSchedulers(0, -1)).filter((s) => String(s.key || s.id || '').includes(NAME));

  before(async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-job-bounds-'));
    const authPath = path.join(base, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({[KEY]: {userName: 'bounds', devices: [DEVICE]}}));
    server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath,
      '--moduleDataPath', path.join(base, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'job-snoop')]);
    queue = new Queue('job-queue', {prefix: '{cdifJob}', connection: {db: 11, host: '127.0.0.1', port: 6379}});
  });
  after(async () => {
    for (const s of await schedulers()) await queue.removeJobScheduler(s.key || s.id);
    await queue.close();
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  const refused = async (opts, why) => {
    const r = await addJob(opts);
    assert.notStrictEqual(r.status, 200, `${why} was accepted: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ADD_JOB_ERROR', JSON.stringify(r.body));
    return r.body;
  };

  it('a repeat more often than once a second is refused, and no scheduler is made', async () => {
    const body = await refused({repeat: {every: 999}}, 'every: 999');
    assert.match(body.message, /every/);
    await refused({repeat: {every: 1}}, 'every: 1');
    await refused({repeat: {every: 'often'}}, 'every: "often"');
    await refused({repeat: {every: 1500.5}}, 'every: 1500.5');
    await refused({repeat: {}}, 'a repeat with neither every nor cron');
    assert.deepStrictEqual(await schedulers(), []);
  });

  it('once a second is accepted', async () => {
    const r = await addJob({repeat: {every: 1000, limit: 1}});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });

  it('more than 10 attempts, or not a whole number of them, is refused', async () => {
    const body = await refused({attempts: 11}, 'attempts: 11');
    assert.match(body.message, /attempts/);
    await refused({attempts: 1e9}, 'attempts: 1e9');
    await refused({attempts: 0}, 'attempts: 0');
    await refused({attempts: 2.5}, 'attempts: 2.5');
    await refused({attempts: '3'}, 'attempts: "3"');
  });

  it('10 attempts is accepted', async () => {
    const r = await addJob({attempts: 10, delay: 3600000});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const job = await queue.getJob(r.body.id);
    await job.remove();
  });
});

// A repeatable job's scheduler id was the caller's raw opts.name, in one
// shared queue, and bullmq upserts with override: so tenant B posting
// tenant A's name replaced A's scheduler, and A's later runs became B's
// action, owned and billed to B (review R3-2). Scheduler ids are now
// scoped to their owner, and an owner can remove its own.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const {Queue} = require('bullmq');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');
const {deviceIDForName} = require('../../lib/call-address');

const DEVICE = deviceIDForName('job-snoop');
const SERVICE = 'urn:countinghouse-test:serviceID:jobService';
const NAME = `nightly-report-${process.pid}`;

describe('auth 25: repeatable job schedulers are per owner', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  let queue = null;
  const url = 'http://127.0.0.1:9670';
  const schedulers = async () => (await queue.getJobSchedulers(0, -1)).filter((s) => String(s.key || s.id || s.name).includes(NAME) || s.name === NAME);
  before(async () => {
    base = mkdtemp('schedulers-');
    const authPath = path.join(base, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({
      'alice-key': {userName: 'alice', devices: [DEVICE]},
      'bob-key':   {userName: 'bob', devices: [DEVICE]}
    }));
    server = await startServer(9670, ['--workerThread', '--authConfigPath', authPath, '--moduleDataPath', path.join(base, 'store'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'job-snoop')]);
    queue = new Queue('job-queue', {prefix: '{cdifJob}', connection: {db: 11, host: '127.0.0.1', port: 6379}});
  });
  after(async () => {
    for (const s of await queue.getJobSchedulers(0, -1)) if (String(s.key || s.id).includes(NAME)) await queue.removeJobScheduler(s.key || s.id);
    await queue.close();
    stopServer(server);
    if (base) fs.rmSync(base, {recursive: true, force: true});
  });

  const addRepeat = (key, note) => request(url).post(`/devices/${DEVICE}/add-job`).set('X-CH-Key', key)
    .send({serviceID: SERVICE, actionName: 'whoami', opts: {name: NAME, repeat: {every: 3600000, limit: 1}}, input: {note: note}});
  const removeRepeat = (key) => request(url).post(`/devices/${DEVICE}/remove-job`).set('X-CH-Key', key).send({name: NAME, isRepeat: true});

  it('a second tenant using the same name gets its own scheduler; the first is intact', async () => {
    assert.strictEqual((await addRepeat('alice-key', 'alice')).status, 200);
    assert.strictEqual((await addRepeat('bob-key', 'bob')).status, 200);
    const s = await schedulers();
    assert.strictEqual(s.length, 2, JSON.stringify(s));
    const notes = s.map((x) => x.template && x.template.data && x.template.data.input && x.template.data.input.note).sort();
    assert.deepStrictEqual(notes, ['alice', 'bob'], JSON.stringify(s));
    assert.ok(!JSON.stringify(s.map((x) => x.key || x.id)).includes('alice-key'), 'a raw key in a scheduler id');
  });

  it('an owner removes its own scheduler, and only its own', async () => {
    const r = await removeRepeat('bob-key');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const s = await schedulers();
    assert.strictEqual(s.length, 1, JSON.stringify(s));
    assert.strictEqual(s[0].template.data.input.note, 'alice');
  });
});

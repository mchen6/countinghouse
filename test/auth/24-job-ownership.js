// CHUtil.jobInfo and CHUtil.jobProgress take any job id, and the main thread
// answered with JobControl.INTERNAL: a module could read every tenant's jobs,
// their raw API keys included, and change their progress (review R3-1). A
// worker now reaches only the jobs it is running, and the job it gets back
// carries no API key.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');
const {deviceIDForName} = require('../../lib/call-address');

const DEVICE = deviceIDForName('job-snoop');
const SERVICE = 'urn:countinghouse-test:serviceID:jobService';

describe('auth 24: a module reaches only its own jobs', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  const url = 'http://127.0.0.1:9669';
  before(async () => {
    base = mkdtemp('jobs-');
    const authPath = path.join(base, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({
      'alice-key': {userName: 'alice', devices: [DEVICE]},
      'bob-key':   {userName: 'bob', devices: [DEVICE]}
    }));
    server = await startServer(9669, ['--workerThread', '--authConfigPath', authPath, '--moduleDataPath', path.join(base, 'store'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'job-snoop')]);
  });
  after(() => { stopServer(server); if (base) fs.rmSync(base, {recursive: true, force: true}); });

  const addJob = (key, input) => request(url).post(`/devices/${DEVICE}/add-job`).set('X-CH-Key', key)
    .send({serviceID: SERVICE, actionName: 'whoami', opts: {name: `whoami-${process.pid}-${Date.now()}`}, input: input});
  const getJob = (key, id) => request(url).post(`/devices/${DEVICE}/get-job`).set('X-CH-Key', key).send({id: id});
  const settled = async (key, id) => {
    for (let i = 0; i < 100; i++) {
      const r = await getJob(key, id);
      if (r.body && ['completed', 'failed'].includes(r.body.state)) return r.body;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`job ${id} did not settle`);
  };

  it('a module reads its own running job, without the creator\'s API key', async () => {
    const created = await addJob('alice-key', {note: 'alice job'});
    assert.ok(created.body.id != null, JSON.stringify(created.body));
    const done = await settled('alice-key', created.body.id);
    assert.deepStrictEqual(done.job.returnvalue && done.job.returnvalue.output, {own: 'ok', apiKey: 'absent', note: 'alice job'}, JSON.stringify(done));
  });

  it('another tenant\'s job is refused, by read and by progress update', async () => {
    const created = await addJob('alice-key', {note: 'secret'});
    const before = await settled('alice-key', created.body.id);
    const r = await mcpCall(9669, 'bob-key', 'job_snoop_jobservice_snoop', {jobID: String(created.body.id)});
    const out = r.structuredContent != null ? r.structuredContent.output : r;
    assert.ok(/^error: /.test(String(out.read)), `bob read alice's job: ${JSON.stringify(out)}`);
    assert.ok(!/alice-key/.test(JSON.stringify(r)), 'the key leaked');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await settled('alice-key', created.body.id);
    assert.strictEqual(after.job.progress, before.job.progress, 'bob changed the progress of alice\'s job');
  });
});

// MCP completeness M6, the trust boundary's two in-process checks (the
// reviewer's rulings on #M6):
//   - resources/read is charged before it is served: a metering provider
//     whose recordCall fails is the read's answer, and no bytes go out
//     (parity with tools/call: no balance gate, the billing-authority
//     principle; the charge is at --resourceReadCost);
//   - a task's stored values are in its job's session: each job runner hands
//     the run's session to the completion hook, and placeTaskValues stores
//     in the session it is given.
// End to end on a session is M17's, where tasks on sessions arrive.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {redisUrlFor} = require('../helpers/test-env');

const KEY = 'm6-trust-key';
const PDF = {type: 'object', properties: {doc: {type: 'string', contentEncoding: 'base64', contentMediaType: 'application/pdf'}}};
const until = async (fn, ms = 10000) => {
  for (let w = 0; w < ms; w += 50) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

describe('mcp-contract 17: stored values, in-process (M6)', function() {
  // (its jobs' owners known to the identity index, as a server's: B-meter-keys (2))
  require('../helpers/identity-scope').useIdentity([KEY]);
  this.timeout(30000);
  // (the BullMQ runner's queue and the job history are this server's: B-j1)
  require('../helpers/server-id').useServerId();
  const options = require('../../lib/cli-options');
  let dir;
  let saved;
  let gateway;
  let identity;
  let blobs;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-m6-17-'));
    saved = {debug: options.debug, debugKey: options.debugKey, store: options.store, storePath: options.storePath,
      moduleDataPath: options.moduleDataPath, resourceReadCost: options.resourceReadCost, workerThread: options.workerThread, redisUrl: options.redisUrl};
    Object.assign(options, {debug: true, debugKey: KEY, store: 'local', storePath: path.join(dir, 'store'), moduleDataPath: path.join(dir, 'module_data'),
      resourceReadCost: 3, workerThread: true, redisUrl: redisUrlFor()});
    identity = require('../../lib/identity');
    if (!identity.ready()) identity.initSync({moduleDataPath: options.moduleDataPath});
    gateway = require('../../lib/mcp/gateway');
    blobs = require('../../lib/store').getStore().blobs;
  });
  after(() => {
    Object.assign(options, saved);
    fs.rmSync(dir, {recursive: true, force: true});
  });

  describe('resources/read is charged before it is served', () => {
    const read = (uri, cdifInterface) => new Promise((resolve) => {
      gateway.handle({jsonrpc: '2.0', id: 3, method: 'resources/read', params: {uri}}, cdifInterface, KEY, (err, res) => resolve(res));
    });
    const stub = (fail) => {
      const charges = [];
      return {charges, rateLimit: (k, cb) => cb(null, {limited: false}),
        // (a store's error with a code, its message naming the key: the log
        // line carries the code alone)
        recordCall: (k, tool, cost, cb) => { charges.push([tool, cost]); cb(fail ? Object.assign(new Error(`metering is down for ${KEY}`), {code: 'ERR_STORE'}) : null, {}); }};
    };

    it('a metering refusal is the answer: no contents, no bytes; the charge was asked once, at --resourceReadCost', async () => {
      const {id} = await blobs.put({owner: identity.idForKey(KEY), session: null, mimeType: 'application/pdf', bytes: Buffer.from('%PDF secret'), source: {}});
      const ci = stub(true);
      const LOG = require('../../lib/logger');
      const realE = LOG.E;
      const logged = [];
      LOG.E = (x) => logged.push(String(x && x.message != null ? x.message : x));
      let res;
      try { res = await read(`countinghouse://r/${id}`, ci); } finally { LOG.E = realE; }
      // (logged by the key's fingerprint, the tool, the amount and the
      // error's code, never the store's own message, which may name a host,
      // a URL or the key)
      const {keyFingerprint} = require('../../lib/key-fingerprint');
      assert.deepStrictEqual(logged.filter((l) => l.startsWith('resources/read ')),
        [`resources/read countinghouse:resources/read: the billing failed for ${keyFingerprint(KEY)}, amount 3 (ERR_STORE); the read was refused`]);
      assert.ok(!logged.some((l) => l.includes(KEY) || l.includes('metering is down')), JSON.stringify(logged));
      assert.strictEqual(res.result, undefined, JSON.stringify(res));
      // a fixed text: the provider's own message is logged, never echoed
      assert.strictEqual(res.error.message, 'the read could not be metered');
      assert.ok(!JSON.stringify(res).includes('metering is down'));
      assert.ok(!JSON.stringify(res).includes(Buffer.from('%PDF secret').toString('base64')), 'no bytes');
      assert.deepStrictEqual(ci.charges, [['countinghouse:resources/read', 3]]);
    });

    it('a charge that goes through: served, charged once', async () => {
      const {id} = await blobs.put({owner: identity.idForKey(KEY), session: null, mimeType: 'application/pdf', bytes: Buffer.from('%PDF ok'), source: {}});
      const ci = stub(false);
      const res = await read(`countinghouse://r/${id}`, ci);
      assert.strictEqual(Buffer.from(res.result.contents[0].blob, 'base64').toString(), '%PDF ok');
      assert.deepStrictEqual(ci.charges, [['countinghouse:resources/read', 3]]);
    });

    it('a URI that finds nothing is not charged', async () => {
      const ci = stub(false);
      const res = await read(`countinghouse://r/${'A'.repeat(43)}`, ci);
      assert.deepStrictEqual(res.error, {code: -32602, message: 'Resource not found'});
      assert.deepStrictEqual(ci.charges, []);
    });
  });

  // M19 x M6: a resources/read is cancellable (the review of #314); a read
  // cancelled before it is charged is neither charged nor answered
  it('a resources/read cancelled before it is served: no charge, nothing answered', async () => {
    const {id} = await blobs.put({owner: identity.idForKey(KEY), session: null, mimeType: 'application/pdf', bytes: Buffer.from('%PDF x'), source: {}});
    const charges = [];
    const ci = {rateLimit: (k, cb) => cb(null, {limited: false}), recordCall: (k, tool, cost, cb) => { charges.push(tool); cb(null, {}); }};
    const got = await new Promise((resolve) => {
      gateway.handle({jsonrpc: '2.0', id: 9, method: 'resources/read', params: {uri: `countinghouse://r/${id}`}}, ci, KEY,
        (err, res, info) => resolve({err, res, info}), {cancellable: (cancel) => { setImmediate(cancel); return () => {}; }});
    });
    assert.deepStrictEqual([got.err, got.res, got.info], [null, null, {cancelled: true}]);
    assert.deepStrictEqual(charges, []);
  });

  // the review of #314: a task-augmented call cancelled before its answer.
  // Checked before addJob, no job is made; after it, the job is removed if
  // still waiting, and one a worker already took (BullMQ can, before addJob
  // answers) runs to its end, billed; either way nothing is answered.
  describe('a task cancelled before its answer', () => {
    const TARGET = {name: 't', deviceID: 'd', serviceID: 's', actionName: 'a'};
    const create = (state) => new Promise((resolve) => gateway.doCreateTaskForToolCall({id: 5, params: {task: {}}}, TARGET, {}, {appKey: KEY, session: null},
      (err, res, info) => resolve({err, res, info}), state));
    let jobs;
    let saved;
    beforeEach(() => {
      jobs = require('../../lib/store').jobs;
      saved = {addJob: jobs.addJob, removeJob: jobs.removeJob};
    });
    afterEach(() => { jobs.addJob = saved.addJob; jobs.removeJob = saved.removeJob; });

    it('cancelled while it was authorized: no job is made, nothing answered', async () => {
      let added = 0;
      jobs.addJob = (...a) => { added += 1; process.nextTick(a[6], null, {id: '70'}); };
      const got = await create({cancelled: true});
      assert.deepStrictEqual([got.err, got.res, added], [null, null, 0]);
    });

    it('cancelled once its job was made, still waiting: the job is removed, nothing answered', async () => {
      const state = {cancelled: false};
      const removed = [];
      jobs.addJob = (...a) => { state.cancelled = true; process.nextTick(a[6], null, {id: '71'}); };
      jobs.removeJob = (authCtx, name, id, rep, cb) => { removed.push(id); process.nextTick(cb, null, {removed: true}); };
      const got = await create(state);
      assert.deepStrictEqual([got.err, got.res, removed], [null, null, ['71']]);
    });

    it('cancelled once a worker had taken its job: it can\'t be removed and runs to its end; nothing answered, no throw', async () => {
      const state = {cancelled: false};
      const removed = [];
      jobs.addJob = (...a) => { state.cancelled = true; process.nextTick(a[6], null, {id: '72'}); };
      jobs.removeJob = (authCtx, name, id, rep, cb) => { removed.push(id); process.nextTick(cb, new Error('Job 72 could not be removed because it is locked by another worker')); };
      const got = await create(state);
      await new Promise((r) => setImmediate(r));
      assert.deepStrictEqual([got.err, got.res, removed], [null, null, ['72']]);
    });
  });

  describe('a task\'s stored values are in its job\'s session', () => {
    it('a task completed twice keeps its first stored values (the review of #313): nothing stored again', async () => {
      const owner = identity.idForKey(KEY);
      const who = {module: 'm', action: 'a', tool: 't'};
      const out = {output: {doc: Buffer.from('%PDF twice').toString('base64')}};
      const first = await gateway.placeTaskValues({ownerId: owner}, out, PDF, null, who);
      const before = await blobs.usage(owner);
      const again = await gateway.placeTaskValues({ownerId: owner, resultUris: first.uris}, out, PDF, null, who);
      assert.deepStrictEqual(again.uris, first.uris);
      assert.deepStrictEqual(await blobs.usage(owner), before, 'no new item');
    });

    it('placeTaskValues stores in the session it is given, and none when given none', async () => {
      const owner = identity.idForKey(KEY);
      const who = {module: 'm', action: 'a', tool: 't'};
      const out = {output: {doc: Buffer.from('%PDF task').toString('base64')}};
      const inSession = await gateway.placeTaskValues({ownerId: owner}, out, PDF, 's-task-1', who);
      assert.strictEqual(inSession.error, null);
      const id = inSession.uris['/doc'].slice('countinghouse://r/'.length);
      assert.ok(await blobs.get(id, {owner, session: 's-task-1'}) != null, 'its own session reads it');
      assert.strictEqual(await blobs.get(id, {owner, session: 's-task-2'}), null, 'another session of the same owner does not');
      const none = await gateway.placeTaskValues({ownerId: owner}, out, PDF, null, who);
      const id2 = none.uris['/doc'].slice('countinghouse://r/'.length);
      assert.strictEqual((await blobs.get(id2, {owner, session: null})).meta.session, null);
    });

    it('the local runner hands the run\'s session to the completion hook', async () => {
      const {createRunner, INTERNAL} = require('../../lib/job-control-local');
      const jobSessions = require('../../lib/job-sessions');
      const runner = createRunner({jobTimeoutMs: 0});
      runner.authorizeRun = require('../helpers/identity-scope').authorizedRun;
      runner.initJobProcess({recordCall: (k, t, c, cb) => cb && cb(null),
        invokeJobs: (d, s, a, input, jobID, cb) => setImmediate(cb, null, {output: {}})});
      const metas = [];
      runner.setCompletionHook((jobData, results, meta) => { metas.push(meta); });
      const r = await new Promise((resolve) => runner.addJob(INTERNAL, {name: 'm6-session', delay: 200}, 'd', 's', 'a', {}, (err, res) => resolve(res)));
      jobSessions.remember(String(r.id), 's-run-1');
      try {
        assert.ok(await until(() => metas.length > 0), 'the hook ran');
        assert.strictEqual(metas[0].session, 's-run-1');
      } finally {
        jobSessions.forget(String(r.id));
        runner.close();
      }
    });

    it('the Redis runner (BullMQ) hands the run\'s session to the completion hook', async () => {
      const jobControl = require('../../lib/job-control');
      const jobSessions = require('../../lib/job-sessions');
      const {INTERNAL} = require('../../lib/job-control-common');
      jobControl.authorizeRun = require('../helpers/identity-scope').authorizedRun;
      jobControl.initJobProcess({recordCall: (k, t, c, cb) => cb && cb(null),
        invokeJobs: (d, s, a, input, jobID, cb) => setImmediate(cb, null, {output: {}})});
      const metas = [];
      jobControl.setCompletionHook((jobData, results, meta) => { metas.push(meta); });
      try {
        const r = await new Promise((resolve, reject) => jobControl.addJob(INTERNAL, {name: `m6-session-${process.pid}`, delay: 500}, 'd', 's', 'a', {},
          (err, res) => (err != null ? reject(err) : resolve(res))));
        jobSessions.remember(String(r.id), 's-run-2');
        assert.ok(await until(() => metas.length > 0), 'the hook ran');
        assert.strictEqual(metas[0].session, 's-run-2');
        jobSessions.forget(String(r.id));
      } finally {
        jobControl.setCompletionHook(null);
        await Promise.allSettled([jobControl.worker, jobControl.queueEvents, jobControl.jobQueue].filter((x) => x != null).map((x) => x.close()));
        // and the server id's claim it made (B-j1), released
        if (jobControl.claim != null) { await jobControl.claim.stop(); jobControl.claim = null; }
      }
    });
  });
});

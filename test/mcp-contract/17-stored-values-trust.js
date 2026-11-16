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
  this.timeout(30000);
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
        recordCall: (k, tool, cost, cb) => { charges.push([tool, cost]); cb(fail ? new Error('metering is down') : null, {}); }};
    };

    it('a metering refusal is the answer: no contents, no bytes; the charge was asked once, at --resourceReadCost', async () => {
      const {id} = await blobs.put({owner: identity.idForKey(KEY), session: null, mimeType: 'application/pdf', bytes: Buffer.from('%PDF secret'), source: {}});
      const ci = stub(true);
      const res = await read(`countinghouse://r/${id}`, ci);
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
      runner.authorizeRun = () => Promise.resolve();
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
      jobControl.authorizeRun = () => Promise.resolve();
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
      }
    });
  });
});

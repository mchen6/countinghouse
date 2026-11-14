// R2-1 Task 3 (docs/superpowers/plans/2026-11-08-r2-1-no-raw-keys-in-modules.md):
// every hop carries a per-call token that the main thread issued and bound to
// the worker it sent the call to, and the main thread bills and checks the hop
// by that token, not by any key the worker states. RED on master; written on
// Opus ahead of the implementation, to be reviewed before it is built on.
//
// The forging composite (test/fixtures/token-forge) rewrites what its own
// worker sends, at the transport, as any module in its worker can. It runs
// under --moduleSandbox off: the threat is the module that controls its
// worker, and nothing the sandbox does is what stops it here.
//
// The interfaces (lib/call-tokens.js, the worker messages):
//   - a routed hop's token is `data.token` on its invokeforeignaction
//     message; a peer invoke carries none: its caller worker announces
//     {channel, invokeId, token} to the main thread ('peer-announce'), and
//     the callee's metering request cites {channel, invokeId}; a device
//     query carries `data.token`;
//   - an unknown, expired or foreign token answers CALL_TOKEN_INVALID;
//   - lib/call-tokens.js: issue({billingKey, identityKey, module, workerId,
//     deviceID, parent?, ttlMs?}) -> token; resolve(token, {workerId}) ->
//     entry | null; dropFor(workerId); drop(token).
const assert  = require('assert');
const crypto  = require('crypto');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');
const {deviceIDForName} = require('../../lib/call-address');
const {testPort} = require('../helpers/test-env');

const hex = () => crypto.randomBytes(6).toString('hex');
const VIA   = 'token_forge_forgeservice_viacall';
const COUNT = 'token_callee_tokencallee_count';
const WORKER_END = deviceIDForName('worker-end');

const PATHS = [
  {label: 'routed', port: testPort(9695), flags: ['--no-directPeerChannels']},
  {label: 'direct peer channels', port: testPort(9696), flags: ['--directPeerChannels']}
];

PATHS.forEach((hopPath) => {
  describe(`composition 18: per-call tokens on a hop (${hopPath.label})`, function() {
    this.timeout(120000);
    const URL = `http://127.0.0.1:${hopPath.port}`;
    const KEYS = {a: `a-key-${hex()}`, b: `b-key-${hex()}`, other: `other-key-${hex()}`, reader: `reader-key-${hex()}`, internal: `forge-internal-${hex()}`,
      admin: `admin-key-${hex()}`, granted: `granted-key-${hex()}`, ungranted: `ungranted-key-${hex()}`};
    let base = null;
    let server = null;

    const mcp = (key, method, params) => request(URL).post('/mcp').set('X-CH-Key', key)
      .set('Accept', 'application/json, text/event-stream').send({jsonrpc: '2.0', id: Date.now(), method, params}).then((r) => r.body);
    const via = async (key, args) => {
      const r = await mcp(key, 'tools/call', {name: VIA, arguments: args});
      assert.ok(r.result != null && r.result.isError === false, JSON.stringify(r).slice(0, 600));
      return toolOutput(r.result);
    };
    const runs = async () => toolOutput((await mcp(KEYS.reader, 'tools/call', {name: COUNT, arguments: {}})).result).n;
    const balanceOf = (key) => request(URL).get('/balance').set('X-CH-Key', key).then((r) => r.body.balance);
    // A balance is read until three reads agree: metering lands after the
    // answer (lib/metering), so one read can see a charge still on its way.
    async function settled(key) {
      let last = null, stable = 0;
      const deadline = Date.now() + 10000;
      for (;;) {
        const b = await balanceOf(key);
        stable = (last !== null && b === last) ? stable + 1 : 1;
        last = b;
        if (stable >= 3) return b;
        if (Date.now() >= deadline) throw new Error(`the balance of ${key} never settled (last ${b})`);
        await new Promise((ok) => setTimeout(ok, 150));
      }
    }
    async function paid(keys, action) {
      const before = {};
      for (const k of keys) before[k] = await settled(KEYS[k]);
      const result = await action();
      const out = {};
      for (const k of keys) out[k] = before[k] - await settled(KEYS[k]);
      return {result, paid: out};
    }

    before(async () => {
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-tokens-18-'));
      const authPath = path.join(base, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({
        [KEYS.a]: {userName: `a-${hex()}`, devices: ['*']},
        [KEYS.b]: {userName: `b-${hex()}`, devices: ['*']},
        [KEYS.other]: {userName: `other-${hex()}`, devices: ['*']},
        [KEYS.reader]: {userName: `reader-${hex()}`, devices: ['*']},
        [KEYS.internal]: {userName: `forge-internal-${hex()}`, devices: ['*'], runsModules: ['token-forge']},
        [KEYS.admin]: {userName: `admin-${hex()}`, devices: ['*'], admin: true, runsModules: ['hop-prober']},
        [KEYS.granted]: {userName: `granted-${hex()}`, devices: [WORKER_END]},
        [KEYS.ungranted]: {userName: `ungranted-${hex()}`, devices: [deviceIDForName('some-other-module')]}
      }));
      server = await startServer(hopPath.port, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath,
        '--mcpToolCallCost', '1', '--moduleSandbox', 'off', '--moduleDataPath', path.join(base, 'store')].concat(hopPath.flags, [
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'token-callee'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'token-forge'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'worker-end'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'hop-prober')]));
    });
    after(() => {
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it('a plain hop works and bills its caller (the baseline)', async () => {
      const {result, paid: p} = await paid(['a', 'other'], () => via(KEYS.a, {marker: 'plain'}));
      assert.strictEqual(result.code, null, JSON.stringify(result));
      assert.deepStrictEqual(p, {a: 2, other: 0}, 'the outer call and the hop, both to the caller');
    });

    it('(a) a hop stating another tenant\'s key is billed to the token\'s caller, not to that key', async () => {
      const {result, paid: p} = await paid(['a', 'other'], () => via(KEYS.a, {marker: 'a', forge: {billingKey: KEYS.other, everyToken: true}}));
      assert.strictEqual(result.code, null, JSON.stringify(result));
      assert.deepStrictEqual(p, {a: 2, other: 0}, 'billed to the stated key');
    });

    it('(b) a made-up token is refused CALL_TOKEN_INVALID: no handler runs and the hop is not billed', async () => {
      const ranBefore = await runs();
      const {result, paid: p} = await paid(['a'], () => via(KEYS.a, {marker: 'b', forge: {token: `made-up-${hex()}`, everyToken: true}}));
      assert.strictEqual(result.code, 'CALL_TOKEN_INVALID', JSON.stringify(result));
      assert.strictEqual(await runs(), ranBefore, 'the callee\'s handler ran');
      assert.deepStrictEqual(p, {a: 1}, 'only the outer call is billed');
    });

    // Review Focus 1. Both calls run in the composite's one worker, so the
    // worker holds both tokens; the hop is billed by the token it carries
    // (the per-worker limit the spec states). And the token is on nothing
    // ctx exposes.
    it('(c) of two concurrent calls, a hop carrying B\'s token is billed to B\'s caller; the token is not on ctx', async () => {
      const {result, paid: p} = await paid(['a', 'b'], async () => {
        const callB = via(KEYS.b, {marker: 'c-b', forge: {stash: 'b', holdUntil: 'c-a'}});
        const callA = via(KEYS.a, {marker: 'c-a', forge: {tokenFrom: 'b'}});
        return Promise.all([callA, callB]);
      });
      assert.strictEqual(result[1].stashed, true, 'B\'s hop carried no token to take');
      assert.deepStrictEqual(result.map((r) => r.code), [null, null], JSON.stringify(result));
      assert.deepStrictEqual(result.map((r) => r.exposed), [false, false], 'the token can be read off ctx');
      assert.deepStrictEqual(p, {a: 1, b: 3}, 'A\'s hop must be billed to B\'s caller, whose token it carried');
    });

    // Last in this describe: it unloads worker-end. The device query a hop's
    // client is built from carries the call's token, so main knows who asks:
    // the identity granted the device is told why it is missing, any other
    // gets the access error (composition 16's oracle rule). Composition 16's
    // "a client built now sees the same for an unloaded device as for one
    // never hosted" changes with this, for the granted identity.
    it('(g) a client built after the unload: the identity granted the device gets MODULE_UNLOADED through the device query', async () => {
      const observe = async (as) => JSON.parse((await mcpCall(hopPath.port, KEYS.admin, 'hop_prober_probeservice_observe', {as: as, deviceID: WORKER_END})).content[0].text);
      await waitFor(async () => (await observe(KEYS.admin)).code == null, 20000, 'the prober to reach worker-end');
      assert.strictEqual((await post(hopPath.port, KEYS.admin, '/unload-module', {name: 'worker-end'})).status, 200);
      const granted = await observe(KEYS.granted);
      const ungranted = await observe(KEYS.ungranted);
      assert.strictEqual(granted.code, 'MODULE_UNLOADED', JSON.stringify(granted));
      assert.strictEqual(ungranted.code, 'USER_HAS_NO_DEVICE', JSON.stringify(ungranted));
    });
  });
});

// The real sandbox: under --moduleSandbox enforce the forge cannot hook
// (worker_threads is refused to module code), so a plain hop through it
// exercises the token path as hosting runs it. The perf run found the peer
// path requiring worker_threads in a module's call, which enforce refuses.
describe('composition 18: a hop under --moduleSandbox enforce, on both paths', function() {
  this.timeout(120000);
  const PORT = testPort(9698);
  const URL = `http://127.0.0.1:${PORT}`;
  const KEY = `enforce-key-${hex()}`;
  const INTERNAL = `forge-internal-${hex()}`;
  let base = null;
  let server = null;
  before(() => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-tokens-18e-'));
    fs.writeFileSync(path.join(base, 'auth.json'), JSON.stringify({
      [KEY]: {userName: `enforce-${hex()}`, devices: ['*']},
      [INTERNAL]: {userName: `forge-internal-${hex()}`, devices: ['*'], runsModules: ['token-forge']}
    }));
  });
  afterEach(() => { stopServer(server); server = null; });
  after(() => { if (base != null) fs.rmSync(base, {recursive: true, force: true}); });

  [['routed', '--no-directPeerChannels'], ['direct peer channels', '--directPeerChannels']].forEach(([label, flag]) => {
    it(`${label}: a plain hop answers, and nothing the lockdown refuses was asked for`, async () => {
      server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', path.join(base, 'auth.json'),
        '--mcpToolCallCost', '1', '--moduleSandbox', 'enforce', '--moduleDataPath', path.join(base, 'store'), flag,
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'token-callee'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'token-forge')]);
      const r = await request(URL).post('/mcp').set('X-CH-Key', KEY).set('Accept', 'application/json, text/event-stream')
        .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: VIA, arguments: {marker: 'enforce'}}}).then((x) => x.body);
      assert.ok(r.result != null && r.result.isError === false, JSON.stringify(r).slice(0, 600));
      assert.strictEqual(toolOutput(r.result).code, null, JSON.stringify(r.result));
      assert.ok(!/violation builtin worker_threads/.test(server.output), `the lockdown was asked for worker_threads: ${server.output.slice(-1500)}`);
    });
  });
});

// The review of #138 (8, 2b, 6), on a server of its own per case: the
// request timer short, so a callee can answer after its caller's timeout;
// the worker's reading of that timer; and the message rate on the peer path.
describe('composition 18: the caller\'s timeout, the worker\'s timer, and the message rate', function() {
  this.timeout(120000);
  const PORT = testPort(9698);
  const URL = `http://127.0.0.1:${PORT}`;
  const KEY = `bound-key-${hex()}`;
  const READER = `reader-key-${hex()}`;
  const INTERNAL = `forge-internal-${hex()}`;
  let base = null;
  let server = null;
  const mcp = (key, name, args) => request(URL).post('/mcp').set('X-CH-Key', key).set('Accept', 'application/json, text/event-stream')
    .send({jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: {name, arguments: args}}).then((x) => x.body);
  const via = async (args) => {
    const r = await mcp(KEY, VIA, args);
    assert.ok(r.result != null && r.result.isError === false, JSON.stringify(r).slice(0, 600));
    return toolOutput(r.result);
  };
  const runs = async () => toolOutput((await mcp(READER, COUNT, {})).result).n;
  const balance = () => request(URL).get('/balance').set('X-CH-Key', KEY).then((r) => r.body.balance);
  // sandbox: 'off' lets the probe reach the worker's options; the message
  // rate applies under the sandbox ('audit', the worker-thread default)
  const start = (flags, sandbox = 'off') => startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', path.join(base, 'auth.json'),
    '--mcpToolCallCost', '1', '--moduleSandbox', sandbox, '--moduleDataPath', path.join(base, 'store')].concat(flags, [
    '--loadModule', path.join(ROOT, 'test', 'fixtures', 'token-callee'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'token-forge')]));
  before(() => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-tokens-18b-'));
    fs.writeFileSync(path.join(base, 'auth.json'), JSON.stringify({
      [KEY]: {userName: `bound-${hex()}`, devices: ['*']},
      [READER]: {userName: `reader-${hex()}`, devices: ['*']},
      [INTERNAL]: {userName: `forge-internal-${hex()}`, devices: ['*'], runsModules: ['token-forge']}
    }));
  });
  afterEach(() => { stopServer(server); server = null; });
  after(() => { if (base != null) fs.rmSync(base, {recursive: true, force: true}); });

  [['routed', '--no-directPeerChannels'], ['direct peer channels', '--directPeerChannels']].forEach(([label, flag]) => {
    // The caller answers at 1 s without awaiting its hop; the callee answers
    // at 3 s, past the 2 s request timer. The handler ran (the count moved),
    // and the hop costs 0: only the outer call is billed.
    it(`(#138-8) ${label}: a callee that answers after the caller's timeout is billed 0`, async () => {
      server = await start(['--requestTimeout', '2', flag]);
      const before = await balance();
      const ranBefore = await runs();
      const out = await via({marker: 'late', slowMs: 3000, answerAfterMs: 1000});
      assert.strictEqual(out.code, null, JSON.stringify(out));
      await waitFor(async () => (await runs()) > ranBefore, 6000);
      assert.strictEqual(await runs(), ranBefore + 1, 'the slow handler did not run');
      await new Promise((ok) => setTimeout(ok, 1500));
      assert.strictEqual(before - await balance(), 1, 'the late hop was billed');
    });
  });

  // #141 N1 on a server: a job's token outlives the caller's per-invoke
  // timeout (the run is bounded by its own timeout, not the request timer),
  // so an early announcement still matches a live token. The forge
  // announces at once and posts the invoke only after the deadline, while
  // the run waits (it does not await its hop). No handler runs, nothing is
  // delivered, and only the run itself is billed.
  it('(#141-N1) a job: an early announcement with the invoke after the deadline runs no handler and bills only the run', async () => {
    server = await start(['--requestTimeout', '2', '--directPeerChannels']);
    await via({marker: 'warm-job'});   // the channel is open
    const before = await balance();
    const ranBefore = await runs();
    const FORGE = deviceIDForName('token-forge');
    const added = await request(URL).post(`/devices/${FORGE}/add-job`).set('X-CH-Key', KEY)
      .send({serviceID: 'urn:countinghouse-test:serviceID:forgeService', actionName: 'viaCall', opts: {name: `early-${hex()}`},
        input: {marker: 'job-early', answerAfterMs: 5000, forge: {delayInvokeMs: 2600}}});
    assert.ok(added.body != null && added.body.id != null, JSON.stringify(added.body));
    // get-job answers {job, state}
    const done = await waitFor(async () => {
      const r = await request(URL).post(`/devices/${FORGE}/get-job`).set('X-CH-Key', KEY).send({id: added.body.id});
      return (r.body != null && ['completed', 'failed'].includes(r.body.state)) ? r.body : null;
    }, 20000, 'the job to finish');
    assert.strictEqual(done.state, 'completed', JSON.stringify(done).slice(0, 400));
    assert.strictEqual(done.job.returnvalue.output.code, 'PEER_CHANNEL_TIMEOUT', `the caller's own timer: ${JSON.stringify(done.job.returnvalue)}`);
    await new Promise((ok) => setTimeout(ok, 1000));
    assert.strictEqual(await runs(), ranBefore, 'the handler ran for an invoke past the deadline');
    assert.strictEqual(before - await balance(), 1, 'more than the run was billed');
  });

  it('(#138-2b) a worker reads the request timer in milliseconds, as the main thread gave it', async () => {
    server = await start(['--requestTimeout', '2', '--directPeerChannels']);
    const out = await via({marker: 'probe', probe: 'requestTimeout'});
    assert.deepStrictEqual([out.requestTimeout, out.requestTimeoutMs], [2000, 2000], JSON.stringify(out));
  });

  // The caller worker spends its message budget first, so the hop's own
  // announcement is the message the main thread refuses: the hop fails
  // RATE_LIMITED at once, not CALL_TOKEN_INVALID a second later.
  it('(#138-6) direct peer channels: a hop whose announcement is rate-limited fails RATE_LIMITED at once', async () => {
    server = await start(['--moduleMessageRate', '5', '--directPeerChannels'], 'audit');
    const client = {viaClient: true, callee: deviceIDForName('token-callee'), as: INTERNAL};   // the cached client: no device query per hop
    const warm = await via(Object.assign({marker: 'warm'}, client));   // the channel is open, the client cached
    assert.strictEqual(warm.code, null, JSON.stringify(warm));
    const ranBefore = await runs();
    const out = await via(Object.assign({marker: 'limited', drainFirst: 30}, client));
    assert.strictEqual(out.code, 'RATE_LIMITED', JSON.stringify(out));
    assert.ok(out.tookMs < 800, `the hop took ${out.tookMs} ms to fail`);
    assert.strictEqual(await runs(), ranBefore, 'the callee\'s handler ran');
  });
});

// Jobs carry their owner's opaque id, not a key (Review Focus 4): a run's
// token is issued for that owner. A job or scheduler stored before the
// upgrade, with an apiKey only, still runs, bills and is its owner's.
describe('composition 18: jobs, by their owner\'s identity', function() {
  this.timeout(120000);
  const {Queue} = require('bullmq');
  const PORT = testPort(9697);
  const URL = `http://127.0.0.1:${PORT}`;
  const DEVICE = deviceIDForName('job-snoop');
  const SERVICE = 'urn:countinghouse-test:serviceID:jobService';
  const ADMIN = `admin-key-${hex()}`;
  const ALICE = `alice-key-${hex()}`;
  const NAME = `tokens-18-${process.pid}`;
  const ID_SHAPE = /^u_[A-Za-z0-9_-]{22}$/;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let base = null, authPath = null, server = null, queue = null;
  const write = (alice) => fs.writeFileSync(authPath, JSON.stringify(Object.assign(
    {[ADMIN]: {userName: `admin-${hex()}`, devices: ['*'], admin: true}}, alice ? {[ALICE]: {userName: `alice-${hex()}`, devices: [DEVICE]}} : {})));
  const reload = () => request(URL).post('/reload-auth').set('X-CH-Key', ADMIN).send({});
  const addJob = (name, opts, note) => request(URL).post(`/devices/${DEVICE}/add-job`).set('X-CH-Key', ALICE)
    .send({serviceID: SERVICE, actionName: 'whoami', opts: Object.assign({name: name}, opts), input: {note: note}});
  const balance = () => request(URL).get('/balance').set('X-CH-Key', ALICE).then((r) => r.body.balance);
  const legacyData = (note) => ({deviceID: DEVICE, serviceID: SERVICE, actionName: 'whoami', input: {note: note}, apiKey: ALICE});
  async function finished(id) {
    const deadline = Date.now() + 20000;
    for (;;) {
      const job = await queue.getJob(id);
      if (job != null && (job.finishedOn != null || job.failedReason != null)) return job;
      if (Date.now() >= deadline) throw new Error(`job ${id} did not finish`);
      await sleep(200);
    }
  }

  before(async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-tokens-18j-'));
    authPath = path.join(base, 'auth.json');
    write(true);
    server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath, '--mcpToolCallCost', '1',
      '--moduleDataPath', path.join(base, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'job-snoop')]);
    // The server's Redis: CH_TEST_REDIS_URL's when set (test/helpers/test-env.js).
    const redis = (process.env.CH_TEST_REDIS_URL != null && process.env.CH_TEST_REDIS_URL !== '') ? new globalThis.URL(process.env.CH_TEST_REDIS_URL) : null;
    queue = new Queue('job-queue', {prefix: '{cdifJob}', connection: {db: 11, host: redis != null ? redis.hostname : '127.0.0.1', port: redis != null ? Number(redis.port) : 6379}});
  });
  after(async () => {
    for (const s of await queue.getJobSchedulers(0, -1)) if (String(s.key || s.id).includes(NAME)) await queue.removeJobScheduler(s.key || s.id);
    for (const state of ['completed', 'failed', 'delayed', 'wait']) {
      for (const j of await queue.getJobs([state], 0, -1)) if (j != null && String(j.name).startsWith(NAME)) await j.remove().catch(() => {});
    }
    await queue.close();
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('(e) a new job stores its owner\'s id and no key', async () => {
    const added = await addJob(`${NAME}-new`, {delay: 600000}, 'new');
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));
    const job = await queue.getJob(added.body.id);
    assert.ok(!('apiKey' in job.data), `the key is stored: ${Object.keys(job.data)}`);
    assert.match(String(job.data.ownerId), ID_SHAPE);
    assert.ok(!JSON.stringify(job.data).includes(ALICE), 'the key is in the job data');
    await job.remove();
  });

  it('(e) a job stored before the upgrade, with an apiKey only, runs and bills its owner', async () => {
    const before = await balance();
    const job = await queue.add(`${NAME}-legacy`, legacyData('legacy'));
    const done = await finished(job.id);
    assert.strictEqual(done.failedReason, undefined, String(done.failedReason));
    assert.strictEqual(done.returnvalue.output.own, 'ok', JSON.stringify(done.returnvalue));
    await sleep(1000);
    assert.strictEqual(before - await balance(), 1, 'the run is billed to the key it was stored with');
  });

  // On master already (Task 1 moved the id); kept here because Task 3
  // changes what a scheduler's runs carry.
  it('(f) a scheduler stored under the old sha256-prefixed id runs as its owner\'s, who can remove it', async () => {
    const legacyId = `${crypto.createHash('sha256').update(ALICE).digest('hex').slice(0, 16)}:${NAME}-sched`;
    await queue.upsertJobScheduler(legacyId, {every: 1000, limit: 1}, {name: `${NAME}-sched`, data: legacyData('sched')});
    let history = [];
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && history.length === 0) {
      await sleep(300);
      const r = await request(URL).post(`/devices/${DEVICE}/get-job-history`).set('X-CH-Key', ALICE).send({name: `${NAME}-sched`});
      history = Array.isArray(r.body) ? r.body : (Array.isArray(r.body.data) ? r.body.data : []);
    }
    assert.ok(history.length > 0, 'its run is not listed to its owner');
    const removed = await request(URL).post(`/devices/${DEVICE}/remove-job`).set('X-CH-Key', ALICE).send({name: `${NAME}-sched`, isRepeat: true});
    assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
    assert.strictEqual((await queue.getJobSchedulers(0, -1)).filter((s) => String(s.key || s.id) === legacyId).length, 0);
  });

  it('(h) a job whose owner was removed fails SYSTEM_ERROR_UNKNOWN_USER, once, and is not billed', async () => {
    const before = await balance();
    const added = await addJob(`${NAME}-gone`, {delay: 2000, attempts: 3}, 'gone');
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));
    write(false);
    assert.strictEqual((await reload()).status, 200);
    const job = await finished(added.body.id);
    assert.match(String(job.failedReason), /^SYSTEM_ERROR_UNKNOWN_USER: /);
    await sleep(1500);
    assert.strictEqual((await queue.getJob(added.body.id)).attemptsMade, 1, 'retried');
    write(true);
    assert.strictEqual((await reload()).status, 200);
    assert.strictEqual(await balance(), before, 'the removed owner was billed');
  });
});

// The token store and the peer path's checks on the main thread, unit by
// unit (lib/peer-channel-broker.js; the reviewer's additions of 2026-11-09,
// and the ruling of 2026-11-13: authorize before serve, bill on success):
//   - handleAnnouncement(data, fromWM): the caller worker's {channel,
//     invokeId, token} for one peer invoke, where `channel` is the broker's
//     pair key `${callerWorkerId}:${calleeWorkerId}`;
//   - handleMeteringRequest(data, msgID, calleeWM), before the handler, with
//     data {channel, invokeId, deviceID, serviceID, actionName}: answered
//     through calleeWM.sendPeerMeteringReplyToChild({msgID, errMsg, errCode,
//     token}); a refusal has errCode CALL_TOKEN_INVALID and means "do not
//     serve"; a match carries the callee's own token and bills nothing yet;
//   - handleBillRequest({token}, msgID, calleeWM), after the handler
//     succeeded: bills the announced call's caller, once; a token it does
//     not know is refused;
//   - PEER_ANNOUNCE_WAIT_MS = 1000; 64 held requests per channel at most;
//   - options.peerChannelAuthLookupTimeoutMs bounds one re-check lookup;
//   - the balance deduction's deadline is about 500 ms.
describe('composition 18: the token store and the peer path\'s checks (unit)', function() {
  this.timeout(20000);
  const cli = require('../../lib/cli-options');
  const CHUtil = require('../../lib/countinghouse-util');
  const LOG = require('../../lib/logger');
  require('../../lib/logger').createLogger(false);
  const tokens = () => require('../../lib/call-tokens');
  const ENTRY = (workerId) => ({billingKey: `alice-key-${hex()}`, identityKey: `forge-internal-${hex()}`, module: 'token-forge', workerId: workerId, deviceID: 'd-callee'});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  describe('lib/call-tokens.js', () => {
    it('a token resolves for the worker it was issued to, and says whom to bill', () => {
      const e = ENTRY(1);
      const t = tokens().issue(e);
      assert.strictEqual(typeof(t), 'string');
      assert.ok(t.length >= 22, 'too short to be unguessable');
      assert.ok(!t.includes(e.billingKey) && !t.includes(e.identityKey), 'the token carries a key');
      const r = tokens().resolve(t, {workerId: 1});
      assert.deepStrictEqual([r.billingKey, r.identityKey, r.module, r.deviceID], [e.billingKey, e.identityKey, e.module, e.deviceID]);
    });

    it('a made-up token, or one from another worker (a peer callee reusing its caller\'s), resolves to nothing', () => {
      const t = tokens().issue(ENTRY(1));
      assert.strictEqual(tokens().resolve(`made-up-${hex()}`, {workerId: 1}), null);
      assert.strictEqual(tokens().resolve(t, {workerId: 2}), null);
    });

    it('an expired token resolves to nothing (the call\'s timeout is the backstop)', async () => {
      const t = tokens().issue(Object.assign(ENTRY(1), {ttlMs: 40}));
      assert.notStrictEqual(tokens().resolve(t, {workerId: 1}), null);
      await sleep(60);
      assert.strictEqual(tokens().resolve(t, {workerId: 1}), null);
    });

    it('a dropped token resolves to nothing; dropFor drops every token of one worker, and only its', () => {
      const t = tokens().issue(ENTRY(1));
      tokens().drop(t);
      assert.strictEqual(tokens().resolve(t, {workerId: 1}), null);
      const a = tokens().issue(ENTRY(4));
      const b = tokens().issue(ENTRY(4));
      const c = tokens().issue(ENTRY(5));
      tokens().dropFor(4);
      assert.strictEqual(tokens().resolve(a, {workerId: 4}), null);
      assert.strictEqual(tokens().resolve(b, {workerId: 4}), null);
      assert.notStrictEqual(tokens().resolve(c, {workerId: 5}), null);
    });

    // The review of #138 (1): a child token is its parent's call's, so it
    // lives no longer than the parent, goes when the parent goes, and is
    // nothing once any ancestor is. Otherwise a colluding part could mint
    // itself a new token each time the last one neared its end, and one
    // call would bill its caller for ever.
    it('(#138-1) a child expires no later than its parent; dropping a token drops its descendants; an ancestor gone ends the chain', async () => {
      const parent = tokens().issue(Object.assign(ENTRY(6), {ttlMs: 80}));
      const child = tokens().issue(Object.assign(ENTRY(7), {parent: parent}));
      const e = tokens().resolve(child, {workerId: 7});
      assert.ok(e != null && e.expires <= tokens().resolve(parent, {workerId: 6}).expires, 'the child outlives its parent');
      await sleep(100);
      assert.strictEqual(tokens().resolve(child, {workerId: 7}), null, 'the child is live after its parent expired');

      const p2 = tokens().issue(ENTRY(6));
      const c2 = tokens().issue(Object.assign(ENTRY(7), {parent: p2}));
      const g2 = tokens().issue(Object.assign(ENTRY(8), {parent: c2}));
      tokens().drop(p2);
      assert.strictEqual(tokens().resolve(c2, {workerId: 7}), null, 'the child survived its parent\'s drop');
      assert.strictEqual(tokens().resolve(g2, {workerId: 8}), null, 'the grandchild survived');

      const p3 = tokens().issue(ENTRY(6));
      const c3 = tokens().issue(Object.assign(ENTRY(7), {parent: p3}));
      tokens().dropFor(6);   // the parent's worker ended: everything under it is over too
      assert.strictEqual(tokens().resolve(c3, {workerId: 7}), null, 'the chain outlived the parent\'s worker');
    });

    // #141 N2: the chain's depth is bounded (mutual recursion between two
    // composites would otherwise grow it without end), and dropping a chain
    // does not recurse.
    it('(#141-N2) a chain at the depth limit refuses the next hop with HOP_CHAIN_TOO_DEEP; dropping a deep chain does not throw', () => {
      const limit = tokens().MAX_CHAIN_DEPTH;
      assert.ok(Number.isInteger(limit) && limit >= 8, 'no depth limit');
      const root = tokens().issue(ENTRY(9));
      let last = root;
      for (let i = 0; i < limit; i++) last = tokens().issue(Object.assign(ENTRY(9), {parent: last}));
      let err = null;
      try { tokens().issue(Object.assign(ENTRY(9), {parent: last})); } catch (e) { err = e; }
      assert.ok(err != null && err.code === 'HOP_CHAIN_TOO_DEEP', `the hop past the limit was issued: ${err && err.code}`);
      assert.notStrictEqual(tokens().resolve(last, {workerId: 9}), null);
      assert.doesNotThrow(() => tokens().drop(root));
      assert.strictEqual(tokens().resolve(last, {workerId: 9}), null, 'the deep chain survived its root\'s drop');
    });
  });

  describe('the broker: announce and match', () => {
    let broker = null, caller = null, callee = null, billed = null, savedCi = null;
    const wm = (workerId) => ({workerId: workerId, ended: null, replies: [], sendPeerMeteringReplyToChild(m) { this.replies.push(m); }});
    const pair = () => `${caller.workerId}:${callee.workerId}`;
    const meter = (invokeId, msgID) => broker.handleMeteringRequest({channel: pair(), invokeId: invokeId, deviceID: 'd-callee', serviceID: 'svc', actionName: 'bump'}, msgID, callee);
    const announce = (invokeId, token, from) => broker.handleAnnouncement({channel: pair(), invokeId: invokeId, token: token}, from || caller);
    const bill = (token, msgID) => broker.handleBillRequest({token: token}, msgID, callee);
    const replyTo = (msgID) => callee.replies.find((r) => r.msgID === msgID);
    const refused = (r) => r != null && r.errCode === 'CALL_TOKEN_INVALID';
    const served = (msgID) => { const r = replyTo(msgID); return r != null && !refused(r) && typeof(r.token) === 'string'; };

    beforeEach(() => {
      cli.setOptions({workerThread: true, mcpToolCallCost: 1});
      savedCi = CHUtil.ci;
      billed = [];
      CHUtil.ci = {recordCall: (key, tool, cost, cb) => { billed.push(key); cb(null, {charged: cost, balance: 99}); }};
      const PeerChannelBroker = require('../../lib/peer-channel-broker');
      caller = wm(11);
      callee = wm(12);
      // the calling module (its token's device, d-callee in ENTRY) declared
      // bump on the devices these cases invoke (R2-1 Task 4)
      caller.bindings = {'d-callee': {identity: null, module: 'token-forge', targets: new Set(['d-callee|svc|bump', 'd-other|svc|bump'])}};
      broker = new PeerChannelBroker({deviceMap: {}});
      broker.channelRegistry[pair()] = {callerWM: caller, calleeWM: callee, grants: {}};
    });
    afterEach(() => { CHUtil.ci = savedCi; });

    it('a metering request matched by its announcement is served with the callee\'s own token; the bill request then bills the token\'s caller, once', async () => {
      const e = ENTRY(caller.workerId);
      announce(1, tokens().issue(e));
      meter(1, 'm1');
      await sleep(50);
      assert.ok(served('m1'), JSON.stringify(callee.replies));
      assert.deepStrictEqual(billed, [], 'billed before the handler ran');
      const token = replyTo('m1').token;
      assert.deepStrictEqual([tokens().resolve(token, {workerId: callee.workerId}).billingKey, tokens().resolve(token, {workerId: caller.workerId})], [e.billingKey, null], 'the callee\'s token is its own');
      bill(token, 'b1');
      await sleep(50);
      assert.ok(replyTo('b1') != null && !refused(replyTo('b1')) && replyTo('b1').meteringResult.charged === 1, JSON.stringify(replyTo('b1')));
      assert.deepStrictEqual(billed, [e.billingKey]);
      assert.strictEqual(tokens().resolve(token, {workerId: callee.workerId}), null, 'the callee\'s token outlived its invoke');
      bill(token, 'b1-again');
      await sleep(50);
      assert.ok(refused(replyTo('b1-again')), 'billed twice');
      bill(`made-up-${hex()}`, 'b-made-up');
      await sleep(50);
      assert.ok(refused(replyTo('b-made-up')), 'a made-up token was billed');
      assert.deepStrictEqual(billed, [e.billingKey]);
    });

    it('a metering request with no announcement is held, then refused: not billed, not served', async () => {
      meter(2, 'm2');
      await sleep(300);
      assert.strictEqual(replyTo('m2'), undefined, 'answered before the wait was up');
      await sleep(1000);
      assert.ok(refused(replyTo('m2')), JSON.stringify(callee.replies));
      assert.deepStrictEqual(billed, []);
    });

    it('an announcement arriving late but inside the bound: served, and billed on the bill request', async () => {
      const e = ENTRY(caller.workerId);
      meter(3, 'm3');
      await sleep(300);
      announce(3, tokens().issue(e));
      await sleep(100);
      assert.ok(served('m3'), JSON.stringify(callee.replies));
      bill(replyTo('m3').token, 'b3');
      await sleep(50);
      assert.deepStrictEqual(billed, [e.billingKey]);
    });

    it('a second metering request for one announcement is refused', async () => {
      const e = ENTRY(caller.workerId);
      announce(4, tokens().issue(e));
      meter(4, 'm4a');
      await sleep(50);
      meter(4, 'm4b');
      await sleep(1300);
      assert.ok(served('m4a'), JSON.stringify(callee.replies));
      assert.ok(refused(replyTo('m4b')), JSON.stringify(callee.replies));
      assert.deepStrictEqual(billed, []);
    });

    it('a handler that failed reports served: false: nothing billed, and the callee\'s token dropped', async () => {
      announce(10, tokens().issue(ENTRY(caller.workerId)));
      meter(10, 'm10');
      await sleep(50);
      assert.ok(served('m10'), JSON.stringify(callee.replies));
      const token = replyTo('m10').token;
      broker.handleBillRequest({token: token, served: false}, 'b10', callee);
      await sleep(50);
      assert.ok(replyTo('b10') != null && !refused(replyTo('b10')) && replyTo('b10').errMsg == null, JSON.stringify(replyTo('b10')));
      assert.deepStrictEqual(billed, []);
      assert.strictEqual(tokens().resolve(token, {workerId: callee.workerId}), null);
      assert.strictEqual(broker.unbilled.size, 0);
    });

    it('no metering provider at all: the hop is served, and the bill request says it went unbilled', async () => {
      CHUtil.ci = null;
      announce(11, tokens().issue(ENTRY(caller.workerId)));
      meter(11, 'm11');
      await sleep(50);
      assert.ok(served('m11'), JSON.stringify(callee.replies));
      bill(replyTo('m11').token, 'b11');
      await sleep(50);
      assert.ok(replyTo('b11') != null && !refused(replyTo('b11')) && /unavailable/.test(replyTo('b11').errMsg), JSON.stringify(replyTo('b11')));
    });

    it('a channel closed by the re-check forgets its announcements: a channel granted again on the pair starts its ids over', async () => {
      const t = tokens().issue(ENTRY(caller.workerId));
      announce(0, t);
      const entry = broker.channelRegistry[pair()];
      caller.sendPeerInvalidateToChild = () => {};
      callee.sendPeerInvalidateToChild = () => {};
      broker.closeRevoked(pair(), entry, {appKey: 'k', deviceID: 'd-callee'}, new Error('revoked'));
      assert.strictEqual(broker.announced.size, 0, 'the stale announcement stayed');
      broker.channelRegistry[pair()] = {callerWM: caller, calleeWM: callee, grants: {}};
      meter(0, 'm0');
      await sleep(100);
      assert.strictEqual(replyTo('m0'), undefined, 'matched to the old channel\'s announcement');
      await sleep(1300);
      assert.ok(refused(replyTo('m0')), JSON.stringify(callee.replies));
      assert.deepStrictEqual(billed, []);
    });

    it('a worker that ends takes its matched invokes with it', async () => {
      announce(12, tokens().issue(ENTRY(caller.workerId)));
      meter(12, 'm12');
      await sleep(50);
      assert.ok(served('m12'));
      caller.sendPeerInvalidateToChild = () => {};
      callee.sendPeerInvalidateToChild = () => {};
      broker.invalidateWorker(callee);
      assert.strictEqual(broker.unbilled.size, 0);
      bill(replyTo('m12').token, 'b12');
      await sleep(50);
      assert.ok(refused(replyTo('b12')), 'billed after its worker ended');
    });

    it('(1) an announcement from the callee, with the caller\'s token, is refused; the request stays unmatched and is refused', async () => {
      announce(5, tokens().issue(ENTRY(caller.workerId)), callee);
      meter(5, 'm5');
      await sleep(1300);
      assert.ok(refused(replyTo('m5')), JSON.stringify(callee.replies));
      assert.deepStrictEqual(billed, []);
    });

    it('(2) a token dropped (its call answered) takes its unmatched announcement with it', async () => {
      const t = tokens().issue(ENTRY(caller.workerId));
      announce(6, t);
      tokens().drop(t);
      meter(6, 'm6');
      await sleep(1300);
      assert.ok(refused(replyTo('m6')), JSON.stringify(callee.replies));
      assert.deepStrictEqual(billed, []);
    });

    it('(2) past 64 held requests on one channel, the next is refused at once', async () => {
      for (let i = 0; i < 64; i++) meter(100 + i, `h${i}`);
      meter(200, 'over');
      await sleep(30);
      assert.ok(refused(replyTo('over')), 'the 65th was held');
      assert.strictEqual(callee.replies.filter((r) => String(r.msgID).startsWith('h')).length, 0, 'a held one was answered early');
      await sleep(1300);
    });

    it('(d) Redis down: a valid token still serves (the deduction fails open), an invalid one does not', async () => {
      CHUtil.ci = {recordCall: (key, tool, cost, cb) => cb(new Error('connect ECONNREFUSED 127.0.0.1:6379'))};
      announce(7, tokens().issue(ENTRY(caller.workerId)));
      meter(7, 'm7');
      announce(8, `made-up-${hex()}`);   // refused as an announcement, so the request has none
      meter(8, 'm8');
      await sleep(100);
      assert.ok(served('m7'), JSON.stringify(callee.replies));
      bill(replyTo('m7').token, 'b7');
      await sleep(50);
      assert.ok(replyTo('b7') != null && !refused(replyTo('b7')) && replyTo('b7').errMsg != null, `the deduction's failure, not a refusal: ${JSON.stringify(replyTo('b7'))}`);
      assert.strictEqual(replyTo('m8'), undefined, 'refused before the announcement bound');
      await sleep(1300);
      assert.ok(refused(replyTo('m8')), JSON.stringify(callee.replies));
    });

    // The review of #138 (7): a deadline that answered "served unbilled"
    // while recordCall could still charge told the log something false. The
    // wait is bounded still (a stalled deduction must not hold the callee's
    // dispatch slots), and the answer says the billing is pending; the
    // deduction's outcome is logged when it comes.
    it('(5) a hung deduction: answered within the bound as billing pending, never as unbilled; the late charge is logged', async () => {
      const lines = [];
      const savedE = LOG.E, savedI = LOG.I;
      LOG.E = (e) => lines.push(String(e && e.message ? e.message : e));
      LOG.I = (m) => lines.push(String(m));
      let answerLate = null;
      CHUtil.ci = {recordCall: (key, tool, cost, cb) => { answerLate = () => cb(null, {charged: cost, balance: 98}); }};
      try {
        announce(9, tokens().issue(ENTRY(caller.workerId)));
        meter(9, 'm9');
        await sleep(50);
        assert.ok(served('m9'), JSON.stringify(callee.replies));
        const started = Date.now();
        bill(replyTo('m9').token, 'b9');
        while (replyTo('b9') == null && Date.now() - started < 1500) await sleep(20);
        assert.ok(replyTo('b9') != null && Date.now() - started < 1000, `not answered within the bound (${Date.now() - started} ms)`);
        assert.ok(!refused(replyTo('b9')) && replyTo('b9').errMsg == null && replyTo('b9').billingPending === true, JSON.stringify(replyTo('b9')));
        assert.ok(lines.some((l) => /billing pending/i.test(l)) && !lines.some((l) => /unbilled/i.test(l)), JSON.stringify(lines));
        answerLate();
        assert.ok(lines.some((l) => /pending billing landed/i.test(l)), `the late charge was not logged: ${JSON.stringify(lines)}`);
        assert.strictEqual(callee.replies.filter((r) => r.msgID === 'b9').length, 1, 'answered twice');
      } finally {
        LOG.E = savedE;
        LOG.I = savedI;
      }
    });

    // The review of #138 (2a): the bill is for the matched invoke, and the
    // match is what says whom to bill. The callee's token may be gone by
    // then (its call's chain answered: a caller that did not await its hop),
    // and the handler still ran, inside the caller's timeout.
    it('(#138-2a) a bill for a matched invoke whose token has gone is billed from the match, inside the caller\'s timeout', async () => {
      const e = ENTRY(caller.workerId);
      const outer = tokens().issue(e);
      announce(12, outer);
      meter(12, 'm12');
      await sleep(50);
      assert.ok(served('m12'), JSON.stringify(callee.replies));
      const token = replyTo('m12').token;
      tokens().drop(outer);   // the outer call answered: its chain is dropped
      assert.strictEqual(tokens().resolve(token, {workerId: callee.workerId}), null, 'the callee\'s token outlived its parent');
      bill(token, 'b12');
      await sleep(50);
      assert.ok(replyTo('b12') != null && !refused(replyTo('b12')) && replyTo('b12').meteringResult != null && replyTo('b12').meteringResult.charged === 1, JSON.stringify(replyTo('b12')));
      assert.deepStrictEqual(billed, [e.billingKey]);
      bill(token, 'b12-again');
      await sleep(50);
      assert.ok(refused(replyTo('b12-again')), 'billed twice');
      assert.deepStrictEqual(billed, [e.billingKey]);
    });

    it('(#138-2a) a bill from a worker other than the matched callee is refused', async () => {
      const e = ENTRY(caller.workerId);
      announce(13, tokens().issue(e));
      meter(13, 'm13');
      await sleep(50);
      const token = replyTo('m13').token;
      const other = wm(13);
      broker.handleBillRequest({token: token}, 'b13', other);
      await sleep(50);
      assert.ok(refused(other.replies.find((r) => r.msgID === 'b13')), JSON.stringify(other.replies));
      assert.deepStrictEqual(billed, []);
    });

    // The review of #138 (8), as the reviewer narrowed it: main saw the
    // announcement, and knows the caller's per-invoke timeout; a bill after
    // announce + timeout charges nothing. The caller worker is told nothing
    // and says nothing: a worker's word on billing is what R2-1 removes.
    it('(#138-8) a bill arriving after the announcement plus the caller\'s timeout charges nothing, and the reply says so', async () => {
      cli.setOptions({workerThread: true, mcpToolCallCost: 1, requestTimeout: 0.15});   // seconds, as the CLI takes it: 150 ms
      const e = ENTRY(caller.workerId);
      announce(14, tokens().issue(e));
      meter(14, 'm14');
      await sleep(50);
      assert.ok(served('m14'), JSON.stringify(callee.replies));
      await sleep(200);
      bill(replyTo('m14').token, 'b14');
      await sleep(50);
      const r = replyTo('b14');
      // #141 N1: a coded refusal, which the callee treats as RATE_LIMITED (the
      // result is not delivered), so a late hop is neither billed nor served
      assert.ok(r != null && r.errCode === 'PEER_CHANNEL_TIMEOUT' && r.meteringResult == null, JSON.stringify(r));
      assert.deepStrictEqual(billed, [], 'charged after the caller\'s timeout');
      assert.strictEqual(broker.unbilled.size, 0);
    });

    // Task 4's review: the main thread checks the invoke's action against the
    // caller's declarations at the match too, not only the callee worker.
    it('(T4-review) a metering request for an action the caller did not declare is refused CTX_CALL_UNDECLARED', async () => {
      announce(30, tokens().issue(ENTRY(caller.workerId)));
      broker.handleMeteringRequest({channel: pair(), invokeId: 30, deviceID: 'd-callee', serviceID: 'svc', actionName: 'tick'}, 'm30', callee);
      await sleep(50);
      const r = replyTo('m30');
      assert.ok(r != null && r.errCode === 'CTX_CALL_UNDECLARED' && typeof(r.token) !== 'string', JSON.stringify(r));
      assert.strictEqual(broker.unbilled.size, 0);
    });

    // #141 N1: the announcement's time is the deadline's start, and a module
    // can post an announcement itself, early. So the match too is refused
    // once the deadline has passed: no handler runs for an invoke whose
    // announcement is older than the caller's timeout.
    it('(#141-N1) an announcement older than the caller\'s timeout matches nothing: no handler runs', async () => {
      cli.setOptions({workerThread: true, mcpToolCallCost: 1, requestTimeout: 0.15});
      announce(22, tokens().issue(ENTRY(caller.workerId)));
      await sleep(200);
      meter(22, 'm22');
      await sleep(50);
      const r22 = replyTo('m22');
      assert.ok(r22 != null && r22.errCode === 'PEER_CHANNEL_TIMEOUT' && typeof(r22.token) !== 'string', `served past the deadline, or refused as a bad token: ${JSON.stringify(r22)}`);
      assert.strictEqual(broker.announced.size, 0, 'the stale announcement stayed');
      assert.deepStrictEqual(billed, []);
    });

    // #141 N5: a channel gone (PEER_GONE for the caller) takes its matched
    // invokes with it: a bill for one of them is refused, nothing charged.
    // #141 N4: the token leaves the worker's rate-exempt set with the entry.
    it('(#141-N5, N4) a forgotten pair takes its matched invokes, and their tokens leave the rate-exempt set', async () => {
      const e = ENTRY(caller.workerId);
      announce(23, tokens().issue(e));
      meter(23, 'm23');
      await sleep(50);
      assert.ok(served('m23'));
      const token = replyTo('m23').token;
      assert.ok(callee.unbilledTokens.has(token), 'the matched token is not rate-exempt');
      broker.forgetPair(pair());
      assert.strictEqual(broker.unbilled.size, 0, 'the pair\'s matched invoke outlived the pair');
      assert.ok(!callee.unbilledTokens.has(token), 'the token stayed rate-exempt after its entry went');
      bill(token, 'b23');
      await sleep(50);
      assert.ok(refused(replyTo('b23')), JSON.stringify(replyTo('b23')));
      assert.deepStrictEqual(billed, []);
    });

    it('(#141-N4) the sweep forgetting a matched invoke past its deadline takes it out of the rate-exempt set', async () => {
      cli.setOptions({workerThread: true, mcpToolCallCost: 1, requestTimeout: 0.15});
      announce(24, tokens().issue(ENTRY(caller.workerId)));
      meter(24, 'm24');
      await sleep(50);
      const token = replyTo('m24').token;
      assert.ok(callee.unbilledTokens.has(token));
      await sleep(200);
      broker.sweep();
      assert.strictEqual(broker.unbilled.size, 0);
      assert.ok(!callee.unbilledTokens.has(token), 'the token stayed rate-exempt after the sweep');
    });

    // The narrow pass over #141: the exemption is the token's, not a count. A
    // late bill for a forgotten invoke is counted against the rate and cannot
    // use up the exemption a live invoke's bill needs.
    it('(#141-credits) under an empty message budget, only a bill citing a live match passes the rate', () => {
      const WorkerMessage = require('../../lib/worker-message');
      const posted = [];
      const emitted = [];
      const wmMain = new WorkerMessage(null);
      wmMain.worker = {postMessage: (m) => posted.push(m)};
      wmMain.messageRate = 1;
      wmMain.rateTokens = 0;
      wmMain.rateRefillAt = Date.now() + 60000;   // no refill during the test
      wmMain.on('peer-bill-request', (m) => emitted.push(m.data.token));
      wmMain.unbilledTokens = new Set(['live']);
      wmMain.onWorkerMessage({id: 1, category: 'child', command: 'peer-bill-request', data: {token: 'forgotten'}});
      wmMain.onWorkerMessage({id: 2, category: 'child', command: 'peer-bill-request', data: {token: 'live'}});
      wmMain.onWorkerMessage({id: 3, category: 'child', command: 'peer-bill-request', data: {token: 'made-up'}});
      assert.deepStrictEqual(emitted, ['live'], `passed the rate: ${JSON.stringify(emitted)}`);
      assert.deepStrictEqual(posted.map((m) => [m.command, m.msgID]), [['rate-limited-reply', 1], ['rate-limited-reply', 3]]);
    });

    // The review of #138 (4): the cap on matched, unbilled invokes used to
    // evict the oldest, which then went free; it is per channel now, and
    // fails closed: past it, a metering request is refused, and what is
    // there stays billable.
    it('(#138-4) past the cap on matched unbilled invokes on one channel, the next request is refused; nothing goes free', async () => {
      const PeerChannelBroker = require('../../lib/peer-channel-broker');
      const cap = PeerChannelBroker.UNBILLED_PER_CHANNEL_MAX;
      assert.ok(Number.isInteger(cap) && cap > 0, 'no per-channel cap');
      const e = ENTRY(caller.workerId);
      const first = tokens().issue(e);
      announce(1000, first);
      meter(1000, 'm1000');
      for (let i = 1; i < cap; i++) { announce(1000 + i, tokens().issue(e)); meter(1000 + i, `m${1000 + i}`); }
      assert.ok(served('m1000') && served(`m${1000 + cap - 1}`), 'the matches under the cap were not served');
      announce(1000 + cap, tokens().issue(e));
      meter(1000 + cap, 'm-over');
      await sleep(50);
      assert.ok(refused(replyTo('m-over')), `served past the cap: ${JSON.stringify(replyTo('m-over'))}`);
      assert.strictEqual(broker.unbilled.size, cap, 'an entry was evicted');
      bill(replyTo('m1000').token, 'b1000');
      await sleep(50);
      assert.deepStrictEqual(billed, [e.billingKey], 'the oldest match went free');
      // the count is by pair key (#141 N3), carried across grants; a pair
      // forgotten takes its matched invokes with it (N5), so a channel
      // granted again on it starts clean
      broker.forgetPair(pair());
      assert.strictEqual(broker.unbilled.size, 0);
      broker.channelRegistry[pair()] = {callerWM: caller, calleeWM: callee, grants: {}};
      announce(2000 + cap, tokens().issue(e));
      meter(2000 + cap, 'm-regranted');
      await sleep(50);
      assert.ok(served('m-regranted'), `the re-granted channel inherited the old count: ${JSON.stringify(replyTo('m-regranted'))}`);
      // a second channel is not bounded by the first's
      const other = wm(14);
      broker.channelRegistry[`${caller.workerId}:${other.workerId}`] = {callerWM: caller, calleeWM: other, grants: {}};
      broker.handleAnnouncement({channel: `${caller.workerId}:${other.workerId}`, invokeId: 1, token: tokens().issue(e)}, caller);
      broker.handleMeteringRequest({channel: `${caller.workerId}:${other.workerId}`, invokeId: 1, deviceID: 'd-other', serviceID: 'svc', actionName: 'bump'}, 'm-other', other);
      await sleep(50);
      const r = other.replies.find((x) => x.msgID === 'm-other');
      assert.ok(r != null && !refused(r) && typeof(r.token) === 'string', `the other channel was refused: ${JSON.stringify(r)}`);
    });

    // The review of #138 (5a): the channel open takes the call's token too
    // (spec section 3; "every worker message needs a token"). Without one,
    // or with another worker's, the request is denied before any lookup.
    it('(#138-5a) a channel request without the call\'s token, or with a foreign one, is denied CALL_TOKEN_INVALID before any lookup', async () => {
      const authPath = require.resolve('../../lib/user-auth');
      const savedAuth = require.cache[authPath];
      let lookups = 0;
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true, exports: () => { lookups++; }};
      try {
        delete require.cache[require.resolve('../../lib/peer-channel-broker')];
        const PeerChannelBroker = require('../../lib/peer-channel-broker');
        const b = new PeerChannelBroker({deviceMap: {}});
        const denied = [];
        // the requesting module declared a call on d-callee (R2-1 Task 4: a
        // channel opens only to a declared device)
        const requester = {workerId: 15, sendPeerChannelDenyToChild: (m) => denied.push(m),
          bindings: {'d-callee': {identity: null, module: 'token-forge', targets: new Set(['d-callee|svc|bump'])}}};
        b.handleRequest({targetDeviceID: 'd-callee', appKey: 'k'}, requester);
        b.handleRequest({targetDeviceID: 'd-callee', appKey: 'k', token: `made-up-${hex()}`}, requester);
        b.handleRequest({targetDeviceID: 'd-callee', appKey: 'k', token: tokens().issue(ENTRY(16))}, requester);
        await sleep(20);
        assert.deepStrictEqual(denied.map((m) => m.errCode), ['CALL_TOKEN_INVALID', 'CALL_TOKEN_INVALID', 'CALL_TOKEN_INVALID'], JSON.stringify(denied));
        assert.strictEqual(lookups, 0, 'a lookup ran for a request with no valid token');
        b.handleRequest({targetDeviceID: 'd-callee', appKey: 'k', token: tokens().issue(ENTRY(15))}, requester);
        await sleep(20);
        assert.strictEqual(lookups, 1, 'the request with the worker\'s own token did not reach the lookup');
        // R2-1 Task 4: a device the module declared nothing on is refused
        // CTX_CALL_UNDECLARED, also before any lookup
        b.handleRequest({targetDeviceID: 'd-other', appKey: 'k', token: tokens().issue(ENTRY(15))}, requester);
        await sleep(20);
        assert.strictEqual(denied[denied.length - 1].errCode, 'CTX_CALL_UNDECLARED', JSON.stringify(denied));
        assert.strictEqual(lookups, 1, 'a lookup ran for an undeclared device');
        // Task 4's review: before the verdict there is no binding: not ready;
        // and a request for the worker's own device is PEER_SELF_TARGET first
        const early = {workerId: 17, sendPeerChannelDenyToChild: (m) => denied.push(m)};
        b.handleRequest({targetDeviceID: 'd-callee', appKey: 'k', token: tokens().issue(ENTRY(17))}, early);
        b.dm = {deviceMap: {'d-mine': requester}};
        b.handleRequest({targetDeviceID: 'd-mine', appKey: 'k', token: tokens().issue(ENTRY(15))}, requester);
        await sleep(20);
        assert.deepStrictEqual(denied.slice(-2).map((m) => m.errCode), ['CTX_CALL_NOT_READY', 'PEER_SELF_TARGET'], JSON.stringify(denied));
        assert.strictEqual(lookups, 1);
      } finally {
        if (savedAuth != null) require.cache[authPath] = savedAuth; else delete require.cache[authPath];
        delete require.cache[require.resolve('../../lib/peer-channel-broker')];
      }
    });
  });

  // The binding a worker's proxy keeps for its calling device (ENTRY's
  // 'd-callee'), declaring calls on these devices.
  const DECLARING = (...devices) => ({'d-callee': {identity: 'i', module: 'token-forge', targets: new Set(devices.map((d) => `${d}|svc|act`))}});

  describe('the device query', () => {
    // R2-1 Task 5 (#148, 2): the query answers a spec only for a device the
    // calling module declared calls on; any other device, present or not, is
    // refused as its hop would be, and before the verdict it is not ready.
    it('(#148) answers a spec only for a declared device: anything else CTX_CALL_UNDECLARED, present or not; before the verdict CTX_CALL_NOT_READY', async () => {
      const DeviceManager = require('../../lib/device-manager');
      cli.setOptions({workerThread: true, peerChannelAuthLookupTimeoutMs: 200});
      try {
        const replies = [];
        const wm = {workerId: 35, sendDeviceQueryReplyToChild: (m) => replies.push(m), bindings: DECLARING('d-declared')};
        const present = {allDevicesLoaded: true, ensureDeviceState: (d, cb) => cb(null, {deviceList: {[d]: {device: {friendlyName: d}}}}),
          missingDeviceErrorForHop: () => new Error('not reached'), notifyDeviceLoad: {}};
        const missing = Object.assign({}, present, {ensureDeviceState: (d, cb) => cb(new Error('missing'), null)});
        DeviceManager.prototype.queryDeviceForChild.call(present, 'd-declared', 'q1', wm, {token: tokens().issue(ENTRY(35))});
        DeviceManager.prototype.queryDeviceForChild.call(present, 'd-other', 'q2', wm, {token: tokens().issue(ENTRY(35))});
        DeviceManager.prototype.queryDeviceForChild.call(missing, 'd-gone', 'q3', wm, {token: tokens().issue(ENTRY(35))});
        const early = {workerId: 36, sendDeviceQueryReplyToChild: (m) => replies.push(m)};
        DeviceManager.prototype.queryDeviceForChild.call(present, 'd-declared', 'q4', early, {token: tokens().issue(ENTRY(36))});
        await sleep(50);
        assert.deepStrictEqual(replies.map((r) => [r.msgID, r.spec != null, r.errCode]).sort(),
          [['q1', true, undefined], ['q2', false, 'CTX_CALL_UNDECLARED'], ['q3', false, 'CTX_CALL_UNDECLARED'], ['q4', false, 'CTX_CALL_NOT_READY']], JSON.stringify(replies));
      } finally {
        cli.setOptions({workerThread: false});
      }
    });

    it('a hung auth lookup gets the generic answer within the lookup deadline; the query is not left pending', async () => {
      const DeviceManager = require('../../lib/device-manager');
      const authPath = require.resolve('../../lib/user-auth');
      const savedAuth = require.cache[authPath];
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true, exports: () => {}};   // never answers
      try {
        cli.setOptions({workerThread: true, peerChannelAuthLookupTimeoutMs: 200});
        const replies = [];
        const wm = {workerId: 31, sendDeviceQueryReplyToChild: (m) => replies.push(m), bindings: DECLARING('d-gone')};
        const self = {allDevicesLoaded: true, ensureDeviceState: (d, cb) => cb(new Error('missing'), null), missingDeviceErrorForHop: () => new Error('not reached'), notifyDeviceLoad: {}};
        const token = tokens().issue(ENTRY(31));
        const started = Date.now();
        DeviceManager.prototype.queryDeviceForChild.call(self, 'd-gone', 'q1', wm, {token: token, appKey: 'granted'});
        while (replies.length === 0 && Date.now() - started < 1500) await sleep(20);
        assert.strictEqual(replies.length, 1, 'no answer within 1.5 s');
        assert.ok(Date.now() - started < 1000, `answered after ${Date.now() - started} ms`);
        assert.match(String(replies[0].errMsg), /not found/i);
        assert.strictEqual(replies[0].errCode, undefined, 'the typed reason, with no lookup answer');
      } finally {
        if (savedAuth != null) require.cache[authPath] = savedAuth; else delete require.cache[authPath];
        cli.setOptions({workerThread: false});
      }
    });
  });

  // The review of #138 (5b): the device query takes the call's token too,
  // and fails closed without it: a worker message with no token, or
  // another worker's, is answered with nothing, device present or not.
  describe('the device query without a token', () => {
    it('(#138-5b) is refused CALL_TOKEN_INVALID, the device present or not', async () => {
      const DeviceManager = require('../../lib/device-manager');
      cli.setOptions({workerThread: true, peerChannelAuthLookupTimeoutMs: 200});
      try {
        const replies = [];
        const wm = {workerId: 32, sendDeviceQueryReplyToChild: (m) => replies.push(m), bindings: DECLARING('d-present')};
        const present = {allDevicesLoaded: true, ensureDeviceState: (d, cb) => cb(null, {deviceList: {[d]: {device: {friendlyName: 'present'}}}}), missingDeviceErrorForHop: () => new Error('not reached'), notifyDeviceLoad: {}};
        DeviceManager.prototype.queryDeviceForChild.call(present, 'd-present', 'q1', wm, null);
        DeviceManager.prototype.queryDeviceForChild.call(present, 'd-present', 'q2', wm, {token: `made-up-${hex()}`, appKey: 'k'});
        DeviceManager.prototype.queryDeviceForChild.call(present, 'd-present', 'q3', wm, {token: tokens().issue(ENTRY(33)), appKey: 'k'});
        DeviceManager.prototype.queryDeviceForChild.call(present, 'd-present', 'q4', wm, {token: tokens().issue(ENTRY(32)), appKey: 'k'});
        await sleep(50);
        assert.deepStrictEqual(replies.map((r) => [r.msgID, r.spec != null, r.errCode]), [['q1', false, 'CALL_TOKEN_INVALID'], ['q2', false, 'CALL_TOKEN_INVALID'], ['q3', false, 'CALL_TOKEN_INVALID'], ['q4', true, undefined]], JSON.stringify(replies));
        const missing = {allDevicesLoaded: true, ensureDeviceState: (d, cb) => cb(new Error('missing'), null), missingDeviceErrorForHop: () => new Error('not reached'), notifyDeviceLoad: {}};
        DeviceManager.prototype.queryDeviceForChild.call(missing, 'd-gone', 'q5', wm, null);
        await sleep(50);
        const r = replies.find((x) => x.msgID === 'q5');
        assert.ok(r != null && r.spec == null && r.errCode === 'CALL_TOKEN_INVALID', JSON.stringify(r));
      } finally {
        cli.setOptions({workerThread: false});
      }
    });
  });

  // #141 N1: a bill refused as late (PEER_CHANNEL_TIMEOUT) or unmatched
  // (CALL_TOKEN_INVALID) is not served, as a rate-refused one is not.
  describe('the callee\'s metered finish', () => {
    it('(#141-N1) delivers nothing on a late or unmatched bill, as on a rate-limited one', () => {
      const PeerChannel = require('../../lib/peer-channel');
      const out = [];
      for (const code of ['RATE_LIMITED', 'PEER_CHANNEL_TIMEOUT', 'CALL_TOKEN_INVALID']) {
        PeerChannel.finishMeteredHop(Object.assign(new Error('x'), {code: code}), {served: true}, null, (e, d) => out.push([code, e != null ? e.code : null, d]));
      }
      PeerChannel.finishMeteredHop(Object.assign(new Error('redis'), {code: 'SYSTEM_ERROR_USERDB_NA'}), {served: true}, null, (e, d) => out.push(['other', e != null ? e.code : null, d]));
      assert.deepStrictEqual(out, [['RATE_LIMITED', 'RATE_LIMITED', null], ['PEER_CHANNEL_TIMEOUT', 'PEER_CHANNEL_TIMEOUT', null], ['CALL_TOKEN_INVALID', 'CALL_TOKEN_INVALID', null], ['other', null, {served: true}]]);
    });
  });

  // The medium review of the fix: the channel request carries the first
  // queued call's token; that token refused, only that call fails, and the
  // next queued call asks again with its own.
  describe('a channel request denied for its token', () => {
    it('fails the call whose token it was, and asks again with the next call\'s', () => {
      const DeviceManager = require('../../lib/device-manager');
      const sent = [];
      const failed = [];
      const dm = {pendingPeerInvokes: {}, peerChannels: {}, peerDeviceWorkerMap: {}, workerMessage: {sendPeerChannelRequestToParent: (m) => sent.push(m)},
        flushPendingPeerInvokes: DeviceManager.prototype.flushPendingPeerInvokes};
      const invoke = (token) => DeviceManager.prototype.invokeActionViaPeerChannel.call(dm, 'k', 'k', 'd-callee', 'svc', 'bump', {input: {}, token: token}, (e) => failed.push(e != null ? e.code : null));
      invoke('t-dead');
      invoke('t-live');
      invoke('t-live-2');
      assert.deepStrictEqual(sent.map((m) => m.token), ['t-dead']);
      DeviceManager.prototype.onPeerChannelDeny.call(dm, {targetDeviceID: 'd-callee', errMsg: 'x', errCode: 'CALL_TOKEN_INVALID'});
      assert.deepStrictEqual(failed, ['CALL_TOKEN_INVALID'], 'the other calls failed too');
      assert.deepStrictEqual(sent.map((m) => m.token), ['t-dead', 't-live'], 'no new request with the next call\'s token');
      DeviceManager.prototype.onPeerChannelDeny.call(dm, {targetDeviceID: 'd-callee', errMsg: 'x', errCode: 'PEER_SELF_TARGET'});
      assert.deepStrictEqual(failed, ['CALL_TOKEN_INVALID', 'PEER_SELF_TARGET', 'PEER_SELF_TARGET'], 'any other denial fails every queued call');
    });
  });

  // R2-1 Task 4's review: a module's declarations are the main thread's own
  // read of its package.json at the host path, never the worker's statement;
  // and a routed hop before the verdict is not ready, not undeclared.
  describe('declarations: whose package.json, and before the verdict', () => {
    it('(T4-review) the declarations are the main thread\'s pin, not the ones the worker states', () => {
      const DeviceManager = require('../../lib/device-manager');
      const pinned = {name: 'declare-caller', countinghouse: {calls: ['token-callee/tokenCallee.bump']}};
      const wmStub = {hostModulePath: path.join(ROOT, 'test', 'fixtures', 'declare-caller'), hostPackageInfo: pinned};
      const forged = {name: 'declare-caller', countinghouse: {calls: ['token-callee/tokenCallee.tick', 'compose-callee/calleeService.double']}};
      assert.strictEqual(DeviceManager.hostPackageInfo(wmStub, forged), pinned);
      // a pin that could not be read: no declarations, whatever the worker states
      const unread = DeviceManager.hostPackageInfo(Object.assign({}, wmStub, {hostPackageInfo: null}), forged);
      assert.strictEqual(unread.countinghouse, undefined);
      assert.strictEqual(unread.name, 'declare-caller');
    });

    it('(T4-review) a routed hop before the composition verdict is CTX_CALL_NOT_READY', () => {
      const DeviceManager = require('../../lib/device-manager');
      const replies = [];
      const caller = {workerId: 61, sendActionInvokeReplyToChild: (m) => replies.push(m)};
      const token = tokens().issue(Object.assign(ENTRY(61), {deviceID: 'd-early'}));
      DeviceManager.prototype.sendInvokeActionMessageToWorker.call({deviceMap: {}}, 'k', 'k', 'd2', 'svc', 'act', {}, 'm1', caller, token);
      assert.strictEqual(replies[0].errCode, 'CTX_CALL_NOT_READY', JSON.stringify(replies));
    });
  });

  // R2-1 Task 4's review: a failed re-verification disables the binding's
  // declarations too, so the declared-target check refuses every hop; and a
  // grant that arrives without its action list grants nothing, loudly.
  describe('declarations: a disabled binding and a grant without its actions', () => {
    it('(T4-review) clearBinding leaves no identity and no targets', () => {
      const DeviceManager = require('../../lib/device-manager');
      const device = {bindings: {d1: {identity: 'k', module: 'm', targets: new Set(['d2|svc|act'])}}};
      assert.strictEqual(tokens().declaredTarget(device.bindings.d1, 'd2', 'svc', 'act'), true);
      DeviceManager.prototype.clearBinding.call({}, device, 'd1');
      assert.strictEqual(device.bindings.d1.identity, null);
      assert.strictEqual(tokens().declaredTarget(device.bindings.d1, 'd2', 'svc', 'act'), false, 'a disabled binding still allowed its old targets');
    });

    it('(T4-review) a grant without its action list grants no action, and says so', () => {
      const DeviceManager = require('../../lib/device-manager');
      const lines = [];
      const savedE = LOG.E;
      LOG.E = (e) => lines.push(String(e && e.message ? e.message : e));
      try {
        const allowedDevices = new Map();
        DeviceManager.prototype.onPeerChannelAllow.call({peerChannels: {7: {allowedDevices}}}, {callerWorkerId: 7, deviceID: 'd9'});
        assert.deepStrictEqual([...allowedDevices.get('d9')], []);
        assert.ok(lines.some((l) => /no declared actions/.test(l)), JSON.stringify(lines));
      } finally {
        LOG.E = savedE;
      }
    });
  });

  // The review of #138 (3): a token lives as long as its call, and no
  // longer: a call's session timeout ends the sync token, a run's timeout
  // the job token (which used to live 25 h whatever the run's timeout, and
  // to die mid-run past it).
  describe('the token bounds of a call and of a run', () => {
    const DeviceManager = require('../../lib/device-manager');
    const device = (workerId, sent) => ({workerId: workerId, bindings: {}, deviceList: {}, sendInvokeActionMessage: (m) => sent.push(m)});   // never answers
    afterEach(() => cli.setOptions({workerThread: false}));

    it('(#138-3) a call\'s token is dropped when its session times out', async () => {
      cli.setOptions({workerThread: true, requestTimeout: 0.1});   // seconds, as the CLI takes it: 100 ms
      const sent = [];
      const session = {appKey: `caller-${hex()}`, callback: () => {}};
      session.setDeviceTimer = (dev, cb) => cb.call(session, null, dev, null);
      DeviceManager.prototype.invokeAction.call({}, device(41, sent), 'd-41', 'svc', 'act', {input: {}}, session);
      assert.strictEqual(sent.length, 1);
      const token = sent[0].args.token;
      assert.notStrictEqual(tokens().resolve(token, {workerId: 41}), null);
      await sleep(160);
      assert.strictEqual(tokens().resolve(token, {workerId: 41}), null, 'the token outlived the session');
    });

    it('(#138-3) a run\'s token is dropped at the run\'s timeout, and lives as long as a run that has none', async () => {
      cli.setOptions({workerThread: true, requestTimeout: 30});
      const sent = [];
      const dm = {};
      DeviceManager.prototype.invokeJobs.call(dm, device(42, sent), 'd-42', 'svc', 'act', {}, 'job-1', () => {}, {ownerKey: `owner-${hex()}`, timeoutMs: 100});
      DeviceManager.prototype.invokeJobs.call(dm, device(42, sent), 'd-42', 'svc', 'act', {}, 'job-2', () => {}, {ownerKey: `owner-${hex()}`});
      assert.strictEqual(sent.length, 2);
      const [bounded, open] = sent.map((m) => m.args.token);
      assert.ok(!('timeoutMs' in sent[0].args) && !('ownerKey' in sent[0].args), 'the run\'s bookkeeping was sent to the worker');
      assert.notStrictEqual(tokens().resolve(bounded, {workerId: 42}), null);
      await sleep(160);
      assert.strictEqual(tokens().resolve(bounded, {workerId: 42}), null, 'the token outlived the run\'s timeout');
      const o = tokens().resolve(open, {workerId: 42});
      assert.ok(o != null && o.expires === Infinity, `a run with no timeout has a token that ends: ${o != null ? o.expires - Date.now() : null}`);
      tokens().drop(open);
    });
  });

  // The review of #138 (9): the unknown-key answer named the key.
  describe('SYSTEM_ERROR_UNKNOWN_USER', () => {
    it('(#138-9) names no key, from the file provider', async () => {
      const FileAuthProvider = require('../../lib/auth/file-provider');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-18-unknown-'));
      try {
        fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({[`known-${hex()}`]: {userName: 'known', devices: ['*']}}));
        const provider = new FileAuthProvider({configPath: path.join(dir, 'auth.json')});
        await new Promise((resolve, reject) => provider.reload((e) => (e ? reject(e) : resolve())));
        const key = `unknown-${hex()}`;
        const result = await new Promise((resolve, reject) => provider.authenticate(key, null, null, null, (e, r) => (e ? reject(e) : resolve(r))));
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.err.code, 'SYSTEM_ERROR_UNKNOWN_USER');
        assert.ok(!String(result.err.message).includes(key), `the key is in the message: ${result.err.message}`);
      } finally {
        fs.rmSync(dir, {recursive: true, force: true});
      }
    });
  });

  describe('the broker: the grant re-check', () => {
    // R2-1 Task 4's review: grants are keyed by the identity's id, and two
    // keys of one identity share the record; the re-check asks for every
    // key, so revoking either closes the channel.
    it('(T4-review) the channel open carries no key to the callee worker', () => {
      cli.setOptions({workerThread: true, peerChannelAuthRecheckSeconds: 0});   // no re-check timer left behind
      try {
        const PeerChannelBroker = require('../../lib/peer-channel-broker');
        const opened = [];
        const callee = {workerId: 72, sendPeerChannelOpenToChild: (m) => opened.push(m)};
        const caller = {workerId: 71, sendPeerChannelGrantToChild: () => {}};
        new PeerChannelBroker({deviceMap: {}}).grant('d', `caller-key-${hex()}`, caller, callee, ['svc|act']);
        assert.strictEqual(opened.length, 1);
        assert.ok(!('appKey' in opened[0]), `a key crossed to the callee: ${JSON.stringify(opened[0])}`);
      } finally {
        cli.setOptions({workerThread: false});
      }
    });

    it('(T4-review) two keys of one identity on a pair: revoking the first closes the channel', async () => {
      const authPath = require.resolve('../../lib/user-auth');
      const idPath = require.resolve('../../lib/identity');
      const brokerPath = require.resolve('../../lib/peer-channel-broker');
      const savedAuth = require.cache[authPath];
      const savedId = require.cache[idPath];
      const revoked = new Set();
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
        exports: (a, b, deviceID, appKey, c, d, localCB, cb) => setImmediate(() => cb(revoked.has(appKey) ? Object.assign(new Error('revoked'), {code: 'USER_HAS_NO_DEVICE'}) : null))};
      require.cache[idPath] = {id: idPath, filename: idPath, loaded: true, exports: Object.assign({}, require('../../lib/identity'), {idForKey: () => 'u_same'})};
      delete require.cache[brokerPath];
      try {
        cli.setOptions({workerThread: true, peerChannelAuthRecheckSeconds: 0, peerChannelAuthLookupTimeoutMs: 500});
        const PeerChannelBroker = require('../../lib/peer-channel-broker');
        const sent = [];
        const callee = {workerId: 52, ended: null, unloading: false, sendPeerChannelOpenToChild: () => {}, sendPeerChannelAllowToChild: (m, cb) => cb(null), sendPeerInvalidateToChild: () => {}};
        const caller = {workerId: 51, ended: null, unloading: false, sendPeerChannelGrantToChild: (m) => sent.push(m), sendPeerInvalidateToChild: () => {}};
        const b = new PeerChannelBroker({deviceMap: {d: callee}});
        b.grant('d', 'k1', caller, callee, ['svc|act']);
        b.grant('d', 'k2', caller, callee, ['svc|act']);
        const grants = b.channelRegistry['51:52'].grants;
        assert.strictEqual(Object.keys(grants).length, 1, 'one record per identity and device');
        revoked.add('k1');
        b.recheckGrants();
        await sleep(100);
        assert.strictEqual(b.channelRegistry['51:52'], undefined, 'the channel stayed open after the first key was revoked');
      } finally {
        if (savedAuth != null) require.cache[authPath] = savedAuth; else delete require.cache[authPath];
        if (savedId != null) require.cache[idPath] = savedId; else delete require.cache[idPath];
        delete require.cache[brokerPath];
        cli.setOptions({workerThread: false});
      }
    });

    it('(4) a hung auth lookup times out and closes the channel; later re-checks still run', async () => {
      const authPath = require.resolve('../../lib/user-auth');
      const brokerPath = require.resolve('../../lib/peer-channel-broker');
      const savedAuth = require.cache[authPath];
      let lookups = 0;
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true, exports: () => { lookups++; }};   // never answers
      delete require.cache[brokerPath];
      try {
        cli.setOptions({workerThread: true, peerChannelAuthRecheckSeconds: 0, peerChannelAuthLookupTimeoutMs: 200});
        const PeerChannelBroker = require('../../lib/peer-channel-broker');
        const broker = new PeerChannelBroker({deviceMap: {}});
        const closed = [];
        broker.closeRevoked = (pairKey) => { closed.push(pairKey); delete broker.channelRegistry[pairKey]; };
        broker.channelRegistry['21:22'] = {callerWM: {workerId: 21}, calleeWM: {workerId: 22}, grants: {g: {appKey: 'k', deviceID: 'd'}}};
        broker.recheckGrants();
        await sleep(400);
        assert.deepStrictEqual(closed, ['21:22'], 'the channel behind a hung lookup stayed open');
        assert.strictEqual(broker.recheckInFlight, 0, 'a hung lookup left a re-check in flight');
        broker.channelRegistry['23:24'] = {callerWM: {workerId: 23}, calleeWM: {workerId: 24}, grants: {g: {appKey: 'k', deviceID: 'd'}}};
        const before = lookups;
        broker.recheckGrants();
        assert.ok(lookups > before, 'the next re-check did not run');
      } finally {
        if (savedAuth != null) require.cache[authPath] = savedAuth; else delete require.cache[authPath];
        delete require.cache[brokerPath];
        cli.setOptions({workerThread: false});
      }
    });
  });
});

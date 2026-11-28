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
const {testPort, redisConnectionFor} = require('../helpers/test-env');
const {prefixFor} = require('../helpers/job-queue');

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
      }), {mode: 0o600});
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
    // The prober's hops authorize as its binding (R2-1 Task 5: no `as`),
    // which is granted worker-end; an identity without the grant is
    // composition 16's, with the prober bound to it.
    it('(g) a client built after the unload: the identity granted the device gets MODULE_UNLOADED through the device query', async () => {
      const observe = async () => JSON.parse((await mcpCall(hopPath.port, KEYS.admin, 'hop_prober_probeservice_observe', {deviceID: WORKER_END})).content[0].text);
      await waitFor(async () => (await observe()).code == null, 20000, 'the prober to reach worker-end');
      assert.strictEqual((await post(hopPath.port, KEYS.admin, '/unload-module', {name: 'worker-end'})).status, 200);
      const granted = await observe();
      assert.strictEqual(granted.code, 'MODULE_UNLOADED', JSON.stringify(granted));
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
    }), {mode: 0o600});
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
    }), {mode: 0o600});
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

  it('(#138-2b, #112) a worker reads the request timer and the job durations in milliseconds, as the main thread gave them', async () => {
    server = await start(['--requestTimeout', '2', '--jobTimeout', '120', '--jobResultTtl', '60', '--directPeerChannels']);
    const out = await via({marker: 'probe', probe: 'requestTimeout'});
    assert.deepStrictEqual([out.requestTimeout, out.jobTimeout, out.jobResultTtl], [2000, 120000, 60000], JSON.stringify(out));
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
    {[ADMIN]: {userName: `admin-${hex()}`, devices: ['*'], admin: true}}, alice ? {[ALICE]: {userName: `alice-${hex()}`, devices: [DEVICE]}} : {})), {mode: 0o600});
  const reload = () => request(URL).post('/reload-auth').set('X-CH-Key', ADMIN).send({});
  const addJob = (name, opts, note) => request(URL).post(`/devices/${DEVICE}/add-job`).set('X-CH-Key', ALICE)
    .send({serviceID: SERVICE, actionName: 'whoami', opts: Object.assign({name: name}, opts), input: {note: note}});
  const balance = () => request(URL).get('/balance').set('X-CH-Key', ALICE).then((r) => r.body.balance);
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
    // the server's Redis (test/helpers/test-env.js)
    queue = new Queue('job-queue', {prefix: prefixFor(path.join(base, 'store')), connection: redisConnectionFor(11)});   // this server's own queue (B-j1)
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

  // (a job stored with an apiKey only, and a scheduler under the old
  // sha256-prefixed id, are no longer read: a job names its owner by id
  // alone, and there are no stored jobs from before -- B-meter-keys (2))

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
//     invokeId, token, deviceID, serviceID, actionName, epoch, inputBytes}
//     for one peer invoke, where `channel` is the broker's pair key
//     `${callerWorkerId}:${calleeWorkerId}`; the target and the bytes are the
//     caller's, held by the main thread (lean worker step 4, the review of
//     #202); a refusal goes to fromWM.sendPeerAnnounceRefusedToChild;
//   - handleMeteringRequest(data, msgID, calleeWM), before the handler, with
//     data {channel, invokeId} (any target the callee adds is ignored):
//     answered through calleeWM.sendPeerMeteringReplyToChild({msgID, errMsg,
//     errCode, token, target, inputBytes}); a refusal has errCode
//     CALL_TOKEN_INVALID and means "do not serve"; a match carries the
//     callee's own token and the announced target, and bills nothing yet;
//   - handleBillRequest({token, outputBytes}, msgID, calleeWM), after the
//     handler succeeded: bills the announced call's caller, once, and
//     delivers the result to the caller (callerWM.sendPeerResultToChild); a
//     token it does not know is refused, to the callee and to the caller;
//   - the module-spec checks are stubbed here (a spec that passes); sandbox
//     49 runs them for real;
//   - PEER_ANNOUNCE_WAIT_MS = 1000; 64 held requests per channel at most;
//   - options.peerChannelAuthLookupTimeoutMs bounds one re-check lookup;
//   - the balance deduction's deadline is about 500 ms.
describe('composition 18: the token store and the peer path\'s checks (unit)', function() {
  this.timeout(20000);
  const cli = require('../../lib/cli-options');
  const CHUtil = require('../../lib/countinghouse-util');
  const LOG = require('../../lib/logger');
  require('../../lib/logger').createLogger();
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
    let broker = null, caller = null, callee = null, billed = null, savedCi = null, savedSpec = null;
    const moduleSpec = require('../../lib/module-spec');
    const {serialize, toArrayBuffer, decode} = require('../../lib/serialized-result');
    const bytes = (v) => toArrayBuffer(serialize(v));
    const wm = (workerId) => ({workerId: workerId, ended: null, replies: [], refusals: [], results: [], moduleSpec: {},
      sendPeerMeteringReplyToChild(m) { this.replies.push(m); },
      sendPeerAnnounceRefusedToChild(m) { this.refusals.push(m); },
      sendPeerResultToChild(m) { this.results.push(m); }});
    const pair = () => `${caller.workerId}:${callee.workerId}`;
    const EPOCH = 'e1';
    const TARGET = {deviceID: 'd-callee', serviceID: 'svc', actionName: 'bump'};
    const meter = (invokeId, msgID) => broker.handleMeteringRequest({channel: pair(), invokeId: invokeId}, msgID, callee);
    const announce = (invokeId, token, from, target) => broker.handleAnnouncement(Object.assign({channel: pair(), invokeId: invokeId, token: token, epoch: EPOCH,
      inputBytes: bytes({input: {}})}, target || TARGET), from || caller);
    const bill = (token, msgID) => broker.handleBillRequest({token: token, outputBytes: bytes({output: {ok: true}})}, msgID, callee);
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
      broker = new PeerChannelBroker({deviceMap: {'d-callee': callee}});
      broker.channelRegistry[pair()] = {callerWM: caller, calleeWM: callee, grants: {}};
      // a spec held for every worker here, which passes what it is given
      // (the stalls, refusals and caps of the real checks: sandbox 49)
      savedSpec = {checkInput: moduleSpec.checkInput, validateSerialized: moduleSpec.validateSerialized};
      moduleSpec.checkInput = (own, deviceID, serviceID, actionName) => (own == null ? null : {key: 'k', serviceID: serviceID, actionName: actionName});
      moduleSpec.validateSerialized = (checked, which, buffer) => Promise.resolve({refused: null, buffer: buffer});
    });

    // (a cached ctx.serviceClient hop makes no device query: its announcement
    // is the main thread's one record that the call went ahead)
    it('an announced hop counts as a call that went through: the caller\'s kept refusal clears', () => {
      const t = tokens().issue(ENTRY(caller.workerId));
      tokens().noteRefused(t, 'DEVICE_NOT_FOUND', 'module', caller.workerId);
      assert.deepStrictEqual(tokens().refusedOf(t), {code: 'DEVICE_NOT_FOUND', to: 'module'});
      announce(71, t);
      assert.strictEqual(caller.refusals.length, 0, JSON.stringify(caller.refusals));
      assert.strictEqual(tokens().refusedOf(t), null);
    });
    afterEach(() => { CHUtil.ci = savedCi; Object.assign(moduleSpec, savedSpec); });

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

    // a billed hop runs only while its charge can be recorded (the owner's
    // decision, 11-27): refused before any token is issued or handler runs
    it('a peer hop whose charge can\'t be recorded now is refused with the ledger\'s code: no token, nothing billed; once it can, served', async () => {
      const {CountinghouseError} = require('../../lib/countinghouse-error');
      let recordable = false;
      CHUtil.ci.chargeable = (key, cb) => setImmediate(cb, recordable ? null : new CountinghouseError('LEDGER_UNREACHABLE'));
      // (waited for on the reply itself, at most 5 s)
      const answered = async (msgID) => { const end = Date.now() + 5000; while (replyTo(msgID) == null && Date.now() < end) await sleep(10); };
      announce(21, tokens().issue(ENTRY(caller.workerId)));
      meter(21, 'm21');
      await answered('m21');
      const r = replyTo('m21');
      assert.ok(r != null && r.errCode === 'LEDGER_UNREACHABLE' && r.token == null, JSON.stringify(callee.replies));
      assert.deepStrictEqual(billed, []);
      recordable = true;
      announce(22, tokens().issue(ENTRY(caller.workerId)));
      meter(22, 'm22');
      await answered('m22');
      assert.ok(served('m22'), JSON.stringify(callee.replies));
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
    it('(T4-review) an announcement for an action the caller did not declare is refused CTX_CALL_UNDECLARED, and nothing matches it', async () => {
      announce(30, tokens().issue(ENTRY(caller.workerId)), caller, {deviceID: 'd-callee', serviceID: 'svc', actionName: 'tick'});
      assert.deepStrictEqual(caller.refusals.map((r) => [r.invokeId, r.errCode, r.epoch]), [[30, 'CTX_CALL_UNDECLARED', EPOCH]]);
      meter(30, 'm30');
      await sleep(1100);
      assert.ok(refused(replyTo('m30')), JSON.stringify(replyTo('m30')));
      assert.strictEqual(broker.unbilled.size, 0);
    });

    // The review of #202 (1): the target is the caller's statement, checked
    // when it is announced; the callee's spec must be held, or nothing runs.
    it('(#202-1) an announcement naming its target in other than strings, or a device the channel\'s callee does not host, is refused; nothing is held', () => {
      announce(40, tokens().issue(ENTRY(caller.workerId)), caller, {deviceID: ['d-callee'], serviceID: 'svc', actionName: 'bump'});
      // declared, but hosted by no worker, then by a worker not this channel's callee
      announce(41, tokens().issue(ENTRY(caller.workerId)), caller, {deviceID: 'd-other', serviceID: 'svc', actionName: 'bump'});
      broker.dm.deviceMap['d-other'] = wm(15);
      announce(42, tokens().issue(ENTRY(caller.workerId)), caller, {deviceID: 'd-other', serviceID: 'svc', actionName: 'bump'});
      // undeclared: refused by the declarations first, as on the routed path
      announce(43, tokens().issue(ENTRY(caller.workerId)), caller, {deviceID: 'd-elsewhere', serviceID: 'svc', actionName: 'bump'});
      assert.deepStrictEqual(caller.refusals.map((r) => [r.invokeId, r.errCode]),
        [[40, 'DEVICE_INVOKE_EXCEPTION'], [41, 'PEER_NOT_GRANTED'], [42, 'PEER_NOT_GRANTED'], [43, 'CTX_CALL_UNDECLARED']]);
      assert.strictEqual(broker.announced.size, 0);
      assert.strictEqual(broker.announcedBytes, 0);
    });

    it('(#202-1) a callee whose spec the main thread does not hold is refused: no token, nothing run, nothing billed', async () => {
      callee.moduleSpec = null;
      announce(49, tokens().issue(ENTRY(caller.workerId)));
      meter(49, 'm49');
      await sleep(50);
      const r = replyTo('m49');
      assert.ok(r != null && r.errCode === 'DEVICE_INVOKE_EXCEPTION' && typeof(r.token) !== 'string', JSON.stringify(r));
      assert.strictEqual(broker.unbilled.size, 0);
      assert.deepStrictEqual(billed, []);
    });

    // (2): the callee cannot restate the action, nor swap the input bytes.
    it('(#202-2) the match hands the callee the caller\'s target and bytes; a target or bytes in its request are ignored', async () => {
      const seen = [];
      moduleSpec.checkInput = (own, deviceID, serviceID, actionName) => { seen.push(`${deviceID}|${serviceID}|${actionName}`); return {key: 'k', serviceID, actionName}; };
      const e = ENTRY(caller.workerId);
      broker.handleAnnouncement(Object.assign({channel: pair(), invokeId: 44, token: tokens().issue(e), epoch: EPOCH, inputBytes: bytes({input: {v: 'caller'}})}, TARGET), caller);
      broker.handleMeteringRequest({channel: pair(), invokeId: 44, deviceID: 'd-callee', serviceID: 'svc', actionName: 'loose', inputBytes: bytes({input: {v: 'callee'}})}, 'm44', callee);
      await sleep(50);
      const r = replyTo('m44');
      assert.ok(served('m44'), JSON.stringify(r));
      assert.deepStrictEqual(r.target, TARGET);
      assert.deepStrictEqual(decode(r.inputBytes), {input: {v: 'caller'}});
      assert.deepStrictEqual(seen, ['d-callee|svc|bump'], 'checked against the callee\'s target');
      bill(r.token, 'b44');
      await sleep(50);
      assert.deepStrictEqual(billed, [e.billingKey]);
    });

    // (3): what the match's awaits may have changed is checked again.
    it('(#202-3) a channel revoked, or the deadline passed, while the input is checked: no token, nothing billed', async () => {
      moduleSpec.validateSerialized = (checked, which, buffer) => new Promise((resolve) => setTimeout(() => resolve({refused: null, buffer: buffer}), 80));
      announce(45, tokens().issue(ENTRY(caller.workerId)));
      meter(45, 'm45');
      await sleep(20);
      const entry = broker.channelRegistry[pair()];
      delete broker.channelRegistry[pair()];
      await sleep(120);
      assert.ok(refused(replyTo('m45')), `served after its channel went: ${JSON.stringify(replyTo('m45'))}`);
      broker.channelRegistry[pair()] = entry;

      cli.setOptions({workerThread: true, mcpToolCallCost: 1, requestTimeout: 0.06});
      announce(46, tokens().issue(ENTRY(caller.workerId)));
      meter(46, 'm46');
      await sleep(150);
      const r = replyTo('m46');
      assert.ok(r != null && r.errCode === 'PEER_CHANNEL_TIMEOUT' && typeof(r.token) !== 'string', JSON.stringify(r));
      assert.strictEqual(broker.unbilled.size, 0);
      assert.deepStrictEqual(billed, []);
    });

    it('(#202-3) the result is delivered to the caller with the grant\'s epoch', async () => {
      announce(47, tokens().issue(ENTRY(caller.workerId)));
      meter(47, 'm47');
      await sleep(50);
      bill(replyTo('m47').token, 'b47');
      await sleep(50);
      assert.deepStrictEqual(caller.results.map((m) => [m.invokeId, m.epoch, decode(m.dataBuffer)]), [[47, EPOCH, {output: {ok: true}}]]);
    });

    // (4), as round 3 has it: a bill the broker cannot match names no grant
    // of the caller's it can trust, so only the callee is answered; the
    // caller's own timer frees the slot (sandbox 49).
    it('(#202-4) a bill the broker cannot match is refused to the callee; the caller is not told (it could be another grant\'s id)', async () => {
      announce(48, tokens().issue(ENTRY(caller.workerId)));
      broker.handleBillRequest({token: `made-up-${hex()}`, channel: pair(), invokeId: 48, outputBytes: bytes({output: 1})}, 'b48', callee);
      assert.ok(refused(replyTo('b48')), JSON.stringify(replyTo('b48')));
      assert.deepStrictEqual(caller.results, []);
    });

    // Round 3 (1): the held input bytes are bounded per caller worker, so one
    // caller's unmatched announcements never refuse another's; a caller's
    // announcements whose call has ended are released before it is refused.
    it('(#202-r3-1) one caller over its share of held bytes is refused RATE_LIMITED; another caller is not; an ended call\'s bytes are released', () => {
      cli.setOptions({workerThread: true, mcpToolCallCost: 1, maxOutputBytes: 4 * 1024 * 1024});
      const big = () => bytes({input: {s: 'x'.repeat(4 * 1024 * 1024 - 64)}});
      const t = [];
      for (let i = 0; i < 5; i++) {
        t.push(tokens().issue(ENTRY(caller.workerId)));
        broker.handleAnnouncement(Object.assign({channel: pair(), invokeId: 60 + i, token: t[i], epoch: EPOCH, inputBytes: big()}, TARGET), caller);
      }
      assert.deepStrictEqual(caller.refusals.map((r) => [r.invokeId, r.errCode]), [[64, 'RATE_LIMITED']], 'the share is 16 MiB: four held, the fifth refused');
      // another caller worker, on its own channel to the same callee
      const other = wm(17);
      other.bindings = caller.bindings;
      broker.channelRegistry[`${other.workerId}:${callee.workerId}`] = {callerWM: other, calleeWM: callee, grants: {}};
      broker.handleAnnouncement(Object.assign({channel: `${other.workerId}:${callee.workerId}`, invokeId: 1, token: tokens().issue(ENTRY(other.workerId)),
        epoch: EPOCH, inputBytes: big()}, TARGET), other);
      assert.deepStrictEqual(other.refusals, [], 'another caller was refused by the first one\'s bytes');
      // the first caller's calls end: their bytes go when it next announces
      t.forEach((x) => tokens().drop(x));
      broker.handleAnnouncement(Object.assign({channel: pair(), invokeId: 70, token: tokens().issue(ENTRY(caller.workerId)), epoch: EPOCH, inputBytes: big()}, TARGET), caller);
      assert.strictEqual(caller.refusals.length, 1, 'an ended call\'s bytes were still held');
    });

    // Round 3's review: a held invoke past its deadline is released when its
    // caller next needs the room, not only at the 60 s sweep, so it cannot
    // lock the caller out of its own share meanwhile.
    it('(#202-r3-1) a caller whose held invokes passed their deadline holds a new one at once, before any sweep', async () => {
      cli.setOptions({workerThread: true, mcpToolCallCost: 1, maxOutputBytes: 4 * 1024 * 1024});
      const big = () => bytes({input: {s: 'x'.repeat(4 * 1024 * 1024 - 64)}});
      for (let i = 0; i < 4; i++) {
        broker.handleAnnouncement(Object.assign({channel: pair(), invokeId: 80 + i, token: tokens().issue(ENTRY(caller.workerId)), epoch: EPOCH,
          inputBytes: big(), timeLeftMs: 30}, TARGET), caller);
      }
      assert.deepStrictEqual(caller.refusals, [], 'four fill the 16 MiB share');
      await sleep(60);   // past their deadline; their tokens still live, and no sweep has run
      broker.handleAnnouncement(Object.assign({channel: pair(), invokeId: 84, token: tokens().issue(ENTRY(caller.workerId)), epoch: EPOCH,
        inputBytes: big()}, TARGET), caller);
      assert.deepStrictEqual(caller.refusals, [], 'the caller was locked out of its own share by invokes past their deadline');
      assert.ok(broker.announced.has(`${pair()}/84`));
    });

    // The reviewer's finding after #283: the total is 128 MiB (at a cap of
    // 16 MiB, four callers at their 32 MiB share fill it; here, at 4 MiB,
    // eight at 16 MiB). When it was full, only the announcing caller's own
    // ended hops were released: every other caller's ended or expired ones
    // stayed counted until the 60 s sweep, and everyone's direct hops were
    // refused meanwhile.
    describe('(#283 follow-up) the total held by every caller', () => {
      const MIB4 = 4 * 1024 * 1024;
      let one;
      let others;
      let held;
      // eight other caller workers, each with its share (four 4 MiB hops) held: the 128 MiB total
      const fill = (extra = {}) => {
        cli.setOptions({workerThread: true, mcpToolCallCost: 1, maxOutputBytes: MIB4});
        // one buffer for them all: the broker holds a reference and counts its length
        one = bytes({input: {s: 'x'.repeat(MIB4 - 64)}});
        others = [];
        held = [];
        for (let w = 0; w < 8; w++) {
          const other = wm(40 + w);
          other.bindings = caller.bindings;
          const channel = `${other.workerId}:${callee.workerId}`;
          broker.channelRegistry[channel] = {callerWM: other, calleeWM: callee, grants: {}};
          others.push(other);
          for (let i = 0; i < 4; i++) {
            const token = tokens().issue(ENTRY(other.workerId));
            held.push(token);
            broker.handleAnnouncement(Object.assign({channel, invokeId: 100 + i, token, epoch: EPOCH, inputBytes: one}, extra, TARGET), other);
          }
        }
        assert.deepStrictEqual(others.flatMap((o) => o.refusals), [], 'each within its own share');
        assert.strictEqual(broker.announcedBytes, 8 * 4 * one.byteLength);
      };
      const newcomer = (invokeId) => broker.handleAnnouncement(Object.assign({channel: pair(), invokeId, token: tokens().issue(ENTRY(caller.workerId)),
        epoch: EPOCH, inputBytes: one}, TARGET), caller);

      it('full of live hops: a newcomer is refused RATE_LIMITED, and nothing another caller holds is released', () => {
        fill();
        newcomer(200);
        assert.deepStrictEqual(caller.refusals.map((r) => [r.invokeId, r.errCode]), [[200, 'RATE_LIMITED']]);
        assert.strictEqual(broker.announced.size, 32, 'every live hop still held');
      });

      it('full of hops whose calls have ended: they are released for the newcomer, before any sweep', () => {
        fill();
        held.forEach((token) => tokens().drop(token));
        newcomer(201);
        assert.deepStrictEqual(caller.refusals, [], 'refused by other callers\' ended hops');
        assert.ok(broker.announced.has(`${pair()}/201`));
        assert.strictEqual(broker.announced.size, 1, 'the ended ones are gone');
        assert.strictEqual(broker.announcedBytes, one.byteLength);
      });

      it('full of hops past their deadline: released for the newcomer too', async () => {
        fill({timeLeftMs: 30});
        await sleep(60);   // their tokens still live, and no sweep has run
        newcomer(202);
        assert.deepStrictEqual(caller.refusals, []);
        assert.strictEqual(broker.announced.size, 1);
      });

      // The walk is over every held hop, so a caller refused over and over
      // buys at most one in 100 ms -- for itself. Another caller's first
      // refusal walks at once: one caller's attempts never make the others
      // wait for hops that have ended meanwhile. On the broker's own
      // monotonic clock, set here.
      it('a caller refused over and over walks every held hop at most once in 100 ms; another caller is not held back by it', () => {
        fill();
        let clock = 5000;
        broker.monotonicMs = () => clock;
        let walks = 0;
        const releaseEnded = broker.releaseEnded.bind(broker);
        broker.releaseEnded = (workerId) => { if (workerId == null) walks += 1; return releaseEnded(workerId); };
        for (let i = 0; i < 5; i++) newcomer(210 + i);
        assert.strictEqual(caller.refusals.length, 5);
        assert.strictEqual(walks, 1, 'the first of the five');
        clock += 99;
        newcomer(215);
        assert.strictEqual(walks, 1, 'still inside its 100 ms');
        // every held hop's call ends now; the refused caller is inside its
        // window, but another caller's hop walks, and is held
        held.forEach((token) => tokens().drop(token));
        const late = wm(60);
        late.bindings = caller.bindings;
        const channel = `${late.workerId}:${callee.workerId}`;
        broker.channelRegistry[channel] = {callerWM: late, calleeWM: callee, grants: {}};
        broker.handleAnnouncement(Object.assign({channel, invokeId: 1, token: tokens().issue(ENTRY(late.workerId)), epoch: EPOCH, inputBytes: one}, TARGET), late);
        assert.deepStrictEqual(late.refusals, [], 'held back by another caller\'s refused attempts');
        assert.strictEqual(walks, 2);
        // and the first caller's own window passes
        clock += 2;
        newcomer(216);
        assert.strictEqual(caller.refusals.length, 6, 'the six before; this one is held');
      });

      it('a caller over its own share AND the total walks the held hops once, not twice', () => {
        fill();
        let scans = 0;
        const releaseEnded = broker.releaseEnded.bind(broker);
        broker.releaseEnded = (workerId) => { scans += 1; return releaseEnded(workerId); };
        // one of the eight, already at its share, announces again
        const first = others[0];
        broker.handleAnnouncement(Object.assign({channel: `${first.workerId}:${callee.workerId}`, invokeId: 150, token: tokens().issue(ENTRY(first.workerId)),
          epoch: EPOCH, inputBytes: one}, TARGET), first);
        assert.strictEqual(first.refusals.length, 1);
        assert.strictEqual(scans, 1);
      });

      it('only what has ended goes: with half ended, the live half stays and the newcomer is held', () => {
        fill();
        held.slice(0, 16).forEach((token) => tokens().drop(token));
        newcomer(203);
        assert.deepStrictEqual(caller.refusals, []);
        assert.strictEqual(broker.announced.size, 17, 'sixteen live and the newcomer');
      });
    });

    // The reviewer's follow-up to #288: the count of held hops (4096) had no
    // share per caller, as the bytes have. One caller holding 4096 small
    // live hops kept every other caller refused until its deadlines passed.
    describe('(#288 follow-up) the count held by one caller', () => {
      // a sixteenth of the 4096: honest use is 16 hops in flight a channel, so
      // sixteen channels' worth, and sixteen caller workers to fill the count
      const SHARE = 256;
      let small;
      const hop = (w, channel, invokeId, token) => broker.handleAnnouncement(Object.assign({channel, invokeId, token, epoch: EPOCH, inputBytes: small}, TARGET), w);
      const another = (id) => {
        const other = wm(id);
        other.bindings = caller.bindings;
        broker.channelRegistry[`${other.workerId}:${callee.workerId}`] = {callerWM: other, calleeWM: callee, grants: {}};
        return other;
      };
      beforeEach(() => {
        cli.setOptions({workerThread: true, mcpToolCallCost: 1});
        // one buffer for them all: the broker holds a reference and counts its length
        small = bytes({input: {v: 1}});
      });

      it('a caller at its share (a sixteenth of the count) is refused RATE_LIMITED; another caller is not; its own ended hops make room', () => {
        let at = 5000;
        broker.monotonicMs = () => at;
        const token = tokens().issue(ENTRY(caller.workerId));
        for (let i = 0; i < SHARE; i++) hop(caller, pair(), 1000 + i, token);
        assert.deepStrictEqual(caller.refusals, [], '256 small hops are within its share');
        const walked = [];
        const releaseEnded = broker.releaseEnded.bind(broker);
        broker.releaseEnded = (workerId) => { walked.push(workerId); return releaseEnded(workerId); };
        hop(caller, pair(), 3000, token);
        assert.deepStrictEqual(caller.refusals.map((r) => [r.invokeId, r.errCode]), [[3000, 'RATE_LIMITED']]);
        assert.strictEqual(broker.announced.size, SHARE, 'nothing live was released');
        assert.deepStrictEqual(walked, [caller.workerId], 'over its own share it has its own hops looked at, not every caller\'s');
        // another caller worker, on its own channel: not refused by the first one's count
        const other = another(17);
        hop(other, `${other.workerId}:${callee.workerId}`, 1, tokens().issue(ENTRY(other.workerId)));
        assert.deepStrictEqual(other.refusals, []);
        // the first caller's call ends: its hops go when it next announces,
        // before any sweep (a caller at its count share is walked for at
        // most once in 100 ms while nothing of its own has ended: below)
        tokens().drop(token);
        at += 100;
        hop(caller, pair(), 3001, tokens().issue(ENTRY(caller.workerId)));
        assert.strictEqual(caller.refusals.length, 1, 'refused by its own ended hops');
        assert.strictEqual(broker.announced.size, 2, 'the other caller\'s and the new one');
        // and nothing is kept for a caller that holds nothing
        for (const key of [...broker.announced.keys()]) broker.forgetAnnounced(key);
        assert.strictEqual(broker.announcedCountByWorker.size, 0);
      });

      it('the share is the caller worker\'s, over all its channels: half on each of two, and the next is refused on either', () => {
        broker.channelRegistry.second = {callerWM: caller, calleeWM: callee, grants: {}};
        const token = tokens().issue(ENTRY(caller.workerId));
        for (let i = 0; i < SHARE / 2; i++) { hop(caller, pair(), 1000 + i, token); hop(caller, 'second', 1000 + i, token); }
        assert.deepStrictEqual(caller.refusals, []);
        hop(caller, 'second', 4000, token);
        hop(caller, pair(), 4001, token);
        assert.deepStrictEqual(caller.refusals.map((r) => [r.channel, r.errCode]), [['second', 'RATE_LIMITED'], [pair(), 'RATE_LIMITED']]);
      });

      // my /code-review: a caller parked at its count share (256 small live
      // hops are enough) made the broker walk every held hop at each further
      // announcement, at the message rate. A walk that released nothing is
      // not repeated for that caller within 100 ms.
      it('a caller at its count share whose walk released nothing is not walked for again within 100 ms; a walk that released something is', () => {
        let at = 5000;
        broker.monotonicMs = () => at;
        const token = tokens().issue(ENTRY(caller.workerId));
        for (let i = 0; i < SHARE; i++) hop(caller, pair(), 1000 + i, token);
        let walks = 0;
        const releaseEnded = broker.releaseEnded.bind(broker);
        broker.releaseEnded = (workerId) => { walks += 1; return releaseEnded(workerId); };
        for (let i = 0; i < 5; i++) hop(caller, pair(), 3000 + i, token);
        assert.strictEqual(caller.refusals.length, 5, 'each refused');
        assert.strictEqual(walks, 1, 'one walk for the five');
        at += 99;
        hop(caller, pair(), 3005, token);
        assert.strictEqual(walks, 1);
        at += 1;
        hop(caller, pair(), 3006, token);
        assert.strictEqual(walks, 2, 'again once 100 ms have passed');
        // its call ends inside the next window: refused until the window passes, then all are released and it is held
        tokens().drop(token);
        const fresh = tokens().issue(ENTRY(caller.workerId));
        at += 100;
        hop(caller, pair(), 3007, fresh);
        assert.strictEqual(walks, 3);
        assert.ok(broker.announced.has(`${pair()}/3007`), 'held: the walk released its ended hops');
        assert.strictEqual(broker.announced.size, 1);
        // that walk released something, so the caller is not held off: at its share again, the next walk runs at once
        for (let i = 0; i < SHARE - 1; i++) hop(caller, pair(), 6000 + i, fresh);
        hop(caller, pair(), 8000, fresh);
        assert.strictEqual(walks, 4, 'no wait after a walk that released hops');
        // another caller's walks are its own
        const other = another(18);
        const theirs = tokens().issue(ENTRY(other.workerId));
        for (let i = 0; i < SHARE; i++) hop(other, `${other.workerId}:${callee.workerId}`, 1 + i, theirs);
        hop(other, `${other.workerId}:${callee.workerId}`, 5000, theirs);
        assert.strictEqual(walks, 5);
      });

      it('one caller can no longer fill the count: with its share held live, fifteen more callers each hold theirs', () => {
        const callers = [caller].concat(Array.from({length: 15}, (x, i) => another(41 + i)));
        for (const w of callers) {
          const token = tokens().issue(ENTRY(w.workerId));
          const channel = w === caller ? pair() : `${w.workerId}:${callee.workerId}`;
          for (let i = 0; i < SHARE; i++) hop(w, channel, 5000 + i, token);
        }
        assert.deepStrictEqual(callers.flatMap((w) => w.refusals), [], 'each within its own share');
        assert.strictEqual(broker.announced.size, 4096);
        // the total still bounds them all: a seventeenth caller is refused while all are live
        const last = another(60);
        hop(last, `${last.workerId}:${callee.workerId}`, 1, tokens().issue(ENTRY(last.workerId)));
        assert.deepStrictEqual(last.refusals.map((r) => r.errCode), ['RATE_LIMITED']);
      });

      it('the count per caller is given back as its hops leave: one announced again under its id, one forgotten', () => {
        const token = tokens().issue(ENTRY(caller.workerId));
        for (let i = 0; i < SHARE; i++) hop(caller, pair(), 7000 + i, token);
        // one is announced again under its id (the earlier one is dropped), and one is forgotten
        hop(caller, pair(), 7000, token);
        assert.deepStrictEqual(caller.refusals, [], 'a hop announced again does not count twice');
        broker.forgetAnnounced(`${pair()}/7001`);
        hop(caller, pair(), 9000, token);
        assert.deepStrictEqual(caller.refusals, [], 'the room of the one forgotten');
        hop(caller, pair(), 9001, token);
        assert.strictEqual(caller.refusals.length, 1);
      });
    });

    // #205 merged with #202: a reload's drain counts every invoke the callee
    // still owes under step 4's accounting, the one whose input is being
    // checked included; a channel to a module being replaced is denied
    // before anything is held, so the denial releases nothing.
    it('(#205 x #202) the drain counts announced, checking and matched invokes; a MODULE_RELOADING denial holds and releases nothing', async () => {
      let release = null;
      moduleSpec.validateSerialized = (checked, which, buffer) => new Promise((resolve) => { release = () => resolve({refused: null, buffer: buffer}); });
      announce(90, tokens().issue(ENTRY(caller.workerId)));
      assert.strictEqual(broker.openInvokesTo(callee), 1, 'an announced invoke');
      meter(90, 'm90');
      await sleep(20);
      assert.strictEqual(broker.announced.size, 0);
      assert.strictEqual(broker.openInvokesTo(callee), 1, 'an invoke whose input is being checked was not counted');
      release();
      await sleep(20);
      assert.ok(served('m90'));
      assert.strictEqual(broker.openInvokesTo(callee), 1, 'a matched, unbilled invoke');
      bill(replyTo('m90').token, 'b90');
      await sleep(50);
      assert.strictEqual(broker.openInvokesTo(callee), 0);
      // a channel request to a module being replaced: denied, nothing held.
      // The broker asks whether the callee is being replaced only after the
      // access check (#442: before it, a caller without access learnt the
      // device is hosted), so the request's identity is one the auth
      // provider accepts here.
      const denied = [];
      const requester = {workerId: 18, sendPeerChannelDenyToChild: (m) => denied.push(m), bindings: caller.bindings};
      const provider = require('../../lib/auth').getAuthProvider();
      const savedAuthenticate = provider.authenticate;
      provider.authenticate = (appKey, deviceID, serviceID, actionName, cb) => cb(null, {ok: true, userName: 'drain-probe', isAdmin: false});
      callee.replacing = true;
      try {
        const before = [broker.announcedBytes, broker.announcedByWorker.size, broker.announced.size];
        broker.handleRequest({targetDeviceID: 'd-callee', appKey: 'k', token: tokens().issue(ENTRY(18))}, requester);
        await sleep(20);
        assert.deepStrictEqual(denied.map((m) => m.errCode), ['MODULE_RELOADING']);
        assert.deepStrictEqual([broker.announcedBytes, broker.announcedByWorker.size, broker.announced.size], before);
      } finally {
        provider.authenticate = savedAuthenticate;
        callee.replacing = false;
      }
    });

    // C-meter-keys-3 (B-meter-keys (2)'s rule applied to channels): a grant
    // record names the caller by id, so the caller's key is made known to the
    // identity index first -- a key the provider lists but the index doesn't
    // hold yet (a user added after start) is refilled with its stable id;
    // one the provider doesn't list is refused, retryably, nothing recorded.
    it('(C-meter-keys-3) a channel is granted once the caller\'s key is in the identity index; one that can\'t be made known is refused, nothing recorded', async () => {
      const identity = require('../../lib/identity');
      const tmp = require('../helpers/test-tmp');
      const saved = identity.stateForTests();
      const dir = tmp.mkdtemp('ch-c18-know-');
      const provider = require('../../lib/auth').getAuthProvider();
      const savedProvider = {authenticate: provider.authenticate, entries: provider.entries};
      const listed = [];
      provider.authenticate = (appKey, deviceID, serviceID, actionName, cb) => cb(null, {ok: true, userName: 'u', isAdmin: false});
      provider.entries = (cb) => cb(null, listed.map((k, i) => ({apiKey: k, userName: `u${i}`, isAdmin: false, id: `stable-${i}`})));
      callee.sendPeerChannelOpenToChild = () => {};
      callee.sendPeerChannelAllowToChild = (m, cb) => cb(null);
      const answers = [];
      const requester = {workerId: 19, ended: null, unloading: false, bindings: Object.assign({}, caller.bindings),
        sendPeerChannelDenyToChild: (m) => answers.push(m), sendPeerChannelGrantToChild: (m) => answers.push(m)};
      const auth = require('../../lib/auth');
      const savedSource = auth.identitySource;
      const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
      const keptOptions = optionsNow();
      const LOG = require('../../lib/logger');
      const savedE = LOG.E;
      const until = async (f) => { for (let i = 0; i < 400 && !f(); i++) await sleep(5); return f(); };
      try {
        identity.initSync({moduleDataPath: dir});
        // (the refill throttle's waits taken at once; its 10 s deadline kept)
        saved.setClock({now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms >= 10000 ? ms : 0)});
        const known = ENTRY(19);
        listed.push(known.identityKey);
        assert.strictEqual(identity.lookup(identity.idFor({id: 'stable-0'}, known.identityKey)), null, 'not in the index yet');
        broker.handleRequest({targetDeviceID: 'd-callee', token: tokens().issue(known)}, requester);
        assert.ok(await until(() => answers.length === 1), 'answered');
        assert.strictEqual(answers[0].errCode, undefined, JSON.stringify(answers[0]));
        const records = Object.values(broker.channelRegistry['19:12'].grants);
        assert.strictEqual(records.length, 1);
        assert.strictEqual(records[0].id, identity.idFor({id: 'stable-0'}, known.identityKey), 'named by the stable id the refill found');
        assert.strictEqual(identity.lookup(records[0].id).apiKey, known.identityKey, 'the re-check finds the key by the id');
        // a key the provider doesn't list (a lagging view): refused, retryably
        const unknown = ENTRY(19);
        broker.handleRequest({targetDeviceID: 'd-callee', token: tokens().issue(unknown)}, requester);
        assert.ok(await until(() => answers.length === 2), 'answered');
        assert.strictEqual(answers[1].errCode, 'SYSTEM_ERROR_USERDB_NA', JSON.stringify(answers[1]));
        assert.strictEqual(Object.values(broker.channelRegistry['19:12'].grants).length, 1, 'nothing recorded for it');
        // --debug, which accepts every key, with a provider that lists its
        // users (the single-identity profile): one it doesn't list is
        // remembered, and granted (rememberUnlisted)
        cli.setOptions(Object.assign({}, optionsNow(), {debug: true}));
        auth.identitySource = () => provider;
        const unlistedDebug = ENTRY(19);
        broker.handleRequest({targetDeviceID: 'd-callee', token: tokens().issue(unlistedDebug)}, requester);
        assert.ok(await until(() => answers.length === 3), 'answered');
        assert.strictEqual(answers[2].errCode, undefined, JSON.stringify(answers[2]));
        assert.strictEqual(Object.values(broker.channelRegistry['19:12'].grants).length, 2, 'recorded');
        assert.strictEqual(identity.lookup(identity.idForKey(unlistedDebug.identityKey)).apiKey, unlistedDebug.identityKey, 'remembered');
        restoreOptions(keptOptions);
        // the declarations asked again after the wait: a binding whose
        // declarations changed while the provider was read is refused,
        // nothing recorded
        let release = null;
        provider.entries = (cb) => { release = () => cb(null, listed.map((k, i) => ({apiKey: k, userName: `u${i}`, isAdmin: false, id: `stable-${i}`}))); };
        const late = ENTRY(19);
        listed.push(late.identityKey);
        broker.handleRequest({targetDeviceID: 'd-callee', token: tokens().issue(late)}, requester);
        assert.ok(await until(() => release != null), 'the provider asked');
        requester.bindings['d-callee'] = {identity: null, module: 'token-forge', targets: new Set(['d-other|svc|bump'])};
        release();
        assert.ok(await until(() => answers.length === 4), 'answered');
        assert.strictEqual(answers[3].errCode, 'CTX_CALL_UNDECLARED', JSON.stringify(answers[3]));
        assert.strictEqual(Object.values(broker.channelRegistry['19:12'].grants).length, 2, 'nothing recorded for it');
        // a throw past the wait is logged, never an unhandled rejection; the
        // caller is refused with a catalogued, retryable code, and the
        // channel it began undone
        requester.bindings = Object.assign({}, caller.bindings);
        provider.entries = (cb) => cb(null, listed.map((k, i) => ({apiKey: k, userName: `u${i}`, isAdmin: false, id: `stable-${i}`})));
        const logged = [];
        LOG.E = (e) => { logged.push(e); return e; };
        delete broker.channelRegistry['19:12'];
        broker.forgetPair('19:12');
        callee.sendPeerChannelOpenToChild = () => { throw new Error('a test throw past the wait'); };
        broker.handleRequest({targetDeviceID: 'd-callee', token: tokens().issue(known)}, requester);
        assert.ok(await until(() => answers.length === 5), 'answered');
        assert.strictEqual(answers[4].errCode, 'SYSTEM_ERROR_USERDB_NA', JSON.stringify(answers[4]));
        assert.strictEqual(logged.length, 1);
        assert.strictEqual(logged[0].message, 'a test throw past the wait');
        assert.strictEqual(broker.channelRegistry['19:12'], undefined, 'the half-made channel undone');
        // the same after the callee got its end: undone, and the port closed,
        // so the callee's end sees the close
        let calleeEnd = null;
        let endClosed = false;
        callee.sendPeerChannelOpenToChild = (m, port2) => { calleeEnd = port2; port2.on('close', () => { endClosed = true; }); };
        const grantSend = requester.sendPeerChannelGrantToChild;
        requester.sendPeerChannelGrantToChild = () => { throw new Error('a test throw at the caller\'s grant'); };
        broker.handleRequest({targetDeviceID: 'd-callee', token: tokens().issue(known)}, requester);
        assert.ok(await until(() => answers.length === 6), 'answered');
        requester.sendPeerChannelGrantToChild = grantSend;
        assert.strictEqual(answers[5].errCode, 'SYSTEM_ERROR_USERDB_NA', JSON.stringify(answers[5]));
        assert.strictEqual(broker.channelRegistry['19:12'], undefined, 'undone');
        assert.ok(calleeEnd != null, 'the callee got its end');
        assert.ok(await until(() => endClosed), 'the callee\'s end closed');
        callee.sendPeerChannelOpenToChild = () => {};
        // know() waited (a key the index didn't hold): the access check is
        // asked again after it, and a grant revoked meanwhile gets no channel;
        // a key already in the index is asked once
        const {CountinghouseError} = require('../../lib/countinghouse-error');
        let asks = 0;
        provider.authenticate = (appKey, deviceID, serviceID, actionName, cb) => {
          asks += 1;
          cb(null, asks === 1 ? {ok: true, userName: 'u', isAdmin: false} : {ok: false, userName: 'u', isAdmin: false, err: new CountinghouseError('USER_HAS_NO_DEVICE')});
        };
        const revokedMeanwhile = ENTRY(19);
        listed.push(revokedMeanwhile.identityKey);
        broker.handleRequest({targetDeviceID: 'd-callee', token: tokens().issue(revokedMeanwhile)}, requester);
        assert.ok(await until(() => answers.length === 7), 'answered');
        assert.strictEqual(answers[6].errCode, 'USER_HAS_NO_DEVICE', JSON.stringify(answers[6]));
        assert.strictEqual(asks, 2, 'asked again after the wait');
        assert.strictEqual(broker.channelRegistry['19:12'], undefined, 'no channel');
        asks = 0;
        provider.authenticate = (appKey, deviceID, serviceID, actionName, cb) => { asks += 1; cb(null, {ok: true, userName: 'u', isAdmin: false}); };
        broker.handleRequest({targetDeviceID: 'd-callee', token: tokens().issue(known)}, requester);
        assert.ok(await until(() => answers.length === 8), 'answered');
        assert.strictEqual(answers[7].errCode, undefined, JSON.stringify(answers[7]));
        assert.strictEqual(asks, 1, 'an indexed key is asked once');
        // the identity source throwing is a refusal, never "no provider"
        auth.identitySource = () => { throw new Error('a test throw from the identity source'); };
        const unknownSource = ENTRY(19);
        broker.handleRequest({targetDeviceID: 'd-callee', token: tokens().issue(unknownSource)}, requester);
        assert.ok(await until(() => answers.length === 9), 'answered');
        assert.strictEqual(answers[8].errCode, 'SYSTEM_ERROR_USERDB_NA', JSON.stringify(answers[8]));
        assert.strictEqual(identity.lookup(identity.idForKey(unknownSource.identityKey)), null, 'not remembered');
      } finally {
        LOG.E = savedE;
        auth.identitySource = savedSource;
        restoreOptions(keptOptions);
        Object.assign(provider, savedProvider);
        delete callee.sendPeerChannelOpenToChild;
        delete callee.sendPeerChannelAllowToChild;
        delete broker.channelRegistry['19:12'];
        saved.restore();
        tmp.remove(dir);
      }
    });

    // Round 3 (3, 4): an invoke's id is an integer in range, on the
    // announcement and on the match; the id delivered is the announced one.
    it('(#202-r3-3/4) an id that is not an integer in range is not held, and a match by one is refused; the announced id is delivered', async () => {
      broker.handleAnnouncement(Object.assign({channel: pair(), invokeId: '71', token: tokens().issue(ENTRY(caller.workerId)), epoch: EPOCH, inputBytes: bytes({input: {}})}, TARGET), caller);
      broker.handleAnnouncement(Object.assign({channel: pair(), invokeId: 2 ** 31, token: tokens().issue(ENTRY(caller.workerId)), epoch: EPOCH, inputBytes: bytes({input: {}})}, TARGET), caller);
      assert.strictEqual(broker.announced.size, 0);
      announce(72, tokens().issue(ENTRY(caller.workerId)));
      broker.handleMeteringRequest({channel: pair(), invokeId: '72'}, 'm72s', callee);
      assert.ok(refused(replyTo('m72s')), 'a string id matched');
      meter(72, 'm72');
      await sleep(50);
      bill(replyTo('m72').token, 'b72');
      await sleep(50);
      assert.deepStrictEqual(caller.results.map((m) => m.invokeId), [72]);
    });

    // The nit: main's deadline is the caller's, from the time its timer had left when it sent.
    it('(#202-r3) main\'s deadline is no later than the caller\'s timer, as it said at send (timeLeftMs)', async () => {
      broker.handleAnnouncement(Object.assign({channel: pair(), invokeId: 73, token: tokens().issue(ENTRY(caller.workerId)), epoch: EPOCH,
        inputBytes: bytes({input: {}}), timeLeftMs: 40}, TARGET), caller);
      await sleep(80);
      meter(73, 'm73');
      await sleep(50);
      const r = replyTo('m73');
      assert.ok(r != null && r.errCode === 'PEER_CHANNEL_TIMEOUT' && typeof(r.token) !== 'string', JSON.stringify(r));
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
      wmMain.rateRefillAt = require('perf_hooks').performance.now() + 60000;   // no refill during the test (the bucket's own, monotonic clock)
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
      await sleep(100);
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
      broker.dm.deviceMap['d-other'] = other;
      broker.handleAnnouncement({channel: `${caller.workerId}:${other.workerId}`, invokeId: 1, token: tokens().issue(e), epoch: EPOCH,
        deviceID: 'd-other', serviceID: 'svc', actionName: 'bump', inputBytes: bytes({input: {}})}, caller);
      broker.handleMeteringRequest({channel: `${caller.workerId}:${other.workerId}`, invokeId: 1}, 'm-other', other);
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

  // The review of #163 (5), as re-checked: device IDs by ownership. A worker
  // may not announce an ID another module's api.json declares, nor one
  // another module owns now or owned before; any other ID is owned by the
  // first module that announces it (a module that makes its devices in
  // code, test/fixtures/dynamic-discovery-module, still loads).
  it('(#163-5) device IDs by ownership: another module\'s declared or owned ID is refused; a new one is the first announcer\'s', () => {
    const EventEmitter = require('events');
    const DeviceManager = require('../../lib/device-manager');
    const wm = (name, id) => Object.assign(new EventEmitter(), {hostModuleName: name, hostModulePath: `/mods/${name}`, deviceList: {}, workerId: id});
    const wmM = wm('M', 73);
    const wmN = wm('N', 74);
    const self = Object.assign(Object.create(DeviceManager.prototype), {deviceMap: {}, notifyDeviceLoad: {}, allDevicesLoaded: true,
      moduleManager: {modules: {M: wmM, N: wmN}, endedStateForDevice: () => null, clearEndedDevice: () => {},
        pinnedDeviceIDs: {T: new Set(['dev-T']), M: new Set(['dev-M']), N: null}}});
    DeviceManager.prototype.onWorkerLoaded.call(self, wmM);
    DeviceManager.prototype.onWorkerLoaded.call(self, wmN);
    // since lean worker step 3 a worker announces nothing: the main thread
    // registers the device its own copy of the module's spec names
    // (registerFromSpec), so each registration here carries one, and the
    // ownership rule alone decides
    const announce = (w, name, id) => {
      const spec = {device: {friendlyName: id}};
      w.moduleSpec = {deviceID: id, spec: spec, specText: JSON.stringify(spec), modulePath: null};
      DeviceManager.prototype.registerFromSpec.call(self, w);
    };
    announce(wmM, 'M', 'dev-T');
    assert.strictEqual(self.deviceMap['dev-T'], undefined, 'M took a device T declares');
    announce(wmM, 'M', 'dev-dyn');
    assert.strictEqual(self.deviceMap['dev-dyn'], wmM, 'a new device was not its first announcer\'s');
    delete self.deviceMap['dev-dyn'];   // M's device goes (an unload)
    announce(wmN, 'N', 'dev-dyn');
    assert.strictEqual(self.deviceMap['dev-dyn'], undefined, 'N took a device M owned before');
    announce(wmM, 'M', 'dev-dyn');
    assert.strictEqual(self.deviceMap['dev-dyn'], wmM, 'its owner could not announce it again');
    announce(wmM, 'M', 'dev-M');
    assert.strictEqual(self.deviceMap['dev-M'], wmM);
  });

  // #153's review (2): a device ID is a worker's statement. While module T
  // reloads, its device's ended entry names T; another module announcing
  // T's device ID then must not take it (and so T's hops and tools).
  describe('registration of an announced device', () => {
    it('(#153-2) a device whose ended entry names another module is not registered to this one; its own module re-registers it', () => {
      const EventEmitter = require('events');
      const DeviceManager = require('../../lib/device-manager');
      const ended = {'dev-T': {code: 'MODULE_RELOADING', name: 'T'}};
      const wm = (name) => Object.assign(new EventEmitter(), {hostModuleName: name, hostModulePath: `/mods/${name}`, deviceList: {}, workerId: name === 'T' ? 71 : 72});
      const wmT = wm('T');
      const wmM = wm('M');
      const self = Object.assign(Object.create(DeviceManager.prototype), {deviceMap: {}, notifyDeviceLoad: {}, allDevicesLoaded: true,
        moduleManager: {modules: {T: wmT, M: wmM}, endedStateForDevice: (id) => ended[id] || null, clearEndedDevice: (id) => { delete ended[id]; }}});
      DeviceManager.prototype.onWorkerLoaded.call(self, wmM);
      DeviceManager.prototype.onWorkerLoaded.call(self, wmT);
      // registered from each worker's main-side spec (registerFromSpec, lean
      // worker step 3), so the ended entry alone decides; a worker states no
      // module name at all now
      const announce = (w) => {
        const spec = {device: {friendlyName: 'T'}};
        w.moduleSpec = {deviceID: 'dev-T', spec: spec, specText: JSON.stringify(spec), modulePath: null};
        DeviceManager.prototype.registerFromSpec.call(self, w);
      };
      announce(wmM);
      assert.strictEqual(self.deviceMap['dev-T'], undefined, 'M took T\'s device while T reloads');
      announce(wmM);   // a second try changes nothing: the worker states no name
      assert.strictEqual(self.deviceMap['dev-T'], undefined, 'M took T\'s device by stating T\'s name');
      announce(wmT);
      assert.strictEqual(self.deviceMap['dev-T'], wmT);
    });
  });

  // The review of #163 (2): job history (jobinfo:<name>, other tenants'
  // inputs, results and owners) lives in the kv a module's ctx.redis
  // reaches; a module's command on a runtime key is refused, read or write.
  describe('a module\'s ctx.redis and the runtime\'s own keys', () => {
    // Under #164's namespace (every key a module names is stored under
    // m:<module>:), a module naming the runtime's job history (jobinfo:<name>)
    // reaches only its own key of that name: the runtime's list is never read
    // or written. (#163's refusal of jobinfo keys is dropped as redundant.)
    it('(#163-2) a command naming a jobinfo key reaches only the module\'s own namespaced key, never the runtime\'s list', async () => {
      const EventEmitter = require('events');
      const DeviceManager = require('../../lib/device-manager');
      const redisAPI = require('../../lib/redis-api');
      const saved = {client: redisAPI.client, isCommand: redisAPI.isCommand};
      const ran = [];
      redisAPI.client = new Proxy({}, {get: (t, op) => (data, cb) => { ran.push([op, data]); cb(null, 'ok'); }});
      // the allowed set init() fills
      redisAPI.isCommand = (op) => redisAPI.ALLOWED_COMMANDS.includes(op);
      try {
        const wm = Object.assign(new EventEmitter(), {hostModuleName: 'm', deviceList: {}, workerId: 81});
        const replies = [];
        wm.sendRedisCommandReplyToChild = (m) => replies.push(m);
        const self = Object.assign(Object.create(DeviceManager.prototype), {deviceMap: {}, notifyDeviceLoad: {}, allDevicesLoaded: true, moduleManager: null});
        DeviceManager.prototype.onWorkerLoaded.call(self, wm);
        const send = (op, data) => wm.emit('rediscommand', {id: replies.length + ran.length + 1, data: {op, data}}, wm);
        send('lrange', ['jobinfo:report', 0, -1]);
        send('lpush', ['jobinfo:report', '{}']);
        send('del', ['mine', 'jobinfo:report']);
        send('mget', ['a', 'jobinfo:x']);
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(replies.length, 4, JSON.stringify(replies));
        assert.ok(replies.every((r) => r.errMsg == null), JSON.stringify(replies));
        assert.deepStrictEqual(ran, [
          ['lrange', ['m:m:jobinfo:report', 0, -1]],
          ['lpush', ['m:m:jobinfo:report', '{}']],
          ['del', ['m:m:mine', 'm:m:jobinfo:report']],
          ['mget', ['m:m:a', 'm:m:jobinfo:x']]
        ]);
        const keys = ran.flatMap(([, data]) => data.filter((k) => typeof(k) === 'string'));
        assert.ok(!keys.some((k) => k.startsWith('jobinfo:')), `a runtime key reached the store: ${JSON.stringify(keys)}`);
      } finally {
        redisAPI.client = saved.client;
        redisAPI.isCommand = saved.isCommand;
      }
    });
  });

  describe('a job history record\'s owner', () => {
    // (the history's key is this server's: B-j1)
    require('../helpers/server-id').useServerId();
    it('(#163-2) is the caller\'s opaque id, never the key or a hash of it; the owner still reads the record', (done) => {
      const identity = require('../../lib/identity');
      if (!identity.ready()) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-18-hist-'));
        identity.initSync({moduleDataPath: dir});
      }
      const common = require('../../lib/job-control-common');
      const redisAPI = require('../../lib/redis-api');
      const saved = redisAPI.client;
      const list = [];
      redisAPI.client = {lpush: (k, v) => list.unshift(v), ltrim: () => {}, lrange: (k, a, b, cb) => cb(null, list.slice())};
      const KEY = `hist-key-${hex()}`;
      try {
        // (a job names its owner by id, never the key: B-meter-keys (2))
        common.saveJobInfo({id: '1', name: 'report', data: {ownerId: identity.idForKey(KEY), input: {}}, opts: {}, progress: 0}, 'completed');
        const record = JSON.parse(list[0]);
        assert.strictEqual(record.job.data.owner, identity.idForKey(KEY), JSON.stringify(record.job.data));
        assert.ok(!JSON.stringify(record).includes(KEY), 'the key is in the record');
        common.getJobHistory({appKey: KEY}, 'report', (err, rows) => {
          try {
            assert.strictEqual(err, null, String(err));
            assert.strictEqual(rows.length, 1, JSON.stringify(rows));
            done();
          } catch (e) { done(e); }
        });
      } catch (e) {
        done(e);
      } finally {
        redisAPI.client = saved;
      }
    });
  });

  // The binding a worker's proxy keeps for its calling device (ENTRY's
  // 'd-callee'), declaring calls on these devices.
  const DECLARING = (...devices) => ({'d-callee': {identity: 'i', module: 'token-forge', targets: new Set(devices.map((d) => `${d}|svc|act`))}});
  // user-auth answering yes to every identity, for the query cases that
  // are about something else than the access check
  const allowAll = (fn) => async () => {
    const authPath = require.resolve('../../lib/user-auth');
    const saved = require.cache[authPath];
    require.cache[authPath] = {id: authPath, filename: authPath, loaded: true, exports: (a, b, c, d, e, f, g, cb) => cb(null, {})};
    try { return await fn(); } finally { if (saved != null) require.cache[authPath] = saved; else delete require.cache[authPath]; }
  };

  describe('the device query', () => {
    // R2-1 Task 5 (#148, 2): the query answers a spec only for a device the
    // calling module declared calls on; any other device, present or not, is
    // refused as its hop would be, and before the verdict it is not ready.
    it('(#148) answers a spec only for a declared device: anything else CTX_CALL_UNDECLARED, present or not; before the verdict CTX_CALL_NOT_READY', allowAll(async () => {
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
    }));

    // #153's review (5): a present declared device gets the access check at
    // query time too: an identity without a grant gets the access error,
    // never the spec.
    it('(#153-5) a present declared device: the spec only to an identity granted it, the access error otherwise', async () => {
      const DeviceManager = require('../../lib/device-manager');
      const authPath = require.resolve('../../lib/user-auth');
      const savedAuth = require.cache[authPath];
      const {CountinghouseError} = require('../../lib/countinghouse-error');
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
        exports: (a, b, deviceID, key, c, d, e, cb) => cb(key === 'denied-identity' ? new CountinghouseError('USER_HAS_NO_DEVICE') : null, {})};
      try {
        cli.setOptions({workerThread: true, peerChannelAuthLookupTimeoutMs: 200});
        const replies = [];
        const wm = {workerId: 37, sendDeviceQueryReplyToChild: (m) => replies.push(m), bindings: DECLARING('d-declared')};
        const present = {allDevicesLoaded: true, ensureDeviceState: (d, cb) => cb(null, {deviceList: {[d]: {device: {friendlyName: d}}}}),
          missingDeviceErrorForHop: () => new Error('not reached'), notifyDeviceLoad: {}};
        DeviceManager.prototype.queryDeviceForChild.call(present, 'd-declared', 'q1', wm, {token: tokens().issue(Object.assign(ENTRY(37), {identityKey: 'granted-identity'}))});
        DeviceManager.prototype.queryDeviceForChild.call(present, 'd-declared', 'q2', wm, {token: tokens().issue(Object.assign(ENTRY(37), {identityKey: 'denied-identity'}))});
        await sleep(100);
        assert.deepStrictEqual(replies.map((r) => [r.msgID, r.spec != null, r.errCode]).sort(),
          [['q1', true, undefined], ['q2', false, 'USER_HAS_NO_DEVICE']], JSON.stringify(replies));
      } finally {
        if (savedAuth != null) require.cache[authPath] = savedAuth; else delete require.cache[authPath];
        cli.setOptions({workerThread: false});
      }
    });

    // the review of 5b: a query held while discovery runs gets the same
    // access check when its device comes online
    it('(5b-review) a query held during discovery: the spec only to an identity granted the device once it is online', async () => {
      const EventEmitter = require('events');
      const DeviceManager = require('../../lib/device-manager');
      const authPath = require.resolve('../../lib/user-auth');
      const savedAuth = require.cache[authPath];
      const {CountinghouseError} = require('../../lib/countinghouse-error');
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
        exports: (a, b, deviceID, key, c, d, e, cb) => cb(key === 'denied-identity' ? new CountinghouseError('USER_HAS_NO_DEVICE') : null, {})};
      try {
        cli.setOptions({workerThread: true, peerChannelAuthLookupTimeoutMs: 200});
        const replies = [];
        const asker = {workerId: 38, sendDeviceQueryReplyToChild: (m) => replies.push(m), bindings: DECLARING('d-late')};
        const self = Object.assign(Object.create(DeviceManager.prototype), {deviceMap: {}, notifyDeviceLoad: {}, allDevicesLoaded: false,
          ensureDeviceState: (d, cb) => cb(new Error('missing'), null), missingDeviceErrorForHop: () => new Error('not reached'),
          moduleManager: {modules: {late: null}, endedStateForDevice: () => null, clearEndedDevice: () => {}}});
        DeviceManager.prototype.queryDeviceForChild.call(self, 'd-late', 'q1', asker, {token: tokens().issue(Object.assign(ENTRY(38), {identityKey: 'granted-identity'}))});
        DeviceManager.prototype.queryDeviceForChild.call(self, 'd-late', 'q2', asker, {token: tokens().issue(Object.assign(ENTRY(38), {identityKey: 'denied-identity'}))});
        assert.deepStrictEqual(replies, [], 'answered before the device came online');
        const host = Object.assign(new EventEmitter(), {hostModuleName: 'late', hostModulePath: '/mods/late', deviceList: {}, workerId: 39});
        self.moduleManager.modules.late = host;
        DeviceManager.prototype.onWorkerLoaded.call(self, host);
        const lateSpec = {device: {friendlyName: 'late'}};
        host.moduleSpec = {deviceID: 'd-late', spec: lateSpec, specText: JSON.stringify(lateSpec), modulePath: null};
        DeviceManager.prototype.registerFromSpec.call(self, host);
        await sleep(100);
        assert.deepStrictEqual(replies.map((r) => [r.msgID, r.spec != null, r.errCode]).sort(),
          [['q1', true, undefined], ['q2', false, 'USER_HAS_NO_DEVICE']], JSON.stringify(replies));
      } finally {
        if (savedAuth != null) require.cache[authPath] = savedAuth; else delete require.cache[authPath];
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
    it('(#138-5b) is refused CALL_TOKEN_INVALID, the device present or not', allowAll(async () => {
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
    }));
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
        flushPendingPeerInvokes: DeviceManager.prototype.flushPendingPeerInvokes, requestPeerChannel: DeviceManager.prototype.requestPeerChannel};
      const invoke = (token) => DeviceManager.prototype.invokeActionViaPeerChannel.call(dm, 'd-callee', 'svc', 'bump', {input: {}, token: token}, (e) => failed.push(e != null ? e.code : null));
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
      // the real prototype: M4a's hop wait asks replacingInPlace, false with no module manager
      DeviceManager.prototype.sendInvokeActionMessageToWorker.call(Object.assign(Object.create(DeviceManager.prototype), {deviceMap: {}}), 'k', 'k', 'd2', 'svc', 'act', {}, 'm1', caller, token);
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
        DeviceManager.prototype.onPeerChannelAllow.call({peerCalleeChannels: {7: {allowedDevices}}}, {callerWorkerId: 7, deviceID: 'd9'});
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
      // (a device whose composition verdict has landed, as every device reaching a call has once startup's verifications are
      // decided: one without is held for it, composition 19)
      const dev = device(41, sent); dev.bindings['d-41'] = {identity: 'k', module: 'm', targets: new Set()};
      DeviceManager.prototype.invokeAction.call({}, dev, 'd-41', 'svc', 'act', {input: {}}, session);
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
      const withVerdict = () => { const d = device(42, sent); d.bindings['d-42'] = {identity: 'k', module: 'm', targets: new Set()}; return d; };   // (as every device's, its start decided)
      DeviceManager.prototype.invokeJobs.call(dm, withVerdict(), 'd-42', 'svc', 'act', {}, 'job-1', () => {}, {ownerKey: `owner-${hex()}`, timeoutMs: 100});
      DeviceManager.prototype.invokeJobs.call(dm, withVerdict(), 'd-42', 'svc', 'act', {}, 'job-2', () => {}, {ownerKey: `owner-${hex()}`});
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

  // A call, a task's creation or a run sent before its module's composition verdict is held on the main thread until the verdict
  // (composition 19 end to end). What the hold must never do: hold back the verdict's own delivery, send a call whose caller was answered
  // meanwhile, hold a run past what its timeout leaves, or outlive the device object it waits on; and while it waits it is a call in
  // flight. Unit-level, on a stub device manager and a stub worker proxy.
  describe('a call or run held for its module\'s verdict', () => {
    const DeviceManager = require('../../lib/device-manager');
    const WorkerMessage = require('../../lib/worker-message');
    const proxy = (deviceID, sent) => Object.assign(Object.create(WorkerMessage.prototype), {workerId: 900000 + crypto.randomInt(99999),
      hostModuleName: `held-${hex()}`, deviceList: {[deviceID]: {}}, packageInfo: {name: 'held'}, modulePath: null, sendInvokeActionMessage: (m) => sent.push(m)});
    // a device manager with the pass's collaborators stubbed: its verification answers `verdict`, its relay is recorded and acknowledged
    const manager = (deviceMap, verdict, relayed, ready) => Object.assign(Object.create(DeviceManager.prototype), {deviceMap: deviceMap,
      moduleManager: null, notifyDeviceLoad: {}, peerChannelBroker: null,
      verifyComposition: (id, spec, pi, mp, name, cb) => verdict(cb),
      relayComposition: (dev, msg, cb) => { relayed.push(msg); cb(null); },
      announceReady: () => { ready.n++; }, announceDiscovered: () => {}, toolsetChanged: () => {}, forgetDecision: () => {}});
    const session = (answers) => {
      const s = {appKey: `caller-${hex()}`, timer: {expired: false}, deadline: Date.now() + 60000, callback: (e) => answers.push(e == null ? 'ok' : e.code)};
      s.setDeviceTimer = (dev, cb) => cb.call(s, null, dev, null);
      return s;
    };
    const bound = (cb) => cb(null, {identity: 'k', allowed: null, targets: []});
    const turns = () => new Promise((r) => setImmediate(() => setImmediate(r)));
    // waits on something observable, bounded: rejects at the bound
    const until = (pred, ms, what) => new Promise((resolve, reject) => {
      const end = Date.now() + ms;
      const look = () => (pred() ? resolve() : Date.now() > end ? reject(new Error(`not within ${ms} ms: ${what}`)) : setTimeout(look, 20));
      look();
    });
    // the end of a device object, as onPurgeDevice runs it (its log line stubbed)
    const purging = async (dm, dev) => {
      const savedLog = CHUtil.__deviceLogWithID;
      CHUtil.__deviceLogWithID = (id, reason, ts, cb) => cb();
      try { dm.onPurgeDevice(dev, 'MODULE UNLOADED', () => {}); await turns(); } finally { CHUtil.__deviceLogWithID = savedLog; }
    };
    const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
    let kept = null;
    let savedE = null;
    let logged = [];
    // user-auth, as the main thread reads it at a release (from require.cache on each use): a key in `revoked` has lost its grant
    const revoked = new Set();
    // (set by a case: run on the lookup's own later turn, before it answers, as a slow provider's lookup would leave room for)
    let duringLookup = null;
    const authPath = require.resolve('../../lib/user-auth');
    let savedAuth = null;
    before(() => {
      kept = optionsNow(); savedE = LOG.E; LOG.E = (e) => logged.push(String(e && e.message ? e.message : e));
      savedAuth = require.cache[authPath];
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
        exports: (a, b, deviceID, appKey, c, d, e, cb) => {
          const answer = () => cb(revoked.has(appKey) ? Object.assign(new Error('no grant'), {code: 'DEVICE_ACCESS_DENIED'}) : null, {appKey: appKey});
          if (duringLookup == null) return answer();
          const hook = duringLookup;
          duringLookup = null;
          return setImmediate(() => { hook(); answer(); });
        }};
    });
    beforeEach(() => { logged = []; revoked.clear(); duringLookup = null; cli.setOptions({workerThread: true, requestTimeout: 30}); });
    after(() => {
      LOG.E = savedE; restoreOptions(kept);
      if (savedAuth != null) require.cache[authPath] = savedAuth; else delete require.cache[authPath];
    });

    for (const [what, verdict, relayedAs, want] of [
      ['bound', bound, (m) => m.deviceID, ['d-h1', 'landed']],
      ['purged at the start', (cb) => cb(new Error('a target not declared')), (m) => m.release === true && m.deviceID, ['d-h1', 'purged']]]) {
      it(`a held call whose own answer throws holds back neither the verdict's delivery nor the other held calls: ${what}`, async () => {
        const relayed = [];
        const ready = {n: 0};
        const dm = manager({'d-h1': proxy('d-h1', [])}, verdict, relayed, ready);
        const answers = [];
        dm.untilVerdict('d-h1', null, () => { answers.push('first'); throw new Error('a held call\'s own answer threw'); });
        dm.untilVerdict('d-h1', null, (d) => answers.push(d));
        dm.verificationPass(null);
        await turns();
        assert.deepStrictEqual([relayed.map(relayedAs), ready.n, answers], [[want[0]], 1, ['first', want[1]]]);
        assert.ok(logged.some((l) => /own answer threw/.test(l)), JSON.stringify(logged));
      });
    }

    it('a held call is woken once its verdict is delivered into the worker, never before', async () => {
      const relayed = [];
      const sent = [];
      const dev = proxy('d-h3', sent);
      const dm = manager({'d-h3': dev}, bound, relayed, {n: 0});
      let ack = null;
      dm.relayComposition = (d, msg, cb) => { relayed.push(msg); ack = cb; };
      const answers = [];
      DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h3', 'svc', 'act', {input: {}}, session(answers));
      dm.verificationPass(null);
      await turns();
      assert.deepStrictEqual([relayed.length, sent.length], [1, 0], 'sent before its verdict reached the worker');
      ack(null);
      await turns();
      assert.deepStrictEqual([sent.length, sent.length > 0 && typeof(sent[0].args.token), answers], [1, 'string', []]);
      tokens().drop(sent[0].args.token);
    });

    // the caller answered while its call was held: at its deadline (the session's timer answers and clears itself), or past a deadline
    // a tightening moved earlier whose timer has not answered yet; one still waiting is sent, so the cases prove the path ran
    for (const [what, answeredBy, wantSent] of [
      ['its deadline answered it', (s) => { s.timer = null; }, 0],
      ['a shorter deadline has passed', (s) => { s.deadline = Date.now() - 1; }, 0],
      ['it is still waiting (control)', () => {}, 1]]) {
      it(`a held call is never sent once its caller was answered: ${what}`, async () => {
        const sent = [];
        const dev = proxy('d-h4', sent);
        const dm = manager({'d-h4': dev}, bound, [], {n: 0});
        const answers = [];
        const s = session(answers);
        DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h4', 'svc', 'act', {input: {}}, s);
        answeredBy(s);
        dm.verificationPass(null);
        await turns();
        assert.deepStrictEqual([sent.length, answers], [wantSent, []], 'sent, or answered a second time');
        if (sent.length > 0) tokens().drop(sent[0].args.token);
      });
    }

    // a run is never held past what its timeout leaves (the margin kept for its answer): its timeout decides the hold when it is the
    // nearer bound, and one within the margin leaves no hold, so the run is answered CTX_CALL_NOT_READY at once; nothing sent, no token
    it('a run\'s hold ends where its own timeout leaves the margin, before the call\'s bound', async () => {
      const sent = [];
      const answered = [];
      const before = tokens().size();
      DeviceManager.prototype.invokeJobs.call({}, proxy('d-h5', sent), 'd-h5', 'svc', 'act', {}, 'job-h5', (err) => answered.push(err && err.code), {ownerKey: `owner-${hex()}`, timeoutMs: 2400});
      await turns();
      assert.deepStrictEqual([sent.length, answered, tokens().size()], [0, [], before], 'answered before its hold, or sent');
      // (its timeout leaves 400 ms; the call's bound would be 25 s)
      await until(() => answered.length > 0, 10000, 'the run answered at what its timeout leaves');
      assert.deepStrictEqual([sent.length, answered, tokens().size()], [0, ['CTX_CALL_NOT_READY'], before]);
    });

    it('a run whose timeout is within the margin is answered CTX_CALL_NOT_READY at once, unsent', async () => {
      const sent = [];
      const answered = [];
      const before = tokens().size();
      DeviceManager.prototype.invokeJobs.call({}, proxy('d-h6', sent), 'd-h6', 'svc', 'act', {}, 'job-h6', (err) => answered.push(err && err.code), {ownerKey: `owner-${hex()}`, timeoutMs: 1500});
      // (no hold: answered on its next turns; kept to 1.5 s, the margin not kept would hold it, not 25 s)
      await until(() => answered.length > 0, 1000, 'answered at once');
      assert.deepStrictEqual([sent.length, answered, tokens().size()], [0, ['CTX_CALL_NOT_READY'], before]);
    });

    // the device object a call waits on ends (an unload, a crash, a restart, its worker's exit): answered at once and unsent, with
    // what a fresh call to the tool gets then: gone, the one answer to any tool the caller can't use (DEVICE_NOT_FOUND, marked
    // goneAtVerdict: the gateway answers it from unknownToolResponse, as notSeen); restarting, still listed, its retryable code
    const uniform = (errs) => [errs.length, errs[0] && errs[0].code, errs[0] != null && errs[0].goneAtVerdict === true];
    for (const [what, ended, want] of [
      ['unloaded', null, ['DEVICE_NOT_FOUND', true]],
      ['restarting', {code: 'MODULE_RESTARTING', name: 'held'}, ['MODULE_RESTARTING', false]]]) {
      it(`a held call whose device ends is answered at once, unsent, as a fresh call is then: ${what}`, async () => {
        const sent = [];
        const dev = proxy('d-h7', sent);
        const dm = manager({'d-h7': dev}, () => {}, [], {n: 0});
        dm.moduleManager = {endedStateForDevice: () => ended};
        const errs = [];
        const s = session([]);
        s.callback = (e) => errs.push(e);
        DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h7', 'svc', 'act', {input: {}}, s);
        await purging(dm, dev);
        assert.deepStrictEqual([sent.length, ...uniform(errs)], [0, 1, ...want]);
      });
    }

    it('a call held on a session\'s worker is answered at once when its module\'s record ends (they share its verdict)', async () => {
      const {SessionModuleRecord} = require('../../lib/session-module-record');
      const sent = [];
      const rec = Object.assign(Object.create(SessionModuleRecord.prototype), {hostModuleName: 'held', deviceList: {'d-h11': {}}, bindings: {}});
      const wm = Object.assign(proxy('d-h11', sent), {bindings: rec.bindings});
      const dm = manager({'d-h11': rec}, () => {}, [], {n: 0});
      const errs = [];
      const s = session([]);
      s.callback = (e) => errs.push(e);
      DeviceManager.prototype.invokeAction.call(dm, wm, 'd-h11', 'svc', 'act', {input: {}}, s);
      await purging(dm, rec);
      assert.deepStrictEqual([sent.length, ...uniform(errs)], [0, 1, 'DEVICE_NOT_FOUND', true]);
    });

    it('a worker\'s exit answers the calls held on it at once, unsent, with the uniform answer (lib/module-manager.js, its exit)', async () => {
      const sent = [];
      const wm = proxy('d-h12', sent);
      const other = proxy('d-h12', sent);
      const errs = [];
      const others = [];
      const s = session([]);
      s.callback = (e) => errs.push(e);
      const o = session([]);
      o.callback = (e) => others.push(e);
      DeviceManager.prototype.invokeAction.call(manager({}, () => {}, [], {n: 0}), wm, 'd-h12', 'svc', 'act', {input: {}}, s);
      DeviceManager.prototype.invokeAction.call(manager({}, () => {}, [], {n: 0}), other, 'd-h12', 'svc', 'act', {input: {}}, o);
      DeviceManager.releaseHeldOn(wm);
      await turns();
      assert.deepStrictEqual([sent.length, ...uniform(errs), others.length], [0, 1, 'DEVICE_NOT_FOUND', true, 0], 'or another worker\'s call released');
      DeviceManager.releaseHeldOn(other);
      await turns();
      // and the exit handler releases them, after what was queued is answered (a lexical pin: the handler runs only on a real exit)
      const mm = fs.readFileSync(path.join(ROOT, 'lib', 'module-manager.js'), 'utf8');
      const exit = mm.indexOf('workerMessage.endWith(why, name,');
      assert.ok(exit > 0 && /^\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*require\('\.\/device-manager'\)\.releaseHeldOn\(workerMessage\);/.test(mm.slice(mm.indexOf('\n', exit) + 1)),
        'the worker exit handler no longer releases the calls held on it right after endWith');
    });

    it('a held call released by an end and woken by its verdict in the same turn is answered once', async () => {
      const sent = [];
      const dev = proxy('d-h13', sent);
      const dm = manager({'d-h13': dev}, bound, [], {n: 0});
      const errs = [];
      const s = session([]);
      s.callback = (e) => errs.push(e);
      DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h13', 'svc', 'act', {input: {}}, s);
      dm.verificationPass(null);
      DeviceManager.releaseHeldOn(dev);
      await turns();
      await turns();
      assert.strictEqual(sent.length + errs.length, 1, `sent ${sent.length}, answered ${errs.length}`);
      if (sent.length > 0) tokens().drop(sent[0].args.token);
    });

    it('a held call whose answer throws at its bound is logged, never thrown out of the timer', async () => {
      cli.setOptions({workerThread: true, requestTimeout: 3});   // seconds: a hold of 1 s
      const dm = manager({'d-h14': proxy('d-h14', [])}, () => {}, [], {n: 0});
      dm.untilVerdict('d-h14', null, () => { throw new Error('the answer at the bound threw'); });
      await until(() => logged.some((l) => /answer at the bound threw/.test(l)), 5000, 'the throw logged');
    });

    it('a call held for a module purged at the start is answered as gone even while the purge\'s delivery is pending', async () => {
      const relayed = [];
      const dm = manager({'d-h15': proxy('d-h15', [])}, (cb) => cb(new Error('a target not declared')), relayed, {n: 0});
      dm.relayComposition = (dev, msg) => relayed.push(msg);   // never acknowledged
      const answers = [];
      dm.untilVerdict('d-h15', null, (d) => answers.push(d));
      dm.verificationPass(null);
      await turns();
      assert.deepStrictEqual([relayed.length, answers], [1, ['purged']]);
    });

    // the gateway's held task creation (createTaskForToolCall): a session that ended while it was held is answered as ended, never
    // with the hold's own answer. In a child process: it loads the gateway with user-auth stubbed, which this one must not.
    it('a task creation held while its session ended is answered as ended, whatever the hold decided; its live() tells the hold', () => {
      const child = `
        const W = process.argv[1];
        const authPath = require.resolve(W + '/lib/user-auth');
        require.cache[authPath] = {id: authPath, filename: authPath, loaded: true, exports: (a, b, c, d, e, f, g, cb) => cb(null, {})};
        require(W + '/lib/cli-options').setOptions({workerThread: true, requestTimeout: 30});
        require(W + '/lib/logger').createLogger();
        const sessions = require(W + '/lib/sessions');
        const gw = require(W + '/lib/mcp/gateway');
        const out = {};
        const cases = [['purged', true], ['bound', true], ['landed', true], ['bound-open', false]];
        for (const [decided, closes] of cases) {
          let open = true;
          const sid = 's-' + decided;
          const savedGet = sessions.get;
          sessions.get = (id) => (id === sid) ? (open ? {id} : null) : savedGet(id);
          const dm = {untilVerdict: (id, limits, cb, live) => {
            if (closes) open = false;
            out['live-' + decided] = (typeof(live) === 'function') ? live() : 'none';
            setImmediate(() => cb(decided.replace('-open', '')));
          }};
          gw.createTaskForToolCallFor({id: 7, params: {name: 'held_tool'}}, {deviceManager: dm}, {deviceID: 'd-n3', serviceID: 's', actionName: 'a', name: 'held_tool'},
            {}, null, (err, res) => { out[decided] = res; if (cases.every(([d]) => out[d] != null)) { console.log(JSON.stringify(out)); process.exit(0); } }, sid, null, false, null);
        }
        setTimeout(() => { console.log(JSON.stringify(out)); process.exit(3); }, 5000);`;
      const r = require('child_process').spawnSync(process.execPath, ['-e', child, ROOT], {encoding: 'utf8', timeout: 30000});
      const out = JSON.parse(r.stdout.trim().split('\n').pop());
      const codes = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, (typeof(v) !== 'object') ? v : v.result != null ? v.result._meta['countinghouse/code'] : `error ${v.error.code}`]));
      // ended sessions: the ended answer, and the hold's live() false; an open one at its bound not ready, live() true
      assert.deepStrictEqual(codes, {purged: 'MODULE_NOT_LISTED', bound: 'MODULE_NOT_LISTED', landed: 'MODULE_NOT_LISTED', 'bound-open': 'CTX_CALL_NOT_READY',
        'live-purged': false, 'live-bound': false, 'live-landed': false, 'live-bound-open': true}, r.stderr);
    });

    it('a held call is not released by the end of another copy of its device: it waits on to its bound, answered as a fresh call then', async () => {
      cli.setOptions({workerThread: true, requestTimeout: 3});   // seconds: a hold of 1 s
      const sent = [];
      const held = proxy('d-h9', sent);
      const other = proxy('d-h9', sent);
      const dm = manager({'d-h9': held}, () => {}, [], {n: 0});
      const answers = [];
      DeviceManager.prototype.invokeAction.call(dm, held, 'd-h9', 'svc', 'act', {input: {}}, session(answers));
      dm.deviceMap['d-h9'] = other;
      await purging(dm, other);
      assert.deepStrictEqual([sent.length, answers], [0, []], 'released by another copy\'s end');
      await until(() => answers.length > 0, 5000, 'answered at its own bound');
      // (by then the device is out of the map: as a fresh call, the uniform answer)
      assert.deepStrictEqual([sent.length, answers], [0, ['DEVICE_NOT_FOUND']]);
    });

    // a task's creation held the same way (untilVerdict): gone, as any tool the caller can't use ('purged'); restarting, created, as a
    // fresh creation is (its run waits for the module, retried by the runner)
    for (const [what, ended, want] of [['gone', null, ['purged', 'DEVICE_NOT_FOUND', undefined]], ['restarting', {code: 'MODULE_RESTARTING', name: 'held'}, ['landed', undefined, true]]]) {
      it(`a task's creation held for a device that ends is answered as a fresh one is then: ${what}`, async () => {
        const dev = proxy('d-h10', []);
        const dm = manager({'d-h10': dev}, () => {}, [], {n: 0});
        dm.moduleManager = {endedStateForDevice: () => ended};
        const decided = [];
        // (a creation that goes on after a hold is said to have been held: the gateway reads its grant again then)
        dm.untilVerdict('d-h10', null, (d, err, held) => decided.push(d, err && err.code, held));
        await purging(dm, dev);
        assert.deepStrictEqual(decided, want);
      });
    }

    it('a session worker\'s exit leaves the calls held on its siblings held (an end is of the target a call holds, never a shared verdict)', async () => {
      cli.setOptions({workerThread: true, requestTimeout: 3});   // seconds: a hold of 1 s
      const {SessionModuleRecord} = require('../../lib/session-module-record');
      const sent = [];
      const rec = Object.assign(Object.create(SessionModuleRecord.prototype), {hostModuleName: 'held', deviceList: {'d-h16': {}}, bindings: {}});
      const wmA = Object.assign(proxy('d-h16', sent), {bindings: rec.bindings});
      const wmB = Object.assign(proxy('d-h16', sent), {bindings: rec.bindings});
      const answers = [];
      DeviceManager.prototype.invokeAction.call(manager({'d-h16': rec}, () => {}, [], {n: 0}), wmA, 'd-h16', 'svc', 'act', {input: {}}, session(answers));
      DeviceManager.releaseHeldOn(wmB);
      await turns();
      assert.deepStrictEqual([sent.length, answers], [0, []], 'released by a sibling worker\'s exit');
      await until(() => answers.length > 0, 5000, 'answered at its own bound');
      assert.deepStrictEqual([sent.length, answers], [0, ['CTX_CALL_NOT_READY']]);
    });

    it('a task\'s run held while its job is given up on never runs: no token, nothing sent, nothing answered', async () => {
      const sent = [];
      const answered = [];
      const dev = proxy('d-h17', sent);
      const dm = manager({'d-h17': dev}, bound, [], {n: 0});
      let gaveUp = false;
      const before = tokens().size();
      DeviceManager.prototype.invokeJobs.call(dm, dev, 'd-h17', 'svc', 'act', {}, 'job-h17', (err) => answered.push(err && err.code), {ownerKey: `owner-${hex()}`}, () => gaveUp);
      gaveUp = true;
      dm.verificationPass(null);
      await turns();
      await turns();
      assert.deepStrictEqual([sent.length, tokens().size(), answered, DeviceManager.verdictHeldOn(dev)], [0, before, [], 0]);
    });

    // a caller that ended while its call was held (answered at its deadline, cancelled) ends the hold then: no longer a call in flight
    for (const [what, ends] of [['cancelled', (s) => { s.cancelled = true; }], ['its deadline answered it', (s) => { s.timer = null; }]]) {
      it(`a held call whose caller ended stops counting for a drain then, not at its verdict or bound: ${what}`, async () => {
        const dev = Object.assign(proxy('d-h18', []), {msgQueue: {}, inFlight: () => false});
        const dm = manager({'d-h18': dev}, () => {}, [], {n: 0});
        const s = session([]);
        DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h18', 'svc', 'act', {input: {}}, s);
        assert.strictEqual(DeviceManager.verdictHeldOn(dev), 1);
        ends(s);
        await until(() => DeviceManager.verdictHeldOn(dev) === 0, 2000, 'the hold ended with its caller');
      });
    }

    it('a held call cancelled meanwhile is answered as a cancel before its send, never with its verdict\'s answer', async () => {
      const sent = [];
      const dev = proxy('d-h19', sent);
      const dm = manager({'d-h19': dev}, (cb) => cb(new Error('a target not declared')), [], {n: 0});
      const errs = [];
      const s = session([]);
      s.callback = (e) => errs.push(e && e.code);
      DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h19', 'svc', 'act', {input: {}}, s);
      s.cancelled = true;
      dm.verificationPass(null);
      await turns();
      await turns();
      // (as send() answers a call cancelled before it was sent: the gateway writes nothing and records it cancelled)
      assert.deepStrictEqual([sent.length, errs], [0, ['CALL_TOKEN_INVALID']]);
    });

    it('a held call whose bound comes after its verdict was decided, but before it was delivered, answers CTX_CALL_NOT_READY unsent', async () => {
      cli.setOptions({workerThread: true, requestTimeout: 3});   // seconds: a hold of 1 s
      const sent = [];
      const dev = proxy('d-h21', sent);
      const dm = manager({'d-h21': dev}, bound, [], {n: 0});
      dm.relayComposition = () => {};   // never acknowledged
      const answers = [];
      DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h21', 'svc', 'act', {input: {}}, session(answers));
      dm.verificationPass(null);
      await until(() => answers.length > 0, 5000, 'answered at its bound');
      assert.deepStrictEqual([sent.length, answers], [0, ['CTX_CALL_NOT_READY']]);
    });

    it('a job given up on reaches the held run: invokeJobsNow hands its cancelled() to invokeJobs (a lexical pin: its checks need a runtime)', () => {
      const dmSrc = fs.readFileSync(path.join(ROOT, 'lib', 'device-manager.js'), 'utf8');
      const now = dmSrc.slice(dmSrc.indexOf('DeviceManager.prototype.invokeJobsNow = function'), dmSrc.indexOf('DeviceManager.prototype.onGetDeviceSpec'));
      const calls = now.match(/this\.invokeJobs\([^)]*\)/g) || [];
      assert.ok(calls.length >= 2 && calls.every((c) => /, cancelled\)$/.test(c)), JSON.stringify(calls));
    });

    // a verification of copy A answered after copy B took its device ID (A's check was still running when B registered)
    const lateVerdictOnA = async (verdict) => {
      cli.setOptions({workerThread: true, requestTimeout: 3});   // seconds: a hold of 1 s
      const sent = [];
      const devA = proxy('d-h22', sent);
      const devB = proxy('d-h22', sent);
      let answerA = null;
      const dm = manager({'d-h22': devA}, (cb) => { answerA = cb; }, [], {n: 0});
      dm.verificationPass(null);
      dm.deviceMap['d-h22'] = devB;
      const answers = [];
      DeviceManager.prototype.invokeAction.call(dm, devB, 'd-h22', 'svc', 'act', {input: {}}, session(answers));
      verdict(answerA);
      await turns();
      await turns();
      return {dm, devB, sent, answers};
    };

    it('copy A\'s failed verdict leaves B\'s held calls held and B\'s map entry in place', async () => {
      const {dm, devB, sent, answers} = await lateVerdictOnA((cb) => cb(new Error('a target not declared')));
      assert.ok(dm.deviceMap['d-h22'] === devB, 'A\'s failed verdict deleted B\'s map entry');
      assert.deepStrictEqual([sent.length, answers], [0, []], 'B\'s held call ended by A\'s verdict');
      await until(() => answers.length > 0, 5000, 'answered at its own bound');
      assert.deepStrictEqual(answers, ['CTX_CALL_NOT_READY']);
    });

    it('copy A\'s delivered verdict leaves the calls held on B, the listed copy, held for B\'s own verdict', async () => {
      const {sent, answers} = await lateVerdictOnA(bound);
      assert.deepStrictEqual([sent.length, answers], [0, []], 'B\'s held call ended by A\'s verdict');
      await until(() => answers.length > 0, 5000, 'answered at its own bound');
      assert.deepStrictEqual(answers, ['CTX_CALL_NOT_READY']);
    });

    it('a worker\'s exit with its device still in the map answers its held calls as gone, not not-ready', async () => {
      const sent = [];
      const dev = proxy('d-h23', sent);
      const dm = manager({'d-h23': dev}, () => {}, [], {n: 0});
      const errs = [];
      const s = session([]);
      s.callback = (e) => errs.push(e);
      DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h23', 'svc', 'act', {input: {}}, s);
      dev.exited = true;   // (as the exit handler marks it, before it releases)
      DeviceManager.releaseHeldOn(dev);
      await turns();
      assert.deepStrictEqual([sent.length, ...uniform(errs)], [0, 1, 'DEVICE_NOT_FOUND', true]);
    });

    it('a held call whose module is being replaced in place answers CTX_CALL_NOT_READY (a fresh call waits and is served; a retry is)', async () => {
      const sent = [];
      const dev = proxy('d-h24', sent);
      const dm = manager({'d-h24': dev}, () => {}, [], {n: 0});
      dm.replacingInPlace = () => true;
      const errs = [];
      const s = session([]);
      s.callback = (e) => errs.push(e && e.code);
      DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h24', 'svc', 'act', {input: {}}, s);
      await purging(dm, dev);
      assert.deepStrictEqual([sent.length, errs], [0, ['CTX_CALL_NOT_READY']]);
    });

    it('a held run whose module is gone fails for good in shared mode, as a fresh run does (discoveredTag)', async () => {
      const sessionsLib = require('../../lib/sessions');
      const {notRetried} = require('../../lib/job-control-common');
      const dev = proxy('d-h25', []);
      const dm = Object.assign(manager({'d-h25': dev}, () => {}, [], {n: 0}), {allDevicesLoaded: true});
      const failed = [];
      DeviceManager.prototype.invokeJobs.call(dm, dev, 'd-h25', 'svc', 'act', {}, 'job-h25', (err) => failed.push(err), {ownerKey: `owner-${hex()}`});
      await purging(dm, dev);
      const wasShared = sessionsLib.shared();
      sessionsLib.sharedForTests(true);
      try {
        assert.deepStrictEqual([failed.length, failed[0] && failed[0].code, failed[0] != null && notRetried(failed[0].code, failed[0])], [1, 'DEVICE_NOT_FOUND', true]);
      } finally {
        sessionsLib.sharedForTests(wasShared);
      }
    });

    it('a held call whose caller check throws is ended with the uniform answer, the throw logged, never thrown out of the poll', async () => {
      const dm = manager({'d-h26': proxy('d-h26', [])}, () => {}, [], {n: 0});
      const decided = [];
      dm.untilVerdict('d-h26', null, (d, err) => decided.push(d, err && err.code), () => { throw new Error('the caller check threw'); });
      await until(() => decided.length > 0, 2000, 'the hold ended');
      assert.deepStrictEqual(decided, ['purged', 'DEVICE_NOT_FOUND']);
      await turns();
      assert.strictEqual(logged.filter((l) => /caller check threw/.test(l)).length, 1, JSON.stringify(logged));
    });

    it('a module turned off during the hold: no handler runs, the uniform answer (a tightening applies to held calls as to fresh ones)', async () => {
      const visibility = require('../../lib/module-visibility');
      const sent = [];
      const dev = proxy('d-h27', sent);
      const dm = manager({'d-h27': dev}, bound, [], {n: 0});
      const errs = [];
      const s = session([]);
      s.callback = (e) => errs.push(e);
      const before = visibility.configure({moduleOf: (id) => (id === 'd-h27' ? 'held-off' : null), changed: () => {}});
      try {
        DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h27', 'svc', 'act', {input: {}}, s);
        visibility.hide(['held-off']);
        dm.verificationPass(null);
        await turns();
        await turns();
      } finally {
        visibility.show(['held-off']);
        visibility.configure(before);
      }
      assert.deepStrictEqual([sent.length, ...uniform(errs)], [0, 1, 'DEVICE_NOT_FOUND', true]);
    });

    it('a module turned off during the hold, its bound reached with no verdict: the uniform answer, as a fresh call gets', async () => {
      cli.setOptions({workerThread: true, requestTimeout: 3});   // seconds: a hold of 1 s
      const visibility = require('../../lib/module-visibility');
      const sent = [];
      const dev = proxy('d-h35', sent);
      const dm = manager({'d-h35': dev}, () => {}, [], {n: 0});
      const errs = [];
      const s = session([]);
      s.callback = (e) => errs.push(e);
      const before = visibility.configure({moduleOf: (id) => (id === 'd-h35' ? 'held-off-bound' : null), changed: () => {}});
      try {
        DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h35', 'svc', 'act', {input: {}}, s);
        visibility.hide(['held-off-bound']);
        await until(() => errs.length > 0, 5000, 'answered at its bound');
      } finally {
        visibility.show(['held-off-bound']);
        visibility.configure(before);
      }
      assert.deepStrictEqual([sent.length, ...uniform(errs)], [0, 1, 'DEVICE_NOT_FOUND', true]);
    });

    it('a verdict whose relay into the worker failed releases nothing: the call stays held to its bound, unsent', async () => {
      cli.setOptions({workerThread: true, requestTimeout: 3});   // seconds: a hold of 1 s
      const sent = [];
      const dev = proxy('d-h28', sent);
      const dm = manager({'d-h28': dev}, bound, [], {n: 0});
      dm.relayComposition = (d, msg, cb) => cb(new Error('the relay failed'));
      const answers = [];
      DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h28', 'svc', 'act', {input: {}}, session(answers));
      dm.verificationPass(null);
      await turns();
      assert.deepStrictEqual([sent.length, answers], [0, []], 'released on a failed relay');
      await until(() => answers.length > 0, 5000, 'answered at its bound');
      assert.deepStrictEqual([sent.length, answers], [0, ['CTX_CALL_NOT_READY']]);
    });

    it('a call held on copy A, which fails its startup verdict while copy B is listed, answers not ready (a retry reaches B)', async () => {
      const sent = [];
      const devA = proxy('d-h29', sent);
      const devB = proxy('d-h29', sent);
      let answerA = null;
      const dm = manager({'d-h29': devA}, (cb) => { answerA = cb; }, [], {n: 0});
      const answers = [];
      DeviceManager.prototype.invokeAction.call(dm, devA, 'd-h29', 'svc', 'act', {input: {}}, session(answers));
      dm.verificationPass(null);
      dm.deviceMap['d-h29'] = devB;
      answerA(new Error('a target not declared'));
      await turns();
      await turns();
      assert.deepStrictEqual([sent.length, answers], [0, ['CTX_CALL_NOT_READY']]);
    });

    it('a call held on a session\'s worker whose record is closing (its unload) answers as a fresh call then: going', async () => {
      const {SessionModuleRecord} = require('../../lib/session-module-record');
      const sent = [];
      const rec = Object.assign(Object.create(SessionModuleRecord.prototype), {hostModuleName: 'held', deviceList: {'d-h30': {}}, bindings: {}, closing: true});
      const wm = Object.assign(proxy('d-h30', sent), {bindings: rec.bindings});
      const dm = manager({'d-h30': rec}, () => {}, [], {n: 0});
      dm.moduleManager = {endedStateForDevice: () => ({code: 'MODULE_UNLOADED', name: 'held'})};
      const errs = [];
      const s = session([]);
      s.callback = (e) => errs.push(e && e.code);
      DeviceManager.prototype.invokeAction.call(dm, wm, 'd-h30', 'svc', 'act', {input: {}}, s);
      wm.exited = true;
      DeviceManager.releaseHeldOn(wm);
      await turns();
      assert.deepStrictEqual([sent.length, errs], [0, ['MODULE_UNLOADED']]);
    });

    it('a held run\'s bound follows its session\'s tightened request timeout', async () => {
      const settings = require('../../lib/session-settings');
      const sid = `s-${hex()}`;
      const savedOf = settings.limitsOf;
      settings.limitsOf = (id) => (id === sid ? {requestTimeout: 3000, maxOutputBytes: null} : savedOf(id));
      const answered = [];
      try {
        DeviceManager.prototype.invokeJobs.call({}, proxy('d-h31', []), 'd-h31', 'svc', 'act', {}, 'job-h31', (err) => answered.push(err && err.code), {ownerKey: `owner-${hex()}`, session: sid});
        // (a 3 s tightening: a hold of 1 s; the global 30 s would hold it 25 s)
        await until(() => answered.length > 0, 10000, 'the run answered at its session\'s bound');
      } finally {
        settings.limitsOf = savedOf;
      }
      assert.deepStrictEqual(answered, ['CTX_CALL_NOT_READY']);
    });

    it('a held run whose stored limits are malformed is held and run with the defaults, as an unheld run is', async () => {
      const sent = [];
      const answered = [];
      const dev = proxy('d-h32', sent);
      const dm = manager({'d-h32': dev}, bound, [], {n: 0});
      DeviceManager.prototype.invokeJobs.call(dm, dev, 'd-h32', 'svc', 'act', {}, 'job-h32', (err) => answered.push(err && err.code), {ownerKey: `owner-${hex()}`, limits: {requestTimeout: 'soon', maxOutputBytes: -1}});
      await turns();
      assert.deepStrictEqual([sent.length, answered], [0, []], 'refused instead of held');
      dm.verificationPass(null);
      await turns();
      await turns();
      assert.deepStrictEqual([sent.length, answered], [1, []]);
      tokens().drop(sent[0].args.token);
    });

    // a release only to the copy still serving: never into a worker that ended in the release's own turn, nor into a copy replaced since
    // (sent: what reached the worker, so nothing sent means no handler ran)
    it('a release whose target exits in the release\'s own turn sends nothing, answered as a fresh call then (gone)', async () => {
      const sent = [];
      const dev = proxy('d-h33', sent);
      const dm = manager({'d-h33': dev}, bound, [], {n: 0});
      const errs = [];
      const s = session([]);
      s.callback = (e) => errs.push(e);
      DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h33', 'svc', 'act', {input: {}}, s);
      dm.verificationPass(null);   // the relay acknowledged at once: the release queued
      dev.exited = true;           // and the worker exits in that same turn (the exit handler marks it, then releases)
      DeviceManager.releaseHeldOn(dev);
      await turns();
      await turns();
      assert.deepStrictEqual([sent.length, ...uniform(errs)], [0, 1, 'DEVICE_NOT_FOUND', true]);
    });

    it('a release on a late ack from a copy replaced since sends nothing to it, answered not ready (the retry reaches the new copy)', async () => {
      const sent = [];
      const devA = proxy('d-h34', sent);
      const devB = proxy('d-h34', []);
      const dm = manager({'d-h34': devA}, bound, [], {n: 0});
      let ack = null;
      dm.relayComposition = (d, msg, cb) => { ack = cb; };
      const answers = [];
      DeviceManager.prototype.invokeAction.call(dm, devA, 'd-h34', 'svc', 'act', {input: {}}, session(answers));
      dm.verificationPass(null);
      dm.deviceMap['d-h34'] = devB;   // a reload (not in place) replaced A while A's relay was in flight
      ack(null);
      await turns();
      await turns();
      assert.deepStrictEqual([sent.length, answers], [0, ['CTX_CALL_NOT_READY']]);
    });

    it('a call released after a hold has its token dropped at its caller\'s deadline, not a full timeout later (its hops neither run nor bill)', async () => {
      cli.setOptions({workerThread: true, requestTimeout: 4});   // seconds: a full timeout of 4 s from the release
      const sent = [];
      const dev = proxy('d-h36', sent);
      const dm = manager({'d-h36': dev}, bound, [], {n: 0});
      const s = session([]);
      s.deadline = Date.now() + 1500;   // (its clock started before the hold: 1.5 s left of it)
      DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h36', 'svc', 'act', {input: {}}, s);
      dm.verificationPass(null);
      await turns();
      await turns();
      assert.strictEqual(sent.length, 1);
      const token = sent[0].args.token;
      await until(() => tokens().resolve(token, {workerId: dev.workerId}) == null, 3000, 'the token dropped at the caller\'s deadline');
    });

    it('a run released after a hold has its token bounded by the run\'s own clock, which started before the hold', async () => {
      const sent = [];
      const controlSent = [];
      const dev = proxy('d-h37', sent);
      const control = proxy('d-h37', controlSent);
      control.bindings = {'d-h37': {identity: 'k', module: 'm', targets: new Set()}};
      const dm = manager({'d-h37': dev}, bound, [], {n: 0});
      let ack = null;
      dm.relayComposition = (d, msg, cb) => { ack = cb; };
      const extra = () => ({ownerKey: `owner-${hex()}`, timeoutMs: 20000});
      DeviceManager.prototype.invokeJobs.call(dm, dev, 'd-h37', 'svc', 'act', {}, 'job-h37', () => {}, extra());
      DeviceManager.prototype.invokeJobs.call({}, control, 'd-h37', 'svc', 'act', {}, 'job-h37c', () => {}, extra());   // (unheld: issued now)
      dm.verificationPass(null);
      await new Promise((r) => setTimeout(r, 800));   // (held this long before its verdict is delivered)
      ack(null);
      await turns();
      await turns();
      assert.strictEqual(sent.length, 1);
      const held = tokens().resolve(sent[0].args.token, {workerId: dev.workerId});
      const unheld = tokens().resolve(controlSent[0].args.token, {workerId: control.workerId});
      assert.ok(held != null && unheld != null && held.expires - unheld.expires < 400, `the held run's token outlives its clock by ${held && unheld ? held.expires - unheld.expires : '?'} ms`);
      tokens().drop(sent[0].args.token);
      tokens().drop(controlSent[0].args.token);
    });

    it('a call whose session ended during the hold is never sent: the ended answer', async () => {
      const sessionsLib = require('../../lib/sessions');
      const savedLive = sessionsLib.live;
      const sid = `s-${hex()}`;
      let open = true;
      sessionsLib.live = (id) => (id === sid ? open : savedLive(id));
      const sent = [];
      const dev = proxy('d-h38', sent);
      const dm = manager({'d-h38': dev}, bound, [], {n: 0});
      const errs = [];
      const s = session([]);
      s.sessionId = sid;
      s.callback = (e) => errs.push(e && e.code);
      try {
        DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h38', 'svc', 'act', {input: {}}, s);
        open = false;
        dm.verificationPass(null);
        await turns();
        await turns();
      } finally {
        sessionsLib.live = savedLive;
      }
      assert.deepStrictEqual([sent.length, errs], [0, ['MODULE_NOT_LISTED']]);
    });

    it('a call whose grant was revoked during the hold is refused at its release by the main thread\'s own check: the uniform answer', async () => {
      const sent = [];
      const dev = proxy('d-h39', sent);
      const dm = manager({'d-h39': dev}, bound, [], {n: 0});
      const errs = [];
      const s = session([]);
      s.callback = (e) => errs.push(e);
      DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h39', 'svc', 'act', {input: {}}, s);
      revoked.add(s.appKey);
      dm.verificationPass(null);
      await turns();
      await turns();
      assert.deepStrictEqual([sent.length, ...uniform(errs)], [0, 1, 'DEVICE_NOT_FOUND', true]);
    });

    it('a call held on a session\'s worker of the listed record stays held when another copy\'s verdict lands', async () => {
      cli.setOptions({workerThread: true, requestTimeout: 3});   // seconds: a hold of 1 s
      const {SessionModuleRecord} = require('../../lib/session-module-record');
      const sent = [];
      const devA = proxy('d-h40', []);
      const rec = Object.assign(Object.create(SessionModuleRecord.prototype), {hostModuleName: 'held', deviceList: {'d-h40': {}}, bindings: {}});
      const wm = Object.assign(proxy('d-h40', sent), {bindings: rec.bindings});
      let answerA = null;
      const dm = manager({'d-h40': devA}, (cb) => { answerA = cb; }, [], {n: 0});
      dm.verificationPass(null);
      dm.deviceMap['d-h40'] = rec;
      const answers = [];
      DeviceManager.prototype.invokeAction.call(dm, wm, 'd-h40', 'svc', 'act', {input: {}}, session(answers));
      bound(answerA);   // A's verdict delivered on A
      await turns();
      await turns();
      assert.deepStrictEqual([sent.length, answers], [0, []], 'ended by another copy\'s verdict');
      await until(() => answers.length > 0, 5000, 'answered at its own bound');
    });

    it('a held task creation whose end throws while it decides its answer is still answered, with the uniform answer', async () => {
      cli.setOptions({workerThread: true, requestTimeout: 3});   // seconds: a hold of 1 s
      const dm = manager({'d-h41': proxy('d-h41', [])}, () => {}, [], {n: 0});
      dm.heldAnswerNow = () => { throw new Error('deciding the answer threw'); };
      const decided = [];
      dm.untilVerdict('d-h41', null, (d, err) => decided.push(d, err && err.code));
      await until(() => decided.length > 0, 5000, 'the creation answered');
      assert.deepStrictEqual(decided, ['purged', 'DEVICE_NOT_FOUND']);
    });

    it('a task creation whose grant was revoked during its hold is refused at its release, as a fresh creation is: the uniform answer', () => {
      const child = `
        const W = process.argv[1];
        const authPath = require.resolve(W + '/lib/user-auth');
        let checks = 0;
        // (the creation's own check passes; the grant is gone by the release's)
        require.cache[authPath] = {id: authPath, filename: authPath, loaded: true, exports: (a, b, c, d, e, f, g, cb) => (++checks === 1 ? cb(null, {}) : cb(Object.assign(new Error('no grant'), {code: 'DEVICE_ACCESS_DENIED'})))};
        require(W + '/lib/cli-options').setOptions({workerThread: true, requestTimeout: 30});
        require(W + '/lib/logger').createLogger();
        const gw = require(W + '/lib/mcp/gateway');
        const dm = {untilVerdict: (id, limits, cb) => setImmediate(() => cb('landed', undefined, true))};
        gw.createTaskForToolCallFor({id: 7, params: {name: 'held_tool'}}, {deviceManager: dm}, {deviceID: 'd-n4', serviceID: 's', actionName: 'a', name: 'held_tool'},
          {}, null, (err, res) => { console.log(JSON.stringify({res, checks})); process.exit(0); }, null, null, false, null);
        setTimeout(() => { console.log('{}'); process.exit(3); }, 5000);`;
      const r = require('child_process').spawnSync(process.execPath, ['-e', child, ROOT], {encoding: 'utf8', timeout: 30000});
      const out = JSON.parse(r.stdout.trim().split('\n').pop());
      assert.deepStrictEqual([out.checks, out.res && out.res.error && out.res.error.code, out.res && out.res.error && /^unknown tool: held_tool/.test(out.res.error.message)], [2, -32602, true], r.stdout + r.stderr);
    });

    it('a module turned off while a release reads its caller\'s grant: no handler runs, the uniform answer', async () => {
      const visibility = require('../../lib/module-visibility');
      const sent = [];
      const dev = proxy('d-h42', sent);
      const dm = manager({'d-h42': dev}, bound, [], {n: 0});
      const errs = [];
      const s = session([]);
      s.callback = (e) => errs.push(e);
      const before = visibility.configure({moduleOf: (id) => (id === 'd-h42' ? 'held-off-lookup' : null), changed: () => {}});
      try {
        DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h42', 'svc', 'act', {input: {}}, s);
        duringLookup = () => visibility.hide(['held-off-lookup']);   // (listed when the release began; off by the time the lookup answers)
        dm.verificationPass(null);
        await turns();
        await turns();
        await turns();
      } finally {
        visibility.show(['held-off-lookup']);
        visibility.configure(before);
      }
      assert.deepStrictEqual([sent.length, ...uniform(errs)], [0, 1, 'DEVICE_NOT_FOUND', true]);
    });

    it('over REST, a held call released gone (purged at its verdict, its grant revoked) is the route\'s one answer for a device the caller can\'t use', () => {
      const {oneAnswerFor} = require('../../lib/routes/invoke-action');
      const {CountinghouseError} = require('../../lib/countinghouse-error');
      const gone = new CountinghouseError('DEVICE_NOT_FOUND');
      Object.defineProperty(gone, 'goneAtVerdict', {value: true, enumerable: false});
      // (the scope is not even asked: the main thread's own mark decides)
      const answer = oneAnswerFor(null, 'd-h43')(gone);
      const fresh = require('../../lib/listing-scope').notAvailable();
      assert.deepStrictEqual([answer.code, answer.message], [fresh.code, fresh.message]);
      assert.strictEqual(answer.code, 'MODULE_NOT_LISTED');
    });

    it('the held-call test hook writes nothing without the suite\'s marker, whatever COUNTINGHOUSE_TEST_HELD_LOG says', async () => {
      const saved = {marker: process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG, held: process.env.COUNTINGHOUSE_TEST_HELD_LOG};
      const savedI = LOG.I;
      const said = [];
      LOG.I = (m) => said.push(String(m && m.message ? m.message : m));
      const put = (k, v) => { if (v == null) delete process.env[k]; else process.env[k] = v; };
      try {
        const seen = [];
        for (const marker of [undefined, '1']) {
          put('COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG', marker);
          put('COUNTINGHOUSE_TEST_HELD_LOG', '1');
          said.length = 0;
          let ended = false;
          const dm = manager({'d-h44': proxy('d-h44', [])}, () => {}, [], {n: 0});
          dm.untilVerdict('d-h44', {requestTimeout: 2100}, () => { ended = true; });   // (a hold of 100 ms)
          await until(() => ended, 5000, 'the hold ended');
          seen.push(said.filter((l) => /test hook: a call held for/.test(l)).length);
        }
        // (none without the marker; its start and its end with it, the control)
        assert.deepStrictEqual(seen, [0, 2]);
      } finally {
        LOG.I = savedI;
        put('COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG', saved.marker);
        put('COUNTINGHOUSE_TEST_HELD_LOG', saved.held);
      }
    });

    // a held run's release has no caller lookup after it: the end's own listing and serving checks are its only ones
    it('a held run whose module is turned off during the hold never runs: the uniform answer', async () => {
      const visibility = require('../../lib/module-visibility');
      const sent = [];
      const answered = [];
      const dev = proxy('d-h45', sent);
      const dm = manager({'d-h45': dev}, bound, [], {n: 0});
      const before = visibility.configure({moduleOf: (id) => (id === 'd-h45' ? 'held-off-run' : null), changed: () => {}});
      try {
        DeviceManager.prototype.invokeJobs.call(dm, dev, 'd-h45', 'svc', 'act', {}, 'job-h45', (err) => answered.push(err && err.code), {ownerKey: `owner-${hex()}`});
        visibility.hide(['held-off-run']);
        dm.verificationPass(null);
        await turns();
        await turns();
      } finally {
        visibility.show(['held-off-run']);
        visibility.configure(before);
      }
      assert.deepStrictEqual([sent.length, answered], [0, ['DEVICE_NOT_FOUND']]);
    });

    it('a held run whose target exits in the release\'s own turn never runs', async () => {
      const sent = [];
      const answered = [];
      const dev = proxy('d-h46', sent);
      const dm = manager({'d-h46': dev}, bound, [], {n: 0});
      DeviceManager.prototype.invokeJobs.call(dm, dev, 'd-h46', 'svc', 'act', {}, 'job-h46', (err) => answered.push(err && err.code), {ownerKey: `owner-${hex()}`});
      dm.verificationPass(null);
      dev.exited = true;
      DeviceManager.releaseHeldOn(dev);
      await turns();
      await turns();
      assert.deepStrictEqual([sent.length, answered], [0, ['DEVICE_NOT_FOUND']]);
    });

    for (const [what, during, want] of [
      ['its target replaced', (dm, dev, other) => { dm.deviceMap['d-h47'] = other; }, 'CTX_CALL_NOT_READY'],
      ['its target unloading (an in-place reload\'s drain read it idle)', (dm, dev) => { dev.unloading = true; }, 'CTX_CALL_NOT_READY']]) {
      it(`a release whose target stops serving while it reads its caller's grant sends nothing: ${what}`, async () => {
        const sent = [];
        const dev = proxy('d-h47', sent);
        const other = proxy('d-h47', []);
        const dm = manager({'d-h47': dev}, bound, [], {n: 0});
        const errs = [];
        const s = session([]);
        s.callback = (e) => errs.push(e && e.code);
        DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h47', 'svc', 'act', {input: {}}, s);
        duringLookup = () => during(dm, dev, other);
        dm.verificationPass(null);
        await turns();
        await turns();
        await turns();
        assert.deepStrictEqual([sent.length, errs], [0, [want]]);
      });
    }

    it('a throw in a release\'s check after its caller\'s lookup is logged and answered with the uniform answer, never with an internal object', async () => {
      const sent = [];
      const dev = proxy('d-h48', sent);
      const dm = manager({'d-h48': dev}, bound, [], {n: 0});
      const answers = [];
      const s = session([]);
      s.callback = (e, data) => answers.push([e && e.code, e != null && e.goneAtVerdict === true, data == null]);
      DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h48', 'svc', 'act', {input: {}}, s);
      duringLookup = () => { dm.listedNow = () => { throw new Error('the listing check threw'); }; };
      dm.verificationPass(null);
      await turns();
      await turns();
      await turns();
      assert.deepStrictEqual([sent.length, answers], [0, [['DEVICE_NOT_FOUND', true, true]]]);
      assert.ok(logged.some((l) => /listing check threw/.test(l)), JSON.stringify(logged));
    });

    it('a held call never keeps the process alive: its timer and its poll are unref\'d', () => {
      const child = `
        const W = process.argv[1];
        require(W + '/lib/cli-options').setOptions({workerThread: true, requestTimeout: 30});
        const DeviceManager = require(W + '/lib/device-manager');
        const dm = Object.assign(Object.create(DeviceManager.prototype), {deviceMap: {'d-x': {bindings: null, workerId: 1}}});
        dm.untilVerdict('d-x', null, () => {});
        console.log('held', DeviceManager.verdictHeldOn(dm.deviceMap['d-x']));`;
      // (exited on its own, before its 15 s timeout: the hold is 25 s)
      const r = require('child_process').spawnSync(process.execPath, ['-e', child, ROOT], {encoding: 'utf8', timeout: 15000});
      assert.deepStrictEqual([r.status, r.signal, r.stdout.trim()], [0, null, 'held 1'], r.stderr);
    });

    it('two ends of one held call in the same turn answer it once (a worker\'s exit and its purge)', async () => {
      const sent = [];
      const dev = proxy('d-h20', sent);
      const dm = manager({'d-h20': dev}, () => {}, [], {n: 0});
      const errs = [];
      const s = session([]);
      s.callback = (e) => errs.push(e && e.code);
      DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h20', 'svc', 'act', {input: {}}, s);
      DeviceManager.releaseHeldOn(dev);
      await purging(dm, dev);
      await turns();
      assert.deepStrictEqual([sent.length, errs.length], [0, 1]);
    });

    it('a held call is a call in flight for a drain: an in-place reload\'s and a session worker pool\'s', async () => {
      const sent = [];
      const dev = Object.assign(proxy('d-h8', sent), {msgQueue: {}, inFlight: () => false});
      const dm = manager({'d-h8': dev}, bound, [], {n: 0});
      const ModuleManager = require('../../lib/module-manager');
      const {owedBy} = require('../../lib/modules-in-place');
      assert.deepStrictEqual([owedBy(dev, dm), ModuleManager.workerBusy(dev)], [0, false]);
      DeviceManager.prototype.invokeAction.call(dm, dev, 'd-h8', 'svc', 'act', {input: {}}, session([]));
      assert.deepStrictEqual([owedBy(dev, dm), ModuleManager.workerBusy(dev)], [1, true], 'a held call was not counted');
      dm.verificationPass(null);
      await turns();
      // sent now: no longer held (a queued call from here on)
      assert.deepStrictEqual([sent.length, DeviceManager.verdictHeldOn(dev)], [1, 0]);
      tokens().drop(sent[0].args.token);
    });
  });

  // The review of #138 (9): the unknown-key answer named the key.
  describe('SYSTEM_ERROR_UNKNOWN_USER', () => {
    it('(#138-9) names no key, from the file provider', async () => {
      const FileAuthProvider = require('../../lib/auth/file-provider');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-18-unknown-'));
      try {
        fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({[`known-${hex()}`]: {userName: 'known', devices: ['*']}}), {mode: 0o600});
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

    // (C-meter-keys-3: the record names the caller by id and holds each key
    // it was granted under by its meterId; the re-check asks the provider for
    // the key the identity index lists for the id)
    it('(T4-review) a re-check asks for the key the index lists for the id: kept while granted, closed once revoked, closed for a key no longer the id\'s', async () => {
      const authPath = require.resolve('../../lib/user-auth');
      const idPath = require.resolve('../../lib/identity');
      const brokerPath = require.resolve('../../lib/peer-channel-broker');
      const savedAuth = require.cache[authPath];
      const savedId = require.cache[idPath];
      const revoked = new Set();
      const asked = [];
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
        exports: (a, b, deviceID, appKey, c, d, localCB, cb) => { asked.push(appKey); setImmediate(() => cb(revoked.has(appKey) ? Object.assign(new Error('revoked'), {code: 'USER_HAS_NO_DEVICE'}) : null)); }};
      const listed = (id) => (id === 'u_same' ? {apiKey: 'k1', userName: null, isAdmin: false} : null);
      // (the index's answer at once, or -- as on a miss -- later)
      let later = false;
      require.cache[idPath] = {id: idPath, filename: idPath, loaded: true, exports: Object.assign({}, require('../../lib/identity'), {idForKey: () => 'u_same',
        lookup: listed, resolve: (id, provider, cb) => (later ? setImmediate(() => cb(null, listed(id))) : cb(null, listed(id)))})};
      delete require.cache[brokerPath];
      const until = async (f) => { for (let i = 0; i < 400 && !f(); i++) await sleep(5); return f(); };
      const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
      const keptOptions = optionsNow();
      try {
        cli.setOptions({workerThread: true, peerChannelAuthRecheckSeconds: 0, peerChannelAuthLookupTimeoutMs: 2000});
        const PeerChannelBroker = require('../../lib/peer-channel-broker');
        const open = (b) => {
          const callee = {workerId: 52, ended: null, unloading: false, sendPeerChannelOpenToChild: () => {}, sendPeerChannelAllowToChild: (m, cb) => cb(null), sendPeerInvalidateToChild: () => {}};
          const caller = {workerId: 51, ended: null, unloading: false, sendPeerChannelGrantToChild: () => {}, sendPeerInvalidateToChild: () => {}};
          b.grant('d', 'k1', caller, callee, ['svc|act']);
          return {caller, callee};
        };
        const b = new PeerChannelBroker({deviceMap: {}});
        const closes = [];
        const realClose = b.closeRevoked.bind(b);
        b.closeRevoked = (pairKey, entry, grant, err) => { closes.push(err); return realClose(pairKey, entry, grant, err); };
        open(b);
        const grants = b.channelRegistry['51:52'].grants;
        assert.strictEqual(Object.keys(grants).length, 1, 'one record per identity and device');
        assert.ok(!JSON.stringify([...Object.values(grants)[0].meters]).includes('k1'), 'the record holds no key');
        b.recheckGrants();
        assert.ok(await until(() => b.recheckInFlight === 0));
        assert.deepStrictEqual(asked, ['k1'], 'asked for the listed key');
        assert.ok(b.channelRegistry['51:52'] != null, 'granted: kept');
        revoked.add('k1');
        b.recheckGrants();
        assert.ok(await until(() => b.channelRegistry['51:52'] === undefined), 'the channel stayed open after its key was revoked');
        assert.strictEqual(closes[0].code, 'USER_HAS_NO_DEVICE', 'closed by the provider\'s answer');
        // a key granted under the id that is no longer the id's (rotated):
        // closed before the provider is asked
        revoked.clear();
        asked.length = 0;
        const again = open(b);
        // (and a second device's record on the same pair, listed and granted:
        // once the pair is closed it asks nothing)
        b.grant('d2', 'k1', again.caller, again.callee, ['svc|act']);
        b.grant('d', 'k0-rotated-away', again.caller, again.callee, ['svc|act']);
        b.recheckGrants();
        assert.ok(await until(() => b.channelRegistry['51:52'] === undefined));
        assert.strictEqual(closes[1].closeReason, 'a key it was granted under is no longer its key');
        assert.deepStrictEqual(asked, []);
        assert.strictEqual(b.recheckInFlight, 0);
        // the same with the index answering later: the other record's answer
        // comes once the pair is closed, and asks nothing
        later = true;
        const third = open(b);
        b.grant('d2', 'k1', third.caller, third.callee, ['svc|act']);
        b.grant('d', 'k0-rotated-away', third.caller, third.callee, ['svc|act']);
        b.recheckGrants();
        assert.ok(await until(() => b.recheckInFlight === 0));
        assert.strictEqual(b.channelRegistry['51:52'], undefined);
        assert.deepStrictEqual(asked, []);
        assert.strictEqual(closes.length, 3, 'closed once');
      } finally {
        if (savedAuth != null) require.cache[authPath] = savedAuth; else delete require.cache[authPath];
        if (savedId != null) require.cache[idPath] = savedId; else delete require.cache[idPath];
        delete require.cache[brokerPath];
        restoreOptions(keptOptions);
      }
    });

    it('(4) a hung auth lookup times out and closes the channel; later re-checks still run', async () => {
      const authPath = require.resolve('../../lib/user-auth');
      const brokerPath = require.resolve('../../lib/peer-channel-broker');
      const savedAuth = require.cache[authPath];
      let lookups = 0;
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true, exports: () => { lookups++; }};   // never answers
      // (the record names the caller by id; the index lists its key)
      const idPath = require.resolve('../../lib/identity');
      const savedId = require.cache[idPath];
      require.cache[idPath] = {id: idPath, filename: idPath, loaded: true, exports: Object.assign({}, require('../../lib/identity'), {
        lookup: (id) => (id === 'u_k' ? {apiKey: 'k', userName: null, isAdmin: false} : null),
        resolve: (id, provider, cb) => cb(null, id === 'u_k' ? {apiKey: 'k', userName: null, isAdmin: false} : null)})};
      const record = () => ({g: {id: 'u_k', deviceID: 'd', meters: new Set([require('../../lib/key-fingerprint').meterId('k')])}});
      delete require.cache[brokerPath];
      try {
        cli.setOptions({workerThread: true, peerChannelAuthRecheckSeconds: 0, peerChannelAuthLookupTimeoutMs: 200});
        const PeerChannelBroker = require('../../lib/peer-channel-broker');
        const broker = new PeerChannelBroker({deviceMap: {}});
        const closed = [];
        broker.closeRevoked = (pairKey) => { closed.push(pairKey); delete broker.channelRegistry[pairKey]; };
        broker.channelRegistry['21:22'] = {callerWM: {workerId: 21}, calleeWM: {workerId: 22}, grants: record()};
        broker.recheckGrants();
        await sleep(400);
        assert.deepStrictEqual(closed, ['21:22'], 'the channel behind a hung lookup stayed open');
        assert.strictEqual(broker.recheckInFlight, 0, 'a hung lookup left a re-check in flight');
        broker.channelRegistry['23:24'] = {callerWM: {workerId: 23}, calleeWM: {workerId: 24}, grants: record()};
        const before = lookups;
        broker.recheckGrants();
        assert.ok(lookups > before, 'the next re-check did not run');
      } finally {
        if (savedAuth != null) require.cache[authPath] = savedAuth; else delete require.cache[authPath];
        if (savedId != null) require.cache[idPath] = savedId; else delete require.cache[idPath];
        delete require.cache[brokerPath];
        cli.setOptions({workerThread: false});
      }
    });
  });
});

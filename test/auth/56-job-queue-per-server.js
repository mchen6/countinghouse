'use strict';
// B-j1: each runtime's job queue is its own. The BullMQ prefix was
// '{cdifJob}' for every runtime, so two runtimes on one Redis took each
// other's jobs: a job for a module only one of them loaded ran on the
// other and failed. Now it is named by the server's own id, random and kept
// beside its data (lib/server-id.js; lib/job-control-common.js
// jobQueuePrefix). Two runtimes on one (private) Redis, each with its own
// module data directory and a module the other does not have: every job
// each is given completes, in its own queue. Jobs left under the old shared
// prefix, and history under the old unscoped keys, are not moved: each start
// says so once, read-only, and leaves them.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const {Queue} = require('bullmq');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {testPort, redisConnectionFor, redisUrlFor} = require('../helpers/test-env');
const {prefixFor} = require('../helpers/job-queue');
const {deviceIDForName} = require('../../lib/call-address');
const tmp = require('../helpers/test-tmp').forFile(['ch-auth-56-']);

const KEY = `k${crypto.randomBytes(12).toString('hex')}`;
const RUNTIMES = {
  a: {port: testPort(9733), module: path.join(ROOT, 'test', 'fixtures', 'job-snoop'), device: deviceIDForName('job-snoop'),
    serviceID: 'urn:countinghouse-test:serviceID:jobService', actionName: 'whoami', input: {note: 'n'}},
  b: {port: testPort(9796), module: path.join(ROOT, 'pre-installed-packages', 'echo-device-module'), device: 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767',
    serviceID: 'urn:countinghouse-com:serviceID:echoService', actionName: 'echo', input: {foo: [{item1: 'x'}], bar: 'y'}}
};
// (the count is whatever this Redis holds under the old prefix: the job
// seeded here at least)
const LEGACY_SAID = /job queue: (\d+) jobs? and \d+ schedulers? under the old shared prefix \{cdifJob\} were not moved to this server's queue, and (?:at least )?(\d+) job histor(?:y|ies) under the old jobinfo:<name> keys are not read/g;
const LEGACY_HISTORY = `jobinfo:legacy-56-${process.pid}`;
const LEGACY_NONE = 'countinghouse:legacy-jobs-none';
const PORT_C = testPort(9674);
// the store's job clients (lib/store.js jobClients) on a Redis of the test's
const clientsOn = (redisUrl) => require('../../lib/store').createStore({store: 'redis', redisUrl}).jobClients;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('auth 56: each runtime\'s job queue is its own (B-j1)', function() {
  this.timeout(120000);
  let legacy = null;
  let legacyJob = null;
  let kv = null;   // the store's kv (Redis db 5): a history list left unscoped

  before(async () => {
    // a job left under the shared prefix by a runtime before B-j1
    legacy = new Queue('job-queue', {prefix: '{cdifJob}', connection: redisConnectionFor(11)});
    legacyJob = await legacy.add(`legacy-56-${process.pid}`, {left: true});
    kv = new (require('ioredis'))(redisConnectionFor(5));
    await kv.lpush(LEGACY_HISTORY, JSON.stringify({job: {name: 'legacy-56'}, state: 'completed'}));
    // (a start before this file that found nothing left its flag: this one looks)
    await kv.del(LEGACY_NONE);
    for (const r of Object.values(RUNTIMES)) {
      const dir = tmp.mkdtemp('ch-auth-56-');
      const auth = path.join(dir, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'k', devices: ['*']}}));
      r.dataDir = path.join(dir, 'store');
      r.server = await startServer(r.port, ['--workerThread', '--authProvider', 'file', '--authConfigPath', auth,
        '--moduleDataPath', r.dataDir, '--loadModule', r.module]);
      r.queue = new Queue('job-queue', {prefix: prefixFor(r.dataDir), connection: redisConnectionFor(11)});
    }
  });
  after(async () => {
    for (const r of Object.values(RUNTIMES)) {
      if (r.queue != null) { await r.queue.obliterate({force: true}).catch(() => {}); await r.queue.close(); }
      if (r.server != null) stopServer(r.server);
    }
    if (legacyJob != null) await legacyJob.remove().catch(() => {});
    if (legacy != null) await legacy.close();
    if (kv != null) { await kv.del(LEGACY_HISTORY).catch(() => {}); kv.disconnect(); }
  });

  it('the prefix is the server\'s own: {chj-<its 16-hex id>}, kept in its data directory; another directory, another', () => {
    const [a, b] = Object.values(RUNTIMES).map((r) => prefixFor(r.dataDir));
    for (const p of [a, b]) assert.match(p, /^\{chj-[0-9a-f]{16}\}$/);
    assert.notStrictEqual(a, b);
    for (const r of Object.values(RUNTIMES)) {
      const id = fs.readFileSync(path.join(r.dataDir, '.server-id'), 'utf8');
      assert.strictEqual(prefixFor(r.dataDir), `{chj-${id}}`);
    }
  });

  it('two runtimes on one Redis each run only their own jobs, and every one completes', async () => {
    const added = {a: [], b: []};
    for (let i = 0; i < 8; i++) {
      for (const [name, r] of Object.entries(RUNTIMES)) {
        const res = await request(`http://127.0.0.1:${r.port}`).post(`/devices/${r.device}/add-job`).set('X-CH-Key', KEY)
          .send({serviceID: r.serviceID, actionName: r.actionName, opts: {name: `own-56-${i}`}, input: r.input});
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        added[name].push(res.body.id);
      }
    }
    const states = async () => {
      const out = {};
      for (const [name, r] of Object.entries(RUNTIMES)) {
        out[name] = await Promise.all(added[name].map(async (id) => { const j = await r.queue.getJob(id); return j == null ? 'missing' : j.getState(); }));
      }
      return out;
    };
    let seen = null;
    for (const end = Date.now() + 30000; Date.now() < end; await sleep(250)) {
      seen = await states();
      if (Object.values(seen).every((list) => list.every((s) => s === 'completed' || s === 'failed'))) break;
    }
    assert.deepStrictEqual(seen, {a: Array(8).fill('completed'), b: Array(8).fill('completed')});
    // (the jobs' history is each server's own list too: one name, two
    // servers, ids that now repeat across them)
    for (const r of Object.values(RUNTIMES)) {
      const h = await request(`http://127.0.0.1:${r.port}`).post(`/devices/${r.device}/get-job-history`).set('X-CH-Key', KEY).send({name: 'own-56-0'});
      assert.strictEqual(h.status, 200, JSON.stringify(h.body));
      const records = Array.isArray(h.body) ? h.body : [];
      assert.ok(records.length >= 1, JSON.stringify(h.body));
      assert.ok(records.every((x) => x.job != null && x.job.data != null && x.job.data.deviceID === r.device), JSON.stringify(records).slice(0, 800));
    }
  });

  it('a start with a copied .server-id, while the server it was copied from runs, is refused (exit 2), naming the fix (round 2, 3)', async () => {
    const dir = tmp.mkdtemp('ch-auth-56-');
    const auth = path.join(dir, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'k', devices: ['*']}}));
    const dataDir = path.join(dir, 'store');
    fs.mkdirSync(dataDir, {recursive: true, mode: 0o700});
    fs.writeFileSync(path.join(dataDir, '.server-id'), fs.readFileSync(path.join(RUNTIMES.a.dataDir, '.server-id')), {mode: 0o600});
    // (refused once its claim's holder is seen to renew: a heartbeat, 10 s, and more)
    const c = await startServer(PORT_C, ['--workerThread', '--authProvider', 'file', '--authConfigPath', auth,
      '--moduleDataPath', dataDir, '--loadModule', RUNTIMES.b.module], {expectExit: true, exitWithinMs: 45000});
    assert.strictEqual(c.exitCode, 2, c.output.slice(-2000));
    // refused before it served: it never said it was ready
    assert.ok(!/countinghouse ready/.test(c.output), c.output.slice(-2000));
    assert.match(c.output, /another server is using this data directory's server id \(.*\.server-id\): .* pid \d+ \(since .*\) holds its claim on Redis; give each server its own --moduleDataPath/);
  });

  it('a job left under the old shared prefix, and an unscoped history, are said once by each start, and left where they are', async () => {
    // (said once its counts are read, after the start: waited for)
    const once = new RegExp(LEGACY_SAID.source);
    for (const r of Object.values(RUNTIMES)) {
      for (const end = Date.now() + 15000; Date.now() < end && !once.test(r.server.output);) await sleep(100);
      const said = [...r.server.output.matchAll(LEGACY_SAID)];
      assert.strictEqual(said.length, 1, r.server.output.slice(-2000));
      assert.ok(Number(said[0][1]) >= 1, said[0][0]);
      assert.ok(Number(said[0][2]) >= 1, said[0][0]);
    }
    assert.strictEqual(await (await legacy.getJob(legacyJob.id)).getState(), 'waiting');
    assert.strictEqual(await kv.llen(LEGACY_HISTORY), 1, 'the old history list is read, never changed');
  });

  tmp.hooks();
});

// A count that cannot be made is said, and nothing is left connected (the
// medium review of #463's rework): a Redis nothing listens on.
describe('auth 56: the old prefix\'s count, when Redis does not answer', function() {
  this.timeout(30000);
  const LOG = require('../../lib/logger');
  let saved = null;
  const said = [];
  // (a bare process has no logger set up: its W and E are this test's)
  before(() => { saved = {W: LOG.W, E: LOG.E}; LOG.W = (m) => { said.push(String(m)); }; LOG.E = () => {}; });
  after(() => { if (saved != null) Object.assign(LOG, saved); });

  it('says it could not count, and moves or reads nothing', async () => {
    const net = require('net');
    const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const JobControl = require('../../lib/job-control');
    assert.strictEqual(await JobControl.countLegacy(clientsOn(`redis://127.0.0.1:${port}`)), false);
    assert.ok(said.some((m) => /could not be counted .*; none of it is moved or read/.test(m)), JSON.stringify(said));
  });
});

// The claim itself (lib/server-claim.js), on this file's Redis.
describe('auth 56: one live runtime per server id (round 2, 3)', function() {
  this.timeout(30000);
  const os = require('os');
  const {claim, keyFor} = require('../../lib/server-claim');
  // (a heartbeat of 300 ms, a claim of 1 s: the watch takes a heartbeat and
  // its slack, here 500 ms)
  const FAST = {renewMs: 300, ttlMs: 1000, retryMs: 100, watchSlackMs: 200};
  let kv = null;
  const prefix = () => `{chj-${crypto.randomBytes(8).toString('hex')}}`;
  const made = [];
  before(() => { kv = new (require('ioredis'))(redisConnectionFor(11)); });
  after(async () => {
    for (const c of made) await c.stop().catch(() => {});
    if (kv != null) kv.disconnect();
  });

  it('a claim nobody renews (a crash, a replaced pod: any host, any pid) is taken over after one heartbeat', async () => {
    const p = prefix();
    const stale = {host: 'another-host', pid: 1, nonce: 'gone', since: 'then'};
    await kv.set(keyFor(p), JSON.stringify(stale), 'PX', 30000);
    const c = claim(clientsOn(redisUrlFor()), p, Object.assign({onRefused: () => assert.fail('refused')}, FAST));
    made.push(c);
    await c.held;
    assert.strictEqual(JSON.parse(await kv.get(keyFor(p))).pid, process.pid);
    await c.decided;
    await c.stop();
    assert.strictEqual(await kv.get(keyFor(p)), null, 'released at stop');
  });

  it('a holder of this host and pid namespace whose pid is gone (a kill, a crash) is taken over at once, without the watch', async () => {
    const p = prefix();
    const dead = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {encoding: 'utf8'});
    let ns = null;
    try { ns = fs.readlinkSync('/proc/self/ns/pid'); } catch (e) { ns = null; }
    await kv.set(keyFor(p), JSON.stringify({host: os.hostname(), pid: Number(dead.stdout), pidns: ns, nonce: 'killed', since: 'then'}), 'PX', 30000);
    // (no watch: a heartbeat of 20 s here would time the case out)
    const c = claim(clientsOn(redisUrlFor()), p, Object.assign({onRefused: () => assert.fail('refused')}, FAST, {renewMs: 20000}));
    made.push(c);
    const t0 = Date.now();
    await c.held;
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    assert.strictEqual(JSON.parse(await kv.get(keyFor(p))).pid, process.pid);
  });

  it('a held claim keeps no process alive: one whose work is done exits, its claim held (it lapses)', async () => {
    // (the hang of #463's first round 2 CI: a test run ended its tests and
    // stayed up an hour on the claim's connection)
    const lib = (m) => JSON.stringify(path.join(ROOT, 'lib', m));
    const p = prefix();
    const r = require('child_process').spawnSync(process.execPath, ['-e', `
      const clients = require(${lib('store')}).createStore({store: 'redis', redisUrl: ${JSON.stringify(redisUrlFor())}}).jobClients;
      // (its own work keeps it up until the claim is held: as a server's listener does)
      const work = setInterval(() => {}, 1000);
      require(${lib('server-claim')}).claim(clients, ${JSON.stringify(p)}, {renewMs: 200, ttlMs: 2000}).held.then(() => { process.stdout.write('held'); clearInterval(work); });`],
    {encoding: 'utf8', timeout: 15000});
    assert.strictEqual(r.signal, null, `killed at the timeout: still alive (${r.stderr})`);
    assert.strictEqual(r.stdout, 'held', r.stderr);
    assert.ok(JSON.parse(await kv.get(keyFor(p))).pid > 0, 'its claim was made');
    await kv.del(keyFor(p));
  });

  it('a holder that renews is alive, whatever its host and pid -- this very host and pid too (two containers, each pid 1) -- and refuses', async () => {
    const p = prefix();
    const twin = {host: os.hostname(), pid: process.pid, nonce: 'twin', since: 'now'};
    await kv.set(keyFor(p), JSON.stringify(twin), 'PX', 1000);
    const beat = setInterval(() => { kv.pexpire(keyFor(p), 1000).catch(() => {}); }, 150);
    try {
      const refused = await new Promise((resolve) => { made.push(claim(clientsOn(redisUrlFor()), p, Object.assign({onRefused: resolve}, FAST))); });
      assert.deepStrictEqual(refused, twin);
      assert.deepStrictEqual(JSON.parse(await kv.get(keyFor(p))), twin, 'left as it was');
    } finally {
      clearInterval(beat);
      await kv.del(keyFor(p));
    }
  });

  it('a claim lost while this one\'s lapsed pauses the worker (onLost), and its return resumes it (onRegained)', async () => {
    const p = prefix();
    const events = [];
    const c = claim(clientsOn(redisUrlFor()), p, Object.assign({onLost: (h) => events.push(['lost', h.nonce]), onRegained: () => events.push(['regained'])}, FAST));
    made.push(c);
    await c.held;
    // another runtime takes it while this one's heartbeat is away
    await kv.set(keyFor(p), JSON.stringify({host: 'other', pid: 2, nonce: 'thief', since: 'now'}), 'PX', 600);
    for (const end = Date.now() + 5000; Date.now() < end && !events.some((e) => e[0] === 'regained');) await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(events, [['lost', 'thief'], ['regained']]);
  });

  it('a history SCAN that found none is not made again: the flag in the kv stops it; the jobs are still counted', async () => {
    const LOG = require('../../lib/logger');
    const saved = {W: LOG.W, E: LOG.E};
    const said = [];
    Object.assign(LOG, {W: (m) => said.push(String(m)), E: () => {}});
    const kv5 = new (require('ioredis'))(redisConnectionFor(5));
    const legacy = new Queue('job-queue', {prefix: '{cdifJob}', connection: redisConnectionFor(11)});
    const job = await legacy.add(`legacy-56f-${process.pid}`, {left: true});
    const history = `jobinfo:legacy-56f-${process.pid}`;
    try {
      await kv5.lpush(history, '{}');
      await kv5.set(LEGACY_NONE, 'set by this test');
      assert.strictEqual(await require('../../lib/job-control').countLegacy(clientsOn(redisUrlFor())), true);
      assert.strictEqual(said.length, 1, JSON.stringify(said));
      assert.match(said[0], /job queue: [1-9]\d* jobs? and \d+ schedulers? under the old shared prefix .* and 0 job histories under/);
    } finally {
      Object.assign(LOG, saved);
      await kv5.del(LEGACY_NONE, history);
      kv5.disconnect();
      await job.remove().catch(() => {});
      await legacy.close();
    }
  });
});

// The reviewer's ruling on #463's round 2: a --stdio runtime is one
// session. Two of them on one data directory and one Redis (two MCP clients,
// each spawning countinghouse --stdio with the same defaults) each have a
// queue of their own, {chj-<id>-<8 hex>}, make no claim, and are never
// refused: each completes its own task.
describe('auth 56: two --stdio runtimes on one data directory and one Redis', function() {
  this.timeout(120000);
  const {startStdio} = require('../helpers/stdio-client');
  const {redisArgs} = require('../helpers/test-env');
  const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'm15-tasks');
  const STDIO_KEY = `k${crypto.randomBytes(12).toString('hex')}`;
  let home = null;
  const runtimes = [];
  before(async () => {
    home = tmp.mkdtemp('ch-auth-56s-');
    const auth = path.join(home, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[STDIO_KEY]: {userName: 'k', devices: ['*']}}));
    for (let i = 0; i < 2; i++) {
      const io = startStdio(['--workerThread', ...redisArgs(), '--modulePath', path.join(home, `modules-${i}`), '--moduleDataPath', path.join(home, 'module_data'),
        '--authConfigPath', auth, '--loadModule', FIXTURE], {env: {COUNTINGHOUSE_API_KEY: STDIO_KEY}});
      runtimes.push(io);
      const init = await io.request({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: `client-${i}`, version: '1'}}});
      assert.ok(init.result != null, JSON.stringify(init) + io.err.slice(-1500));
    }
  });
  after(() => {
    for (const io of runtimes) io.child.kill('SIGKILL');
  });

  it('each completes a task-augmented call, neither is refused, and each queue is its own', async () => {
    for (const [i, io] of runtimes.entries()) {
      const list = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
      const tool = list.result.tools.find((t) => /(^|_)slow$/.test(t.name));
      assert.ok(tool != null, JSON.stringify(list.result.tools.map((t) => t.name)));
      const created = await io.request({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: tool.name, arguments: {ms: 0}, task: {}}});
      assert.ok(created.result != null && created.result.task != null, JSON.stringify(created).slice(0, 600) + io.err.slice(-1500));
      let status = null;
      for (let n = 4; n < 200 && status !== 'completed' && status !== 'failed'; n++) {
        const got = await io.request({jsonrpc: '2.0', id: n, method: 'tasks/get', params: {taskId: created.result.task.taskId}});
        status = got.result != null ? got.result.status : JSON.stringify(got);
        if (status !== 'completed') await new Promise((r) => setTimeout(r, 100));
      }
      assert.strictEqual(status, 'completed', `runtime ${i}: ${io.err.slice(-1500)}`);
    }
    for (const io of runtimes) {
      assert.strictEqual(io.child.exitCode, null, io.err.slice(-1500));
      assert.doesNotMatch(io.err, /another server is using/);
    }
    // two queues, the server id's and each process's suffix
    const id = require('../../lib/server-id').read({moduleDataPath: path.join(home, 'module_data')});
    assert.match(String(id), /^[0-9a-f]{16}$/);
    const kv11 = new (require('ioredis'))(redisConnectionFor(11));
    try {
      const keys = await kv11.keys(`{chj-${id}-*}:job-queue:*`);
      const suffixes = new Set(keys.map((k) => k.slice(`{chj-${id}-`.length, `{chj-${id}-`.length + 8)));
      assert.strictEqual(suffixes.size, 2, JSON.stringify([...suffixes]));
      // each session's finished job is removed by age (3 h), not kept for good
      const jobHashes = (await Promise.all(keys.filter((k) => /:job-queue:\d+$/.test(k)).map(async (k) => ((await kv11.type(k)) === 'hash' ? k : null)))).filter(Boolean);
      assert.strictEqual(jobHashes.length, 2, JSON.stringify(keys));
      for (const k of jobHashes) {
        const opts = JSON.parse(await kv11.hget(k, 'opts'));
        assert.deepStrictEqual([opts.removeOnComplete, opts.removeOnFail], [{age: 10800}, {age: 10800}], k);
      }
      // and that age outlasts a task question's hold, as job-control checks at load
      const asks = require('../../lib/task-asks');
      assert.ok(require('../../lib/job-control').STDIO_JOB_KEPT_S * 1000 > asks.WAIT_MS + asks.KEPT_PAST_WAIT_MS);
      assert.deepStrictEqual(await kv11.keys(`chj-claim:{chj-${id}*`), [], 'no claim made');
      // and no job history: nothing a later process could read
      const kv5 = new (require('ioredis'))(redisConnectionFor(5));
      try { assert.deepStrictEqual(await kv5.keys(`jobinfo:{chj-${id}*`), []); } finally { kv5.disconnect(); }
    } finally {
      kv11.disconnect();
    }
  });

  tmp.hooks();
});

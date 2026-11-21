'use strict';
// B-meter-keys (2): a job names its owner by the opaque id, never by the
// key -- not in its BullMQ data, a scheduler's template or the history -- for
// every key that can make one: one in the auth file, COUNTINGHOUSE_API_KEY
// (which the file's entries did not list, so its jobs stored the key), and a
// sqlite user added while the server runs (in no index until a refill). The
// owner's key is found again from the index before every run, so the run is
// still authorized and billed to its owner; one that can't be found fails
// for good, saying which case it is and never the key.
const assert  = require('assert');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const request = require('supertest');
const redis   = require('redis');
const {execFileSync} = require('child_process');
const {Queue} = require('bullmq');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {testPort, redisConnectionFor, redisUrlFor} = require('../helpers/test-env');
const {prefixFor} = require('../helpers/job-queue');
const {deviceIDForName} = require('../../lib/call-address');
const tmp = require('../helpers/test-tmp').forFile(['ch-owner-']);

const DEVICE  = deviceIDForName('job-snoop');
const SERVICE = 'urn:countinghouse-test:serviceID:jobService';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'job-snoop');
const newKey  = () => `k${crypto.randomBytes(12).toString('hex')}`;
const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));

const addJob = (url, key, name, opts) => request(url).post(`/devices/${DEVICE}/add-job`).set('X-CH-Key', key)
  .send({serviceID: SERVICE, actionName: 'whoami', opts: Object.assign({name}, opts), input: {note: 'n'}});
const balance = (url, key) => request(url).post('/mcp').set('X-CH-Key', key).set('Accept', 'application/json, text/event-stream')
  .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'countinghouse_check_balance', arguments: {}}})
  .then((r) => r.body.result.structuredContent.balance || 0);

// every value under the queue's prefix, as text: hashes, strings, lists,
// sorted sets (with scores) and sets, read by type
async function queueText(prefix) {
  const client = redis.createClient(redisUrlFor(), {db: 11});
  client.on('error', () => {});
  const cmd = (name, ...args) => new Promise((resolve, reject) => client[name](...args, (e, r) => (e ? reject(e) : resolve(r))));
  try {
    const keys = await cmd('keys', `${prefix}*`);
    const out = [];
    for (const k of keys) {
      const type = await cmd('type', k);
      if (type === 'hash') out.push(k, JSON.stringify(await cmd('hgetall', k)));
      else if (type === 'string') out.push(k, String(await cmd('get', k)));
      else if (type === 'list') out.push(k, JSON.stringify(await cmd('lrange', k, 0, -1)));
      else if (type === 'zset') out.push(k, JSON.stringify(await cmd('zrange', k, 0, -1, 'WITHSCORES')));
      else if (type === 'set') out.push(k, JSON.stringify(await cmd('smembers', k)));
      else out.push(k, `<${type}>`);
    }
    return {keys: keys.length, text: out.join('\n')};
  } finally {
    client.quit();
  }
}
// the opaque id lib/identity.js gives an entry with a stable id, from the
// server's own secret file
const stableIdOf = (store, stable) => {
  const secret = Buffer.from(fs.readFileSync(path.join(store, '.identity-secret'), 'utf8').trim(), 'hex');
  return `u_${crypto.createHmac('sha256', secret).update(`id:${stable}`, 'utf8').digest('base64url').slice(0, 22)}`;
};
async function failedReason(queue, id, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const job = await queue.getJob(id);
    if (job != null && job.failedReason != null) return job.failedReason;
    await sleep(200);
  }
  return null;
}

describe('auth 61: a job names its owner by id, never by the key (B-meter-keys (2))', function() {
  this.timeout(180000);

  describe('an auth-file key and COUNTINGHOUSE_API_KEY', () => {
    const PORT = testPort(9830);
    const URL = `http://127.0.0.1:${PORT}`;
    const ALICE = newKey();
    const ENVKEY = newKey();
    const NAME = `owner-id-${process.pid}`;
    let base = null;
    let store = null;
    let server = null;
    let queue = null;
    before(async () => {
      base = tmp.mkdtemp('ch-owner-id-');
      store = path.join(base, 'store');
      const authPath = path.join(base, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({[ALICE]: {userName: 'alice', devices: [DEVICE]}}));
      server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath, '--mcpToolCallCost', '1',
        '--moduleDataPath', store, '--loadModule', FIXTURE], {env: {COUNTINGHOUSE_API_KEY: ENVKEY}});
      queue = new Queue('job-queue', {prefix: prefixFor(store), connection: redisConnectionFor(11)});
    });
    after(async () => {
      if (queue != null) {
        for (const s of await queue.getJobSchedulers(0, -1)) await queue.removeJobScheduler(s.key || s.id).catch(() => {});
        await queue.obliterate({force: true}).catch(() => {});
        await queue.close();
      }
      stopServer(server);
    });

    it('its data, a scheduler\'s template and the queue hold the owner\'s id and never the key', async () => {
      const a = await addJob(URL, ALICE, `${NAME}-a`, {delay: 600000});
      const e = await addJob(URL, ENVKEY, `${NAME}-e`, {delay: 600000});
      // (a yearly cron: an `every` scheduler runs once at once, and would
      // bill the next test's owner)
      const r = await addJob(URL, ENVKEY, `${NAME}-r`, {repeat: {cron: '0 0 1 1 *'}});
      for (const res of [a, e, r]) assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      for (const id of [a.body.id, e.body.id]) {
        const data = (await queue.getJob(id)).data;
        assert.ok(!('apiKey' in data), JSON.stringify(data));
        assert.match(String(data.ownerId), /^u_[A-Za-z0-9_-]{22}$/);
      }
      const {keys, text} = await queueText(prefixFor(store));
      assert.ok(keys > 0, 'the queue holds the jobs');
      assert.ok(!text.includes(ALICE) && !text.includes(ENVKEY), 'a raw key in the queue');
    });

    it('a job of the environment key runs, authorized and billed to its owner', async () => {
      const before = await balance(URL, ENVKEY);
      const added = await addJob(URL, ENVKEY, `${NAME}-run`, {delay: 500});
      assert.strictEqual(added.status, 200, JSON.stringify(added.body));
      const deadline = Date.now() + 30000;
      let state = null;
      while (Date.now() < deadline && state !== 'completed' && state !== 'failed') {
        state = await (await queue.getJob(added.body.id)).getState();
        await sleep(200);
      }
      const job = await queue.getJob(added.body.id);
      assert.strictEqual(state, 'completed', String(job.failedReason));
      // (billing is fire-and-forget: read once it has settled)
      let after = null;
      for (let i = 0, last = null; i < 30; i++, last = after) { after = await balance(URL, ENVKEY); if (after === last && after !== before) break; await sleep(200); }
      assert.strictEqual(after, before - 1, `billed to its owner: before ${before}, after ${after}`);
    });
  });

  describe('a sqlite user added while the server runs', () => {
    const PORT = testPort(9831);
    const URL = `http://127.0.0.1:${PORT}`;
    const ADMIN = newKey();
    const BOB = newKey();
    let base = null;
    let store = null;
    let db = null;
    let server = null;
    let queue = null;
    const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'bin', 'countinghouse-auth-sqlite.js'), '--dbPath', db].concat(args), {encoding: 'utf8'});
    before(async () => {
      base = tmp.mkdtemp('ch-owner-sqlite-');
      store = path.join(base, 'store');
      db = path.join(base, 'auth.sqlite3');
      cli('add-user', ADMIN, 'admin');
      cli('set-admin', ADMIN, 'true');
      server = await startServer(PORT, ['--workerThread', '--authProvider', 'sqlite', '--authConfigPath', db,
        '--moduleDataPath', store, '--loadModule', FIXTURE]);
      queue = new Queue('job-queue', {prefix: prefixFor(store), connection: redisConnectionFor(11)});
    });
    after(async () => {
      if (queue != null) { await queue.obliterate({force: true}).catch(() => {}); await queue.close(); }
      stopServer(server);
    });

    it('is named by its stable id from its first job, never its key', async () => {
      cli('add-user', BOB, 'bob');
      cli('grant', BOB, DEVICE);
      cli('set-id', BOB, 'bob-stable');
      const added = await addJob(URL, BOB, `owner-sqlite-${process.pid}`, {delay: 600000});
      assert.strictEqual(added.status, 200, JSON.stringify(added.body));
      const data = (await queue.getJob(added.body.id)).data;
      assert.ok(!('apiKey' in data), JSON.stringify(data));
      assert.strictEqual(data.ownerId, stableIdOf(store, 'bob-stable'), 'the stable id, so a later refill finds it');
      assert.ok(!(await queueText(prefixFor(store))).text.includes(BOB), 'a raw key in the queue');
    });
  });

  describe('--debug, its owner known only to the process that queued it', () => {
    const PORT = testPort(9832);
    const URL = `http://127.0.0.1:${PORT}`;
    const ANYKEY = newKey();
    let base = null;
    let store = null;
    let server = null;
    let queue = null;
    const start = () => startServer(PORT, ['--debug', '--workerThread', '--moduleDataPath', store, '--loadModule', FIXTURE]);
    before(async () => {
      base = tmp.mkdtemp('ch-owner-debug-');
      store = path.join(base, 'store');
      server = await start();
      queue = new Queue('job-queue', {prefix: prefixFor(store), connection: redisConnectionFor(11)});
    });
    after(async () => {
      if (queue != null) { await queue.obliterate({force: true}).catch(() => {}); await queue.close(); }
      stopServer(server);
    });

    it('after a restart its job fails for good, saying why, never the key', async () => {
      const added = await addJob(URL, ANYKEY, `owner-debug-${process.pid}`, {delay: 4000, attempts: 3});
      assert.strictEqual(added.status, 200, JSON.stringify(added.body));
      assert.ok(!('apiKey' in (await queue.getJob(added.body.id)).data));
      stopServer(server);
      await sleep(500);
      server = await start();
      const reason = await failedReason(queue, added.body.id);
      assert.ok(reason != null, 'the job did not fail');
      assert.match(reason, /^SYSTEM_ERROR_UNKNOWN_USER: .*--debug/);
      assert.ok(!reason.includes(ANYKEY), `the key is in the failure: ${reason}`);
      await sleep(1500);
      assert.strictEqual((await queue.getJob(added.body.id)).attemptsMade, 1, 'retried');
    });
  });
  // (its trees removed, failed or not: test/helpers/test-tmp.js)
  tmp.hooks();
});

// M5: node_redis 3 queues commands while disconnected (enable_offline_queue)
// and, after an hour of failed reconnects (connect_timeout), ends the client
// for good. With Redis down, the per-key rate-limit check's callback never
// fired, so a tools/call under --apiKeyRateLimit hung instead of failing
// open; the outage call's charge landed when Redis came back; and after a
// long outage metering never came back. The metering and rate-limit clients
// now fail a command at once while disconnected (after their first connect),
// retry forever with a capped delay, and the rate-limit check has a deadline.
//
// The server reaches Redis through a TCP proxy this test owns: closing the
// proxy (and every connection through it) is Redis "down" for the server
// only; listening again is Redis "back". No redis-server binary needed, so it
// runs where Redis is a service (CI) as well as locally.
const assert = require('assert');
const fs     = require('fs');
const net    = require('net');
const path   = require('path');
const redis  = require('redis');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');
const {redisUrlFor} = require('../helpers/test-env');

const PORT       = 9652;
const PROXY_PORT = 6391;
// The Redis the test's proxy forwards to: the servers' own (CH_TEST_REDIS_URL
// under run-local), else the shared default as before.
const REAL_REDIS = (() => { const u = new URL(redisUrlFor()); return {host: u.hostname, port: Number(u.port) || 6379}; })();
const CALLER     = `m5-caller-${process.pid}`;
const TOOL       = 'echo_device_echoservice_echo';
const ANSWER_MS  = 2000;

// A proxy to the real Redis that can be taken down and brought back.
function redisProxy() {
  const sockets = new Set();
  let server = null;
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); };
  return {
    up: () => new Promise((resolve, reject) => {
      server = net.createServer((client) => {
        const upstream = net.connect(REAL_REDIS);
        track(client); track(upstream);
        client.pipe(upstream); upstream.pipe(client);
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      });
      server.once('error', reject);
      server.listen(PROXY_PORT, '127.0.0.1', resolve);
    }),
    down: () => new Promise((resolve) => {
      sockets.forEach((s) => s.destroy());
      server.close(() => resolve());
    })
  };
}

// The test's own commands go to the real Redis, never through the proxy.
let direct = null;
function redisCmd(name, ...args) {
  return new Promise((resolve, reject) => direct[name](...args, (err, r) => (err ? reject(err) : resolve(r))));
}

// The outer charge is fire-and-forget: read the balance once it stops changing.
async function settledBalance() {
  let last = null;
  let stable = 0;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const b = await redisCmd('hget', CALLER, 'balance');
    stable = (b === last) ? stable + 1 : 1;
    last = b;
    if (stable >= 3) return b;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`balance did not settle (last ${last})`);
}

// One tools/call, with how long it took to answer (or null if it did not
// answer within the cap).
function timedCall(capMs) {
  const t0 = Date.now();
  return Promise.race([
    mcpCall(PORT, CALLER, TOOL, {foo: [], bar: 'x'}).then((r) => ({ms: Date.now() - t0, r: r}), (e) => ({ms: Date.now() - t0, e: e})),
    new Promise((resolve) => setTimeout(() => resolve(null), capMs))
  ]);
}

describe('auth 42: with Redis down a call still answers, and billing resumes when it is back (M5)', function() {
  this.timeout(120000);
  const proxy = redisProxy();
  let proxyUp = false;
  let server = null;
  let dir = null;

  before(async () => {
    direct = redis.createClient(redisUrlFor(), {db: 0});
    dir = mkdtemp('m5-');
    const authPath = path.join(dir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({[CALLER]: {userName: 'm5', devices: ['*']}}));
    await proxy.up();
    proxyUp = true;
    server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath,
      '--redisUrl', `redis://127.0.0.1:${PROXY_PORT}`, '--apiKeyRateLimit', '100', '--mcpToolCallCost', '1',
      '--loadModule', path.join(ROOT, 'pre-installed-packages', 'echo-device-module')]);
  });
  after(async () => {
    stopServer(server);
    if (proxyUp) await proxy.down();
    if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
    if (direct != null) { await redisCmd('del', CALLER).catch(() => {}); direct.quit(); }
  });

  it('bills a call while Redis is up', async () => {
    await redisCmd('hset', CALLER, 'balance', '100');
    const c = await timedCall(10000);
    assert.ok(c != null && c.r != null && c.r.isError !== true, JSON.stringify(c));
    assert.strictEqual(await settledBalance(), '99');
  });

  it(`answers a tools/call within ${ANSWER_MS} ms once Redis is down, and does not charge it later`, async () => {
    await proxy.down();
    proxyUp = false;
    await new Promise((r) => setTimeout(r, 300));   // the server's clients see the connection drop
    const c = await timedCall(ANSWER_MS);
    assert.notStrictEqual(c, null, `no answer within ${ANSWER_MS} ms with Redis down\n${server.output.slice(-1500)}`);
  });

  it('bills again once Redis is back, once per call (the outage call was not queued)', async () => {
    await proxy.up();
    proxyUp = true;
    await new Promise((r) => setTimeout(r, 3000));   // longer than the capped reconnect delay
    assert.strictEqual(await settledBalance(), '99', 'nothing charged on reconnect');
    const c = await timedCall(10000);
    assert.ok(c != null && c.r != null && c.r.isError !== true, JSON.stringify(c));
    assert.strictEqual(await settledBalance(), '98');
  });
});

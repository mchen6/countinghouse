// M5, the client factory on its own (no server): against a port nothing
// listens on, a plain node_redis 3 client gives up once its reconnect
// attempts add up to connect_timeout, and queues commands meanwhile; the
// resilient client keeps reconnecting and fails a command at once. And a
// rate-limit check whose Redis never answers gets its error at the deadline.
const assert = require('assert');
const net    = require('net');
const redis  = require('redis');
const redisResilient = require('../../lib/redis-resilient');
const {redisUrlFor} = require('../helpers/test-env');

// A port that refuses connections: bound once, then closed.
function deadPort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

describe('auth 43: the resilient Redis client and rate limiter (M5)', function() {
  this.timeout(30000);

  it('keeps reconnecting past connect_timeout, where a plain client ends for good', async () => {
    const port = await deadPort();
    const url = `redis://127.0.0.1:${port}`;
    const plain = redis.createClient(url, {connect_timeout: 1500});
    const resilient = redisResilient.createClient(url, {connect_timeout: 1500});
    let plainEnded = false;
    let resilientAttempts = 0;
    plain.on('error', () => {});
    resilient.on('error', () => {});
    plain.on('end', () => { plainEnded = true; });
    resilient.on('reconnecting', () => { resilientAttempts++; });
    await new Promise((r) => setTimeout(r, 4500));
    const attemptsAt = resilientAttempts;
    await new Promise((r) => setTimeout(r, 1500));
    try {
      assert.strictEqual(plainEnded, true, 'premise: the plain client ends once connect_timeout is used up');
      assert.ok(resilientAttempts > attemptsAt, `still reconnecting after connect_timeout (${attemptsAt} -> ${resilientAttempts})`);
      assert.strictEqual(resilient.closing, false);
    } finally {
      plain.end(false);
      resilient.end(false);
    }
  });

  // The first connect is the one wait allowed: code that issues a command
  // right after creating a client (auth/18, every provider at start) works.
  it('a command issued right after creation succeeds when Redis is up', async () => {
    const c = redisResilient.createClient(redisUrlFor(), {db: 0});
    try {
      const reply = await new Promise((resolve, reject) => c.ping((e, r) => (e ? reject(e) : resolve(r))));
      assert.strictEqual(reply, 'PONG');
      assert.strictEqual(c.enable_offline_queue, false, 'the queue is off once the client is ready');
    } finally { c.quit(); }
  });

  it('with Redis down at creation, a queued command fails at the first-connect bound', async () => {
    const port = await deadPort();
    const c = redisResilient.createClient(`redis://127.0.0.1:${port}`, {}, 300); // run-local: not the shared Redis
    c.on('error', () => {});
    try {
      const t0 = Date.now();
      const err = await new Promise((resolve) => c.hget('k', 'balance', (e) => resolve(e)));
      const ms = Date.now() - t0;
      assert.ok(err != null && err.code === 'NR_CLOSED', String(err));
      assert.ok(ms >= 250 && ms < 1000, `failed after ${ms} ms`);
    } finally { c.end(false); }
  });

  it('after the first connect (or its bound), a command while disconnected fails at once', async () => {
    const port = await deadPort();
    const c = redisResilient.createClient(`redis://127.0.0.1:${port}`, {}, 300); // run-local: not the shared Redis
    c.on('error', () => {});
    try {
      await new Promise((r) => setTimeout(r, 400));
      const t0 = Date.now();
      const err = await new Promise((resolve) => c.hget('k', 'balance', (e) => resolve(e)));
      assert.ok(err != null, 'an error, not a queued command');
      assert.ok(Date.now() - t0 < 200, `answered in ${Date.now() - t0} ms`);
    } finally { c.end(false); }
  });

  it('a rate-limit check Redis never answers gets RATE_LIMIT_TIMEOUT at the deadline, once', async () => {
    const hung = {options: {}, multi: () => ({zremrangebyscore() { return this; }, zrange() { return this; }, zadd() { return this; },
      expire() { return this; }, exec() { /* never calls back */ }})};
    const limit = redisResilient.rateLimiter({redis: hung, interval: 1000, maxInInterval: 1}, 300);
    const t0 = Date.now();
    const calls = [];
    await new Promise((resolve) => {
      limit('id', (err) => { calls.push(err); resolve(); });
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].code, 'RATE_LIMIT_TIMEOUT');
    assert.ok(Date.now() - t0 >= 300 && Date.now() - t0 < 1000);
  });
});

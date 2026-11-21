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

  // A check Redis never answers is answered at the deadline, once, and
  // decided by the same limit in memory: never an error the caller would
  // take as "allowed" (the Reviewer on #443: a timeout must not become
  // unlimited calls for a key)
  it('a rate-limit check Redis never answers is answered at the deadline, once, by the same limit in memory', async () => {
    const hung = {options: {}, multi: () => ({zremrangebyscore() { return this; }, zrange() { return this; }, zadd() { return this; },
      expire() { return this; }, exec() { /* never calls back */ }})};
    const limit = redisResilient.rateLimiter({redis: hung, interval: 1000, maxInInterval: 1}, 300);
    const t0 = Date.now();
    const calls = [];
    await new Promise((resolve) => {
      limit('id', (err, timeLeft) => { calls.push({err, timeLeft}); resolve(); });
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].err, null);
    assert.strictEqual(calls[0].timeLeft, 0, 'the first in the second: allowed');
    assert.ok(Date.now() - t0 >= 300 && Date.now() - t0 < 1000);
    // the second in the same second: limited, though Redis still says nothing
    const second = await new Promise((resolve) => limit('id', (err, timeLeft) => resolve({err, timeLeft})));
    assert.strictEqual(second.err, null);
    assert.ok(second.timeLeft > 0, JSON.stringify(second));
  });

  // The reviewer's countinghouse high (#443): the in-memory window counted
  // only the checks Redis didn't answer, so a key at its limit got a fresh
  // allowance when Redis dropped, and a flapping Redis gave up to twice it.
  // Every check is counted in memory too, and a check passes only when every
  // count it has allows it.
  const zsetRedis = () => {
    const sets = new Map();
    let hang = false;
    return {
      options: {},
      hang: (h) => { hang = h; },
      multi() {
        const ops = [];
        const b = {
          zremrangebyscore(key, lo, hi) { ops.push(() => { const z = (sets.get(key) || []).filter(([, sc]) => !(sc >= lo && sc <= hi)); sets.set(key, z); return 0; }); return b; },
          zrange(key) { ops.push(() => (sets.get(key) || []).flatMap(([m, sc]) => [m, String(sc)])); return b; },
          zadd(key, score, member) { ops.push(() => { sets.set(key, (sets.get(key) || []).concat([[member, score]])); return 1; }); return b; },
          expire() { ops.push(() => 1); return b; },
          exec(cb) { if (hang) return; const out = ops.map((f) => f()); setImmediate(() => cb(null, out)); }
        };
        return b;
      }
    };
  };
  const check = (limit, id) => new Promise((resolve) => limit(id, (err, timeLeft) => resolve({err, timeLeft})));

  it('a key at its limit through Redis is still limited when Redis stops answering', async () => {
    const redis = zsetRedis();
    const limit = redisResilient.rateLimiter({redis, interval: 60000, maxInInterval: 5}, 100);
    for (let i = 0; i < 5; i++) assert.strictEqual((await check(limit, 'k')).timeLeft, 0, `call ${i + 1} allowed`);
    redis.hang(true);
    const sixth = await check(limit, 'k');
    assert.strictEqual(sixth.err, null);
    assert.ok(sixth.timeLeft > 0, `the sixth in the window limited, with Redis silent: ${JSON.stringify(sixth)}`);
  });

  it('a flapping Redis never lets more than the limit through in one window', async () => {
    const redis = zsetRedis();
    const limit = redisResilient.rateLimiter({redis, interval: 60000, maxInInterval: 5}, 50);
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      redis.hang(i % 2 === 1);
      if ((await check(limit, 'k')).timeLeft === 0) allowed += 1;
    }
    assert.ok(allowed <= 5, `${allowed} allowed`);
  });

  // the limiter PR's medium, on the combined answer
  it('limited by this process\'s count, it says no actions left, whatever Redis\'s count says', async () => {
    const redis = zsetRedis();
    const limit = redisResilient.rateLimiter({redis, interval: 60000, maxInInterval: 2}, 50);
    redis.hang(true);
    await check(limit, 'k');
    await check(limit, 'k');
    redis.hang(false);
    const third = await new Promise((resolve) => limit('k', (err, timeLeft, actionsLeft) => resolve({err, timeLeft, actionsLeft})));
    assert.ok(third.timeLeft > 0, JSON.stringify(third));
    // (rolling-rate-limiter's own convention: at or below 0 once limited --
    // it counts the refused calls too; never "calls left" while limited)
    assert.ok(third.actionsLeft <= 0, `limited, with no calls left: ${JSON.stringify(third)}`);
  });

  it('decided in memory (Redis silent), a throw in the callback stays an exception, never an unhandled rejection', async () => {
    const redis = zsetRedis();
    redis.hang(true);
    const limit = redisResilient.rateLimiter({redis, interval: 60000, maxInInterval: 5}, 30);
    const rejections = [];
    const uncaught = [];
    const onRejection = (r) => rejections.push(r);
    const saved = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    process.on('uncaughtException', (e) => uncaught.push(e));
    process.on('unhandledRejection', onRejection);
    try {
      limit('k', () => { throw new Error('the caller threw'); });
      for (let i = 0; i < 40 && uncaught.length + rejections.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.removeAllListeners('uncaughtException');
      for (const l of saved) process.on('uncaughtException', l);
      process.removeListener('unhandledRejection', onRejection);
    }
    assert.deepStrictEqual([uncaught.map((e) => e.message), rejections.length], [['the caller threw'], 0]);
  });
});

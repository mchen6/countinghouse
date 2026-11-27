'use strict';

// LM1 B3, Task 6: LocalKv against a live Redis (db 13), the same script,
// reply for reply and error text for error text. Skipped without Redis
// (CI has one). This stands in for the spec's "fixtures recorded from
// Redis": recording would be a local capture, which the process forbids.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LocalKv = require('../../lib/local-kv');
const SCRIPT = require('./script');
const {redisUrlFor} = require('../helpers/test-env');

function run(client, cmd, ...args) {
  return new Promise((resolve) => {
    try {
      client[cmd](...args, (err, reply) => resolve(err != null ? {error: err.message} : reply));
    } catch (e) {
      resolve({thrown: e.message});
    }
  });
}

describe('local-kv 02: LocalKv answers as Redis does (differential)', function() {
  this.timeout(30000);
  let redisClient = null;

  before(async function() {
    const redis = require('redis');
    redisClient = redis.createClient(redisUrlFor(), {db: 13});
    redisClient.on('error', () => {});
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 1000);
      redisClient.ping((err) => { clearTimeout(timer); resolve(err == null); });
    });
    if (!ok) { redisClient.quit(); redisClient = null; return this.skip(); }
    await new Promise((resolve) => redisClient.flushdb(resolve));
  });
  after(() => { if (redisClient != null) redisClient.quit(); });

  it('gives every step of the script the same answer', async () => {
    const kv = new LocalKv({storePath: fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-kv-02-'))});
    const diffs = [];
    for (const [cmd, ...args] of SCRIPT) {
      const expected = await run(redisClient, cmd, ...args);
      const actual = await run(kv, cmd, ...args);
      try { assert.deepStrictEqual(actual, expected); } catch (e) { diffs.push({step: [cmd, ...args], redis: expected, local: actual}); }
    }
    kv.close();
    assert.deepStrictEqual(diffs, []);
  });
});

// R-localkv-inf-scores: a sorted-set score of inf or -inf, written to
// kv.json and read back (the store's own write, then another LocalKv on the
// file, as a restart reads it): JSON has no Infinity, so it came back null,
// sorted as 0, said "null" by WITHSCORES and compared as 0 by GT, LT and INCR.
// Redis keeps it. Every reply after the read-back as Redis's.
describe('local-kv 02: inf and -inf scores read back from kv.json as Redis keeps them', function() {
  this.timeout(30000);
  let redisClient = null;
  before(async function() {
    const redis = require('redis');
    redisClient = redis.createClient(redisUrlFor(), {db: 13});
    redisClient.on('error', () => {});
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 1000);
      redisClient.ping((err) => { clearTimeout(timer); resolve(err == null); });
    });
    if (!ok) { redisClient.quit(); redisClient = null; return this.skip(); }
    await new Promise((resolve) => redisClient.flushdb(resolve));
  });
  after(() => { if (redisClient != null) redisClient.quit(); });

  it('zrange WITHSCORES, GT, LT and INCR after the read-back answer as Redis does', async () => {
    const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-kv-02-inf-'));
    const before = [['zadd', 'zi', 'inf', 'top', '-inf', 'bottom', 1, 'mid'], ['zadd', 'zj', '+inf', 'x']];
    const after = [['zrange', 'zi', 0, -1, 'WITHSCORES'], ['zrange', 'zi', 0, 0], ['zadd', 'zi', 'GT', 5, 'top'], ['zadd', 'zi', 'LT', 5, 'bottom'],
      ['zadd', 'zi', 'INCR', 1, 'top'], ['zadd', 'zi', 'INCR', 1, 'bottom'], ['zrange', 'zi', 0, -1, 'WITHSCORES'], ['zrange', 'zj', 0, -1, 'WITHSCORES']];
    const first = new LocalKv({storePath});
    for (const [cmd, ...args] of before) {
      assert.deepStrictEqual(await run(first, cmd, ...args), await run(redisClient, cmd, ...args), cmd);
    }
    first.close();
    const kv = new LocalKv({storePath});
    const diffs = [];
    try {
      for (const [cmd, ...args] of after) {
        const expected = await run(redisClient, cmd, ...args);
        const actual = await run(kv, cmd, ...args);
        try { assert.deepStrictEqual(actual, expected); } catch (e) { diffs.push({step: [cmd, ...args], redis: expected, local: actual}); }
      }
    } finally {
      kv.close();
      fs.rmSync(storePath, {recursive: true, force: true});
    }
    assert.deepStrictEqual(diffs, []);
  });
});

describe('local-kv 02: multi/exec as node_redis and Redis answer it', function() {
  this.timeout(30000);
  let redisClient = null;
  before(async function() {
    const redis = require('redis');
    redisClient = redis.createClient(redisUrlFor(), {db: 13});
    redisClient.on('error', () => {});
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 1000);
      redisClient.ping((err) => { clearTimeout(timer); resolve(err == null); });
    });
    if (!ok) { redisClient.quit(); redisClient = null; return this.skip(); }
    await new Promise((resolve) => redisClient.flushdb(resolve));
  });
  after(() => { if (redisClient != null) redisClient.quit(); });

  const shape = (e, r) => (e != null ? {error: e.message} : r.map((x) => (x instanceof Error ? {error: x.message} : x)));
  for (const [label, build] of [
    ['an arity error aborts', (m) => m.set('m1', '1').get()],
    ['a runtime error stays in its place', (m) => m.lpush('w', 'x').get('w')],
    ['an array of commands', null]
  ]) {
    it(label, async () => {
      const kv = new LocalKv({storePath: fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-kv-02m-'))});
      const go = (client) => new Promise((resolve) => {
        const m = (build != null) ? build(client.multi()) : client.multi([['set', 'ma', '1'], ['get', 'ma']]);
        m.exec((e, r) => resolve(shape(e, r)));
      });
      assert.deepStrictEqual(await go(kv), await go(redisClient));
      kv.close();
    });
  }
});

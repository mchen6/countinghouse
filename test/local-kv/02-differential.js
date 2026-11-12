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
    redisClient = redis.createClient('redis://127.0.0.1:6379', {db: 13});
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

'use strict';

// LM1 B2: seeding a balance in the local store (the reviewer's ruling,
// 2026-11-11): bin/countinghouse-meter.js set --storePath <dir> --balance
// <n> reads the key from COUNTINGHOUSE_SEED_KEY only, never from an
// argument or a prompt, writes its fingerprint's record, and prints the
// fingerprint, never the key.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {LocalMeteringProvider} = require('../../lib/metering');
const {meterId} = require('../../lib/key-fingerprint');

const BIN = path.resolve(__dirname, '../../bin/countinghouse-meter.js');
const KEY = 'seeded-operator-key-0001';

function meter(args, env) {
  const base = Object.assign({}, process.env);
  delete base.COUNTINGHOUSE_SEED_KEY;
  return spawnSync(process.execPath, [BIN].concat(args), {encoding: 'utf8', timeout: 20000, env: Object.assign(base, env)});
}

describe('metering 03: seeding a balance (bin/countinghouse-meter.js)', function() {
  this.timeout(30000);

  it('sets the balance of the key in COUNTINGHOUSE_SEED_KEY and prints only its fingerprint', async () => {
    const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-metering-03-'));
    const run = meter(['set', '--storePath', storePath, '--balance', '50'], {COUNTINGHOUSE_SEED_KEY: KEY});
    assert.strictEqual(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(meterId(KEY)), run.stdout);
    assert.ok(!run.stdout.includes(KEY) && !run.stderr.includes(KEY), run.stdout + run.stderr);
    const p = new LocalMeteringProvider({storePath, meter: true});
    const balance = await new Promise((resolve) => p.checkBalance(KEY, (err, r) => resolve(r.balance)));
    p.close();
    assert.strictEqual(balance, 50);
    for (const f of fs.readdirSync(storePath)) assert.ok(!fs.readFileSync(path.join(storePath, f), 'utf8').includes(KEY), f);
  });

  it('refuses without COUNTINGHOUSE_SEED_KEY, and never takes the key as an argument', () => {
    const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-metering-03-'));
    const none = meter(['set', '--storePath', storePath, '--balance', '5'], {});
    assert.strictEqual(none.status, 2);
    assert.ok(/COUNTINGHOUSE_SEED_KEY/.test(none.stderr), none.stderr);
    const asArg = meter(['set', '--storePath', storePath, '--balance', '5', '--key', KEY], {COUNTINGHOUSE_SEED_KEY: KEY});
    assert.strictEqual(asArg.status, 2);
    assert.ok(!asArg.stderr.includes(KEY), asArg.stderr);
  });

  // B-meter-keys (1): the Redis store's ledger, seeded the same way --
  // under the key's fingerprint, on db 0 where the runtime reads it
  it('--store redis: sets the balance under the key\'s fingerprint on the runtime\'s ledger db; no Redis key holds the key', async function() {
    const {redisUrlFor} = require('../helpers/test-env');
    const redis = require('redis');
    const client = redis.createClient(redisUrlFor(), {db: 0});
    client.on('error', () => {});
    const ok = await new Promise((resolve) => client.ping((err) => resolve(err == null)));
    if (!ok) { client.quit(); return this.skip(); }
    const id = meterId(KEY);
    try {
      await new Promise((resolve) => client.hmset(id, 'toolPriceRecord', JSON.stringify({t: {count: 3}}), resolve));
      // (no --store and no --storePath: the runtime's own default store, Redis)
      const run = meter(['set', '--redisUrl', redisUrlFor(), '--balance', '70'], {COUNTINGHOUSE_SEED_KEY: KEY});
      assert.strictEqual(run.status, 0, run.stderr);
      assert.ok(run.stdout.includes(id), run.stdout);
      assert.ok(!run.stdout.includes(KEY) && !run.stderr.includes(KEY), run.stdout + run.stderr);
      const got = await new Promise((resolve) => client.hmget(id, 'balance', 'toolPriceRecord', (err, r) => resolve(r)));
      assert.deepStrictEqual([Number(got[0]), JSON.parse(got[1])], [70, {t: {count: 3}}], 'the balance set, the free calls kept');
      const keys = await new Promise((resolve) => client.keys('*', (err, k) => resolve(k || [])));
      assert.ok(keys.every((k) => !k.includes(KEY)), JSON.stringify(keys));
      // (the runtime's provider reads it there)
      const RedisMeteringProvider = require('../../lib/metering/redis-provider');
      const p = new RedisMeteringProvider({redisClient: client});
      assert.strictEqual(await new Promise((resolve) => p.checkBalance(KEY, (err, r) => resolve(r && r.balance))), 70);
      // (an unknown store, or --storePath with redis, is refused)
      assert.strictEqual(meter(['set', '--store', 'mongo', '--balance', '1'], {COUNTINGHOUSE_SEED_KEY: KEY}).status, 2);
      assert.strictEqual(meter(['set', '--store', 'redis', '--storePath', '/x', '--balance', '1'], {COUNTINGHOUSE_SEED_KEY: KEY}).status, 2);
      // (an empty --redisUrl -- an unset variable -- never funds a local Redis instead)
      const empty = meter(['set', '--redisUrl', '', '--balance', '1'], {COUNTINGHOUSE_SEED_KEY: KEY});
      assert.strictEqual(empty.status, 2, empty.stdout);
      assert.match(empty.stderr, /--redisUrl, when given, names one Redis/);
      assert.strictEqual(meter(['set', '--store', '', '--balance', '1'], {COUNTINGHOUSE_SEED_KEY: KEY}).status, 2);
    } finally {
      await new Promise((resolve) => client.del(id, () => client.quit(() => resolve())));
    }
  });

  // the reviewer, on B-meter-keys (1): a test's own Redis named and no
  // --redisUrl -- the default would be this machine's own Redis
  it('refuses the default Redis while CH_TEST_REDIS_URL names a test\'s own, before connecting', () => {
    const run = meter(['set', '--balance', '5'], {COUNTINGHOUSE_SEED_KEY: KEY, CH_TEST_REDIS_URL: 'redis://127.0.0.1:1'});
    assert.strictEqual(run.status, 2, run.stdout);
    assert.match(run.stderr, /--redisUrl is required while CH_TEST_REDIS_URL names a test Redis/);
    assert.ok(!/could not be reached/.test(run.stderr), 'refused before any connection');
  });

  it('refuses a balance that is not a finite number, and a missing --storePath', () => {
    const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-metering-03-'));
    assert.strictEqual(meter(['set', '--storePath', storePath, '--balance', 'lots'], {COUNTINGHOUSE_SEED_KEY: KEY}).status, 2);
    // (--store local without --storePath; with neither, the store is Redis,
    // the runtime's default, which this test never touches)
    assert.strictEqual(meter(['set', '--store', 'local', '--balance', '5'], {COUNTINGHOUSE_SEED_KEY: KEY}).status, 2);
  });
});

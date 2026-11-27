'use strict';

// LM1 B2: seeding a balance in the local store (the reviewer's ruling,
// 2026-11-11): bin/countinghouse-meter.js set --storePath <dir> --balance
// <n> reads the key from COUNTINGHOUSE_SEED_KEY only, never from an
// argument or a prompt, writes its fingerprint's record, and prints the
// fingerprint, never the key.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const {LocalMeteringProvider} = require('../../lib/metering');
const {meterId} = require('../../lib/key-fingerprint');

const BIN = path.resolve(__dirname, '../../bin/countinghouse-meter.js');
const KEY = 'seeded-operator-key-0001';

function meter(args, env) {
  const base = Object.assign({}, process.env);
  delete base.COUNTINGHOUSE_SEED_KEY;
  return spawnSync(process.execPath, [BIN].concat(args), {encoding: 'utf8', timeout: 30000, env: Object.assign(base, env)});
}

describe('metering 03: seeding a balance (bin/countinghouse-meter.js)', function() {
  // (each test's store from test-tmp, removed when the describe ends, failed or not: #531's high, L7)
  const trees = require('../helpers/test-tmp').forFile(['ch-metering-03-']);
  // (the busy-lock case waits out the store's 10 s update wait)
  this.timeout(45000);

  it('sets the balance of the key in COUNTINGHOUSE_SEED_KEY and prints only its fingerprint', async () => {
    const storePath = trees.mkdtemp('ch-metering-03-');
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

  // (the final pass's gateway part, A8) a write that fails is said, exit 2:
  // the store's lock held by a live process past the wait. It printed its
  // success line and exited 0 with nothing written (flush logged and
  // rescheduled, and close cleared the retry).
  it('a balance that could not be written is said, with exit 2, and no success line', () => {
    // (removed on every path by trees.hooks())
    const storePath = trees.mkdtemp('ch-metering-03-');
    // a live holder (this test's process): busy for the whole wait, never stale
    fs.writeFileSync(path.join(storePath, '.lock'), JSON.stringify({pid: process.pid, startMs: 1, at: Date.now()}));
    const run = meter(['set', '--storePath', storePath, '--balance', '50'], {COUNTINGHOUSE_SEED_KEY: KEY});
    assert.strictEqual(run.status, 2, `${run.status} ${run.stdout} ${run.stderr}`);
    assert.ok(/the balance could not be written/.test(run.stderr), run.stderr);
    assert.ok(!/set balance/.test(run.stdout), run.stdout);
    assert.ok(!run.stderr.includes(KEY), run.stderr);
    assert.ok(!fs.existsSync(path.join(storePath, 'metering.json')), 'nothing written');
  });

  // (R-store-aside-locked) a corrupt ledger is never replaced by a process that
  // never saw it whole, and the CLI is one: it says what is wrong and what to
  // do, naming no path
  it('a corrupt ledger: said as corrupt, with what to do, exit 2, the file left as it was', () => {
    const storePath = trees.mkdtemp('ch-metering-03-');
    const file = path.join(storePath, 'metering.json');
    fs.writeFileSync(file, '{"broken": ');
    const run = meter(['set', '--storePath', storePath, '--balance', '50'], {COUNTINGHOUSE_SEED_KEY: KEY});
    assert.strictEqual(run.status, 2, `${run.status} ${run.stdout} ${run.stderr}`);
    assert.ok(/corrupt/.test(run.stderr) && /move it away/.test(run.stderr), run.stderr);
    assert.ok(!run.stderr.includes(storePath) && !run.stderr.includes(KEY), run.stderr);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"broken": ');
  });

  it('refuses without COUNTINGHOUSE_SEED_KEY, and never takes the key as an argument', () => {
    const storePath = trees.mkdtemp('ch-metering-03-');
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
    const {redisUrlFor, redisAnswers} = require('../helpers/test-env');
    // (a run with no Redis -- CI's local-store job runs this file with none
    // -- skips; a PING on a client with nothing to connect to would wait
    // forever. A Redis the run configured, CH_TEST_REDIS_URL, must answer.)
    const configured = process.env.CH_TEST_REDIS_URL != null && process.env.CH_TEST_REDIS_URL !== '';
    let up = false;
    try { up = await redisAnswers(); } catch (e) { if (configured) throw e; up = false; }
    if (!up) return this.skip();
    const redis = require('redis');
    const client = redis.createClient(redisUrlFor(), {db: 0});
    client.on('error', () => {});
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
    const storePath = trees.mkdtemp('ch-metering-03-');
    assert.strictEqual(meter(['set', '--storePath', storePath, '--balance', 'lots'], {COUNTINGHOUSE_SEED_KEY: KEY}).status, 2);
    // (--store local without --storePath; with neither, the store is Redis,
    // the runtime's default, which this test never touches)
    assert.strictEqual(meter(['set', '--store', 'local', '--balance', '5'], {COUNTINGHOUSE_SEED_KEY: KEY}).status, 2);
  });
  trees.hooks();
});

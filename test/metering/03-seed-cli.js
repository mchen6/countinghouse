'use strict';

// LM1 B2: seeding a balance in the local store (the reviewer's ruling,
// 2026-11-11): bin/countinghouse-meter.js set --storePath <dir> --balance
// <n> reads the key from COUNTINGHOUSE_SEED_KEY only, never from an
// argument or a prompt, writes its fingerprint's record, and prints the
// fingerprint, never the key.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const {spawn, spawnSync} = require('child_process');
const {LocalMeteringProvider} = require('../../lib/metering');
const {meterId} = require('../../lib/key-fingerprint');

const BIN = path.resolve(__dirname, '../../bin/countinghouse-meter.js');
const KEY = 'seeded-operator-key-0001';

function meter(args, env) {
  const base = Object.assign({}, process.env);
  delete base.COUNTINGHOUSE_SEED_KEY;
  return spawnSync(process.execPath, [BIN].concat(args), {encoding: 'utf8', timeout: 30000, env: Object.assign(base, env)});
}

// The CLI run without blocking this process (a fake Redis here must answer
// it): {status, stdout, stderr}; its process group killed at 30 s.
function meterAsync(args, env) {
  const base = Object.assign({}, process.env);
  delete base.COUNTINGHOUSE_SEED_KEY;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN].concat(args), {env: Object.assign(base, env), stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* gone */ } }
    }, 30000);
    child.on('close', (status) => { clearTimeout(timer); resolve({status, stdout, stderr}); });
  });
}

// A fake Redis on an ephemeral port (nothing else can hold it): answers the
// ready check (INFO) and SELECT; HSET with :1 only when `answerHset`; never
// QUIT. -> Promise of {port, close}.
function fakeRedis(answerHset) {
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.on('data', (d) => {
      const text = String(d).toLowerCase();
      if (text.includes('info')) {
        const body = '# Server\r\nredis_version:7.0.0\r\n';
        sock.write(`$${Buffer.byteLength(body)}\r\n${body}\r\n`);
      }
      if (text.includes('select')) sock.write('+OK\r\n');
      if (text.includes('hset') && answerHset) sock.write(':1\r\n');
    });
  });
  const close = () => {
    for (const sock of sockets) sock.destroy();
    server.close();
  };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({port: server.address().port, close})));
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
    assert.ok(run.stderr.includes('the ledger (metering.json in the --storePath you gave) is corrupt, and this command holds no copy of it: let a runtime that had it open before it became corrupt replace it, or move metering.json away to start an empty ledger (every balance and free count starts from nothing; the file you moved is kept as it was)'), run.stderr);
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
  // (R-redis-drop-spin) the CLI's client is a lib/redis-resilient one, which
  // emits no 'error' for a refused connection (node_redis with a
  // retry_strategy): a Redis that can't be reached is still said as such,
  // exit 2, its cause named (the refused connect's own code), within its
  // first-connect bound (spawnSync's timeout bounds a hang)
  it('a Redis that can\'t be reached is said, with exit 2, and no success line', () => {
    const run = meter(['set', '--redisUrl', 'redis://127.0.0.1:1', '--balance', '50'], {COUNTINGHOUSE_SEED_KEY: KEY});   // run-local: not the shared Redis
    assert.strictEqual(run.status, 2, `${run.status} ${run.stdout} ${run.stderr}`);
    assert.ok(/Redis could not be reached \(ECONNREFUSED\)/.test(run.stderr), run.stderr);
    assert.ok(!/set balance/.test(run.stdout), run.stdout);
    assert.ok(!run.stderr.includes(KEY), run.stderr);
  });
  // (the Fable read on #572, N4) an HSET sent but never answered may have
  // been applied: said so, with the full key and where to look, and never
  // the URL; exit 2. Words passed by business.
  it('an HSET that Redis never answers is said as maybe set, with the key to check, exit 2', async () => {
    const redisFake = await fakeRedis(false);
    try {
      const run = await meterAsync(['set', '--redisUrl', `redis://127.0.0.1:${redisFake.port}`, '--balance', '50'], {COUNTINGHOUSE_SEED_KEY: KEY});   // run-local: not the shared Redis
      assert.strictEqual(run.status, 2, `${run.status} ${run.stdout} ${run.stderr}`);
      assert.strictEqual(run.stderr, `countinghouse-meter: the balance was sent, but Redis did not answer within 10 s, so it may or may not be set: check field \`balance\` of key ${meterId(KEY)} on the Redis your --redisUrl names, or run this command again (it sets the balance to the value you gave; it does not add to it)\n`);
      assert.ok(!/set balance/.test(run.stdout), run.stdout);
    } finally {
      redisFake.close();
    }
  });

  // (N4) after the success line, a QUIT that is never answered changes nothing
  it('a balance set, then a QUIT never answered: the success line stands, exit 0', async () => {
    const redisFake = await fakeRedis(true);
    try {
      const run = await meterAsync(['set', '--redisUrl', `redis://127.0.0.1:${redisFake.port}`, '--balance', '50'], {COUNTINGHOUSE_SEED_KEY: KEY});   // run-local: not the shared Redis
      assert.strictEqual(run.status, 0, `${run.status} ${run.stdout} ${run.stderr}`);
      assert.ok(run.stdout.includes(`set balance 50 for ${meterId(KEY)}`), run.stdout);
    } finally {
      redisFake.close();
    }
  });

  trees.hooks();
});

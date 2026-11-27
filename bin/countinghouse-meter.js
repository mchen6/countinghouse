#!/usr/bin/env node
// Sets a key's balance in the runtime's metering ledger:
//
//   COUNTINGHOUSE_SEED_KEY=<key> countinghouse-meter set --storePath <dir> --balance <n>
//       the local store's (--store local --meter; LM1,
//       docs/superpowers/specs/2026-11-11-local-mode-design.md section 1)
//   COUNTINGHOUSE_SEED_KEY=<key> countinghouse-meter set [--store redis] [--redisUrl <url>] --balance <n>
//       the Redis store's, the runtime's default store, on the ledger's db
//       (lib/store.js metering), where lib/metering/redis-provider.js reads it
//
// Which store: --store, or else as the runtime's own default is chosen --
// local with --storePath, Redis without; --redisUrl defaults to the
// runtime's (redis://127.0.0.1:6379, as lib/cli-options.js has it, which
// exports nothing of it: auth 30), and an empty one is
// refused (an unset variable must never fund a local Redis instead).
//
// The key is read from COUNTINGHOUSE_SEED_KEY only, never from an argument
// (it would sit in the shell history and the process list) or a prompt.
// The record is written under the key's fingerprint (lib/key-fingerprint.js
// meterId), the way the runtime looks it up, in either store, and the key's
// free-call counts (toolPriceRecord) are kept; the command prints that
// fingerprint, never the key. Run it with the runtime stopped or running:
// the local write takes the store lock and merges by key, as the runtime's
// do; the Redis one sets one field of the key's hash.
'use strict';

const path = require('path');
const minimist = require('minimist');

// the runtime's default Redis, as lib/cli-options.js has it (kept here: that
// file exports nothing of it, being loaded in workers)
const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
const CLI_CONNECT_MS = 10000;
const USAGE = 'usage: COUNTINGHOUSE_SEED_KEY=<key> countinghouse-meter set (--storePath <dir> | [--store redis] [--redisUrl <url>]) --balance <n>';

function fail(message) {
  process.stderr.write(`countinghouse-meter: ${message}\n`);
  process.exit(2);
}

const argv = minimist(process.argv.slice(2), {string: ['storePath', 'balance', 'store', 'redisUrl']});
const command = argv._[0];
if (command !== 'set' || argv._.length !== 1) fail(USAGE);
const allowed = new Set(['_', 'storePath', 'balance', 'store', 'redisUrl']);
const unknown = Object.keys(argv).filter((k) => !allowed.has(k));
// the names only: a value given to an unknown option may be the key
if (unknown.length > 0) fail(`unknown option ${unknown.map((k) => `--${k}`).join(', ')}; the key is read from COUNTINGHOUSE_SEED_KEY only`);
const key = process.env.COUNTINGHOUSE_SEED_KEY;
if (key == null || key === '') fail('set COUNTINGHOUSE_SEED_KEY to the key whose balance to set');
if (argv.store === '') fail('--store is local or redis');
const store = argv.store != null ? argv.store : (argv.storePath != null ? 'local' : 'redis');
if (store !== 'local' && store !== 'redis') fail('--store is local or redis');
if (argv.redisUrl === '' || (Array.isArray(argv.redisUrl))) fail('--redisUrl, when given, names one Redis');
// A test's own Redis (CH_TEST_REDIS_URL: run-local's private one) and no
// --redisUrl: refused, never the default, which is another Redis -- a test
// that left the option out once seeded this machine's own Redis (the
// reviewer, on B-meter-keys (1)). The variable only adds this refusal.
const testRedis = process.env.CH_TEST_REDIS_URL;
if (store === 'redis' && argv.redisUrl == null && testRedis != null && testRedis !== '' && testRedis !== DEFAULT_REDIS_URL) {
  fail('--redisUrl is required while CH_TEST_REDIS_URL names a test Redis: the default is another Redis');
}
if (store === 'local' && (argv.storePath == null || argv.storePath === '')) fail('--storePath <dir> is required');
if (store === 'local' && argv.redisUrl != null) fail('--redisUrl is for --store redis');
if (store === 'redis' && argv.storePath != null) fail('--storePath is for the local store; --store redis takes --redisUrl');
const balance = Number(argv.balance);
if (argv.balance == null || argv.balance === '' || !Number.isFinite(balance)) fail('--balance must be a finite number');

const {meterId} = require('../lib/key-fingerprint');
const id = meterId(key);

if (store === 'local') {
  const {openJsonFile} = require('../lib/store/json-file');
  // (a directory it can't make or a file it can't read: said, exit 2, never
  // a stack trace naming the operator's path -- the medium on PR 2)
  let file;
  try { file = openJsonFile(path.join(path.resolve(argv.storePath), 'metering.json')); } catch (err) { fail(`the balance could not be written (${err.code || 'error'})`); }
  // Read and written under the store's lock, its answer waited for: a write
  // that fails (a lock that stayed busy, a directory it can't write) is said
  // and exits 2, never a success line over nothing written. set() and close()
  // logged a failed flush and rescheduled it, and close cleared the retry
  // (the final pass's gateway part, A8). Its free-call counts kept.
  file.update(id, (current) => ({balance: balance,
    toolPriceRecord: (current != null && current.toolPriceRecord != null) ? current.toolPriceRecord : {}}), (err) => {
    file.close();
    // (the error's code only: a path can name the operator's directories)
    // (a corrupt ledger this command never saw whole: never replaced by it,
    // R-store-aside-locked; what to do, said)
    if (err != null && err.code === 'ECORRUPT') fail('the ledger (metering.json in the --storePath you gave) is corrupt, and this command holds no copy of it: let a runtime that had it open before it became corrupt replace it, or move metering.json away to start an empty ledger (every balance and free count starts from nothing; the file you moved is kept as it was)');
    if (err) fail(`the balance could not be written (${err.code || 'error'})`);
    process.stdout.write(`set balance ${balance} for ${id}\n`);
  });
} else {
  // (db 0, the ledger's, as lib/store.js's metering opens it; one field of
  // the hash set, its free-call counts kept; a lib/redis-resilient client,
  // as every node_redis client: R-redis-drop-spin)
  // An operator's command waits longer for a first connect than the runtime
  // does (a Redis still loading its data), and no longer than that for the
  // write's answer. A resilient client emits no 'error' for a refused
  // connection: its queued write is answered NR_CLOSED at the bound.
  const client = require('../lib/redis-resilient').createClient(argv.redisUrl != null ? argv.redisUrl : DEFAULT_REDIS_URL, {db: 0},
    CLI_CONNECT_MS, {commandDeadlineMs: CLI_CONNECT_MS});
  // (the error's code only: a connection string can hold a password)
  client.on('error', (err) => fail(`Redis could not be reached (${err.code || 'error'})`));
  client.hset(id, 'balance', String(balance), (err) => {
    if (err != null && (err.code === 'NR_CLOSED' || err.code === 'REDIS_COMMAND_TIMEOUT')) fail(`Redis could not be reached (${err.code})`);
    if (err) fail(`the balance could not be set (${err.code || 'error'})`);
    process.stdout.write(`set balance ${balance} for ${id}\n`);
    client.quit();
  });
}

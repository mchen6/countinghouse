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
// runtime's (lib/cli-options.js DEFAULT_REDIS_URL), and an empty one is
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
if (store === 'local' && (argv.storePath == null || argv.storePath === '')) fail('--storePath <dir> is required');
if (store === 'local' && argv.redisUrl != null) fail('--redisUrl is for --store redis');
if (store === 'redis' && argv.storePath != null) fail('--storePath is for the local store; --store redis takes --redisUrl');
const balance = Number(argv.balance);
if (argv.balance == null || argv.balance === '' || !Number.isFinite(balance)) fail('--balance must be a finite number');

const {meterId} = require('../lib/key-fingerprint');
const id = meterId(key);

if (store === 'local') {
  const {openJsonFile} = require('../lib/store/json-file');
  const file = openJsonFile(path.join(path.resolve(argv.storePath), 'metering.json'));
  const current = file.data[id];
  file.set(id, {balance: balance,
    toolPriceRecord: (current != null && current.toolPriceRecord != null) ? current.toolPriceRecord : {}});
  file.close();
  process.stdout.write(`set balance ${balance} for ${id}\n`);
} else {
  // (db 0, the ledger's, as lib/store.js's metering opens it; one field of
  // the hash set, its free-call counts kept)
  const client = require('redis').createClient(argv.redisUrl != null ? argv.redisUrl : require('../lib/cli-options').DEFAULT_REDIS_URL, {db: 0});
  // (the error's code only: a connection string can hold a password)
  client.on('error', (err) => fail(`Redis could not be reached (${err.code || 'error'})`));
  client.hset(id, 'balance', String(balance), (err) => {
    if (err) fail(`the balance could not be set (${err.code || 'error'})`);
    process.stdout.write(`set balance ${balance} for ${id}\n`);
    client.quit();
  });
}

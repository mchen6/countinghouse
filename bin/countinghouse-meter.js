#!/usr/bin/env node
// Sets a key's balance in the local store's metering (--store local
// --meter; LM1, docs/superpowers/specs/2026-11-11-local-mode-design.md
// section 1):
//
//   COUNTINGHOUSE_SEED_KEY=<key> countinghouse-meter set --storePath <dir> --balance <n>
//
// The key is read from COUNTINGHOUSE_SEED_KEY only, never from an argument
// (it would sit in the shell history and the process list) or a prompt.
// The record is written under the key's fingerprint (lib/key-fingerprint.js
// meterId), the way the runtime looks it up; the command prints that
// fingerprint, never the key. Run it with the runtime stopped or running:
// the write takes the store lock and merges by key, as the runtime's do.
'use strict';

const path = require('path');
const minimist = require('minimist');

function fail(message) {
  process.stderr.write(`countinghouse-meter: ${message}\n`);
  process.exit(2);
}

const argv = minimist(process.argv.slice(2), {string: ['storePath', 'balance']});
const command = argv._[0];
if (command !== 'set') fail('usage: COUNTINGHOUSE_SEED_KEY=<key> countinghouse-meter set --storePath <dir> --balance <n>');
const allowed = new Set(['_', 'storePath', 'balance']);
const unknown = Object.keys(argv).filter((k) => !allowed.has(k));
// the names only: a value given to an unknown option may be the key
if (unknown.length > 0) fail(`unknown option ${unknown.map((k) => `--${k}`).join(', ')}; the key is read from COUNTINGHOUSE_SEED_KEY only`);
const key = process.env.COUNTINGHOUSE_SEED_KEY;
if (key == null || key === '') fail('set COUNTINGHOUSE_SEED_KEY to the key whose balance to set');
if (argv.storePath == null || argv.storePath === '') fail('--storePath <dir> is required');
const balance = Number(argv.balance);
if (argv.balance == null || argv.balance === '' || !Number.isFinite(balance)) fail('--balance must be a finite number');

const {openJsonFile} = require('../lib/store/json-file');
const {meterId} = require('../lib/key-fingerprint');
const id = meterId(key);
const file = openJsonFile(path.join(path.resolve(argv.storePath), 'metering.json'));
const current = file.data[id];
file.set(id, {balance: balance,
  toolPriceRecord: (current != null && current.toolPriceRecord != null) ? current.toolPriceRecord : {}});
file.close();
process.stdout.write(`set balance ${balance} for ${id}\n`);

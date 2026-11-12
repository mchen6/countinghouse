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

  it('refuses a balance that is not a finite number, and a missing --storePath', () => {
    const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-metering-03-'));
    assert.strictEqual(meter(['set', '--storePath', storePath, '--balance', 'lots'], {COUNTINGHOUSE_SEED_KEY: KEY}).status, 2);
    assert.strictEqual(meter(['set', '--balance', '5'], {COUNTINGHOUSE_SEED_KEY: KEY}).status, 2);
  });
});

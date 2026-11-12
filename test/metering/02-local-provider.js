'use strict';

// LM1 B2, Task 4: the local provider's own behaviour. Without --meter one
// user has no balance to run out of and no neighbour to be limited for
// (spec section 1 and 4): every call is recorded, none refused, and nothing
// keyed by an API key is written. With --meter, its records persist.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {LocalMeteringProvider} = require('../../lib/metering');

function call(provider, method, ...args) {
  return new Promise((resolve) => provider[method](...args, (err, result) => resolve({err, result})));
}
function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ch-metering-02-'));
}
function filesUnder(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((d) => d.isDirectory()
    ? filesUnder(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

describe('metering 02: the local provider (LM1 B2)', function() {
  this.timeout(20000);

  it('without --meter: records every call, refuses none, and writes no key', async () => {
    const storePath = tmpStore();
    const key = 'local-0123456789abcdef0123456789abcdef';
    const p = new LocalMeteringProvider({storePath, meter: false, rateLimitMaxPerInterval: 1, rateLimitIntervalMs: 1000});
    for (let i = 0; i < 1000; i++) {
      const r = await call(p, 'recordCall', key, 'tool', 5);
      assert.deepStrictEqual({charged: r.result.charged, balance: r.result.balance}, {charged: 0, balance: null});
      assert.strictEqual((await call(p, 'rateLimit', key)).result.limited, false);
    }
    assert.deepStrictEqual((await call(p, 'checkBalance', key)).result, {apiKey: key, balance: null});
    assert.strictEqual(p.callCount(key, 'tool'), 1000);
    p.close();
    for (const f of filesUnder(storePath)) assert.ok(!fs.readFileSync(f, 'utf8').includes(key), f);
  });

  it('with --meter: the records survive a new provider on the same store, keyed by the key\'s fingerprint, never the key', async () => {
    const storePath = tmpStore();
    const key = 'operator-key-with-a-balance-0001';
    const a = new LocalMeteringProvider({storePath, meter: true});
    await call(a, 'recordCall', key, 'tool', 2);
    a.close();
    const b = new LocalMeteringProvider({storePath, meter: true});
    assert.deepStrictEqual((await call(b, 'checkBalance', key)).result, {apiKey: key, balance: -2});
    b.close();
    const {meterId} = require('../../lib/key-fingerprint');
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(storePath, 'metering.json'), 'utf8'))), [meterId(key)]);
    for (const f of filesUnder(storePath)) assert.ok(!fs.readFileSync(f, 'utf8').includes(key), f);
  });

  it('meterId is the same in every process and state, and full-length', () => {
    const {meterId} = require('../../lib/key-fingerprint');
    assert.strictEqual(meterId('k'), meterId('k'));
    assert.notStrictEqual(meterId('k'), meterId('k2'));
    assert.ok(/^sha256:[0-9a-f]{64}$/.test(meterId('k')), meterId('k'));
  });

  it('with --meter: two processes charging one key lose no charge', async () => {
    const storePath = tmpStore();
    const MOD = require('path').resolve(__dirname, '../../lib/metering/local-provider');
    const charger = () => new Promise((resolve, reject) => {
      const p = require('child_process').spawn(process.execPath, ['-e', `
        const LocalMeteringProvider = require(${JSON.stringify(MOD)});
        const p = new LocalMeteringProvider({storePath: ${JSON.stringify(storePath)}, meter: true});
        let n = 0;
        const next = () => p.recordCall('shared-key', 't', 1, (err) => {
          if (err) { process.stderr.write(err.message); process.exit(1); }
          if (++n < 50) return next();
          p.close();
        });
        next();
      `], {stdio: ['ignore', 'ignore', 'pipe']});
      let err = '';
      p.stderr.on('data', (c) => { err += c; });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
    await Promise.all([charger(), charger()]);
    const check = new LocalMeteringProvider({storePath, meter: true});
    assert.strictEqual((await call(check, 'checkBalance', 'shared-key')).result.balance, -100);
    check.close();
  });

  it('with --meter: a balance seeded while the provider runs is the one it charges', async () => {
    const storePath = tmpStore();
    const p = new LocalMeteringProvider({storePath, meter: true});
    const run = require('child_process').spawnSync(process.execPath,
      [require('path').resolve(__dirname, '../../bin/countinghouse-meter.js'), 'set', '--storePath', storePath, '--balance', '100'],
      {encoding: 'utf8', env: Object.assign({}, process.env, {COUNTINGHOUSE_SEED_KEY: 'seeded-while-running'})});
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual((await call(p, 'checkBalance', 'seeded-while-running')).result.balance, 100);
    assert.strictEqual((await call(p, 'recordCall', 'seeded-while-running', 't', 1)).result.balance, 99);
    p.close();
  });

  it('with --meter: a record keeps its other fields, and a toolPriceRecord stored as a string (as Redis stores it) counts', async () => {
    const storePath = tmpStore();
    const {meterId} = require('../../lib/key-fingerprint');
    fs.writeFileSync(path.join(storePath, 'metering.json'), JSON.stringify({[meterId('k')]:
      {balance: 10, toolPriceRecord: JSON.stringify({t: {count: 1}}), note: 'kept'}}));
    const p = new LocalMeteringProvider({storePath, meter: true});
    assert.strictEqual((await call(p, 'recordCall', 'k', 't', 3)).result.charged, 0);
    assert.strictEqual((await call(p, 'recordCall', 'k', 't', 3)).result.charged, 3);
    p.close();
    const r = JSON.parse(fs.readFileSync(path.join(storePath, 'metering.json'), 'utf8'))[meterId('k')];
    assert.strictEqual(r.note, 'kept');
    assert.strictEqual(r.balance, 7);
  });
});

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

  it('with --meter: the records survive a new provider on the same store', async () => {
    const storePath = tmpStore();
    const a = new LocalMeteringProvider({storePath, meter: true});
    await call(a, 'recordCall', 'k1', 'tool', 2);
    a.close();
    const b = new LocalMeteringProvider({storePath, meter: true});
    assert.deepStrictEqual((await call(b, 'checkBalance', 'k1')).result, {apiKey: 'k1', balance: -2});
    b.close();
  });
});

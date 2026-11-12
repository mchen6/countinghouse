'use strict';

// LM1 B2, Task 4 (plan 2026-11-11-lm1-store-and-identity.md; spec "Tests":
// "the Redis provider's existing tests run against both through the
// interface"): one table of cases, run against RedisMeteringProvider (a
// test db, skipped when no Redis answers) and LocalMeteringProvider with
// --meter (a temp --storePath).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = 'contract-key-0001';
const TOOL = 'contract-tool';

function call(provider, method, ...args) {
  return new Promise((resolve) => provider[method](...args, (err, result) => resolve({err, result})));
}

const PROVIDERS = {
  redis: {
    async make(seed, rate) {
      const redis = require('redis');
      const client = redis.createClient('redis://127.0.0.1:6379', {db: 13});
      client.on('error', () => {});
      const ok = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 1000);
        client.ping((err) => { clearTimeout(timer); resolve(err == null); });
      });
      if (!ok) { client.quit(); return null; }
      await new Promise((resolve) => client.flushdb(resolve));
      if (seed != null) {
        await new Promise((resolve) => client.hmset(KEY, 'balance', String(seed.balance),
          'toolPriceRecord', JSON.stringify(seed.toolPriceRecord || {}), resolve));
      }
      const RedisMeteringProvider = require('../../lib/metering/redis-provider');
      const provider = new RedisMeteringProvider({redisClient: client, rateLimitMaxPerInterval: rate, rateLimitIntervalMs: 1000});
      provider.close = () => client.quit();
      return provider;
    }
  },
  local: {
    async make(seed, rate) {
      const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-metering-01-'));
      const {meterId} = require('../../lib/key-fingerprint');
      if (seed != null) fs.writeFileSync(path.join(storePath, 'metering.json'), JSON.stringify({[meterId(KEY)]: seed}));
      const {LocalMeteringProvider} = require('../../lib/metering');
      const provider = new LocalMeteringProvider({storePath, meter: true, rateLimitMaxPerInterval: rate, rateLimitIntervalMs: 1000});
      provider.close = () => {};
      return provider;
    }
  }
};

for (const [name, kind] of Object.entries(PROVIDERS)) {
  describe(`metering 01: the MeteringProvider contract (${name})`, function() {
    this.timeout(20000);

    it('spends free calls first, then the balance, by the cost', async function() {
      const p = await kind.make({balance: 10, toolPriceRecord: {[TOOL]: {count: 2}}});
      if (p == null) return this.skip();
      try {
        const charged = [];
        for (let i = 0; i < 4; i++) charged.push((await call(p, 'recordCall', KEY, TOOL, 3)).result.charged);
        assert.deepStrictEqual(charged, [0, 0, 3, 3]);
        assert.deepStrictEqual((await call(p, 'checkBalance', KEY)).result, {apiKey: KEY, balance: 4});
      } finally { p.close(); }
    });

    it('a key with no record has balance 0, and its calls take it below zero', async function() {
      const p = await kind.make(null);
      if (p == null) return this.skip();
      try {
        assert.deepStrictEqual((await call(p, 'checkBalance', KEY)).result, {apiKey: KEY, balance: 0});
        assert.strictEqual((await call(p, 'recordCall', KEY, TOOL, 2)).result.balance, -2);
      } finally { p.close(); }
    });

    it('limits the calls a key makes in a window, when a limit is set', async function() {
      const p = await kind.make(null, 2);
      if (p == null) return this.skip();
      try {
        const limited = [];
        for (let i = 0; i < 3; i++) limited.push((await call(p, 'rateLimit', KEY)).result.limited);
        assert.deepStrictEqual(limited, [false, false, true]);
      } finally { p.close(); }
    });

    it('counts a refused call too, as rolling-rate-limiter does: a client that keeps calling stays limited', async function() {
      const p = await kind.make(null, 2);
      if (p == null) return this.skip();
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      try {
        const limited = [];
        const at = async () => limited.push((await call(p, 'rateLimit', KEY)).result.limited);
        await at(); await at();
        await wait(500); await at();
        await wait(100); await at();
        await wait(550); await at();
        assert.deepStrictEqual(limited, [false, false, true, true, true]);
      } finally { p.close(); }
    });

    it('is never limited with no limit set', async function() {
      const p = await kind.make(null);
      if (p == null) return this.skip();
      try {
        for (let i = 0; i < 5; i++) assert.strictEqual((await call(p, 'rateLimit', KEY)).result.limited, false);
      } finally { p.close(); }
    });

    it('needs an apiKey', async function() {
      const p = await kind.make(null);
      if (p == null) return this.skip();
      try {
        assert.strictEqual((await call(p, 'checkBalance', null)).err.message, 'apiKey is required');
        assert.strictEqual((await call(p, 'recordCall', null, TOOL, 1)).err.message, 'apiKey is required');
      } finally { p.close(); }
    });
  });
}

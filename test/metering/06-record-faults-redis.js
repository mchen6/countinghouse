'use strict';
// One key's own usage record that can't be charged, on a real Redis (the
// scripts run as Redis runs them): a key that isn't a hash, a balance that
// isn't a number, a free-call record that isn't JSON. Each refuses that key's
// billed calls (LEDGER_RECORD_INVALID), never marks the provider, and leaves
// every other key served; a repaired record is found by that key's own probe
// (at most once a second) and its calls are served again.
const assert = require('assert');
const {redisUrlFor} = require('../helpers/test-env');
const {meterId} = require('../../lib/key-fingerprint');

describe('metering 06: a key\'s own record fault, on a real Redis', function() {
  this.timeout(30000);
  const RedisMeteringProvider = require('../../lib/metering/redis-provider');
  const resilient = require('../../lib/redis-resilient');
  const logger = require('../../lib/logger');
  const tag = `m06-${process.pid}`;
  const KEYS = {string: `${tag}-string`, balance: `${tag}-balance`, json: `${tag}-json`, good: `${tag}-good`};
  let client = null;
  let provider = null;
  let clock = 0;
  let realLog = null;
  const cmd = (name, ...args) => new Promise((resolve, reject) => client[name](...args, (e, r) => (e ? reject(e) : resolve(r))));
  const charge = (key) => new Promise((resolve) => provider.recordCall(key, 'tool-a', 1, (err, r) => resolve({err, r})));
  const ask = (key) => new Promise((resolve) => provider.rateLimit(key, (err) => resolve(err), {billed: true}));

  before(async () => {
    realLog = {E: logger.E, I: logger.I};
    logger.E = () => {};
    logger.I = () => {};
    client = resilient.createClient(redisUrlFor(), {db: 0}, undefined, {commandDeadlineMs: 3000});
    client.on('error', () => {});
  });
  after(async () => {
    if (client != null) {
      await cmd('del', ...Object.values(KEYS).map(meterId)).catch(() => {});
      client.quit();
    }
    Object.assign(logger, realLog);
  });
  beforeEach(async () => {
    // (a provider of its own per case: no key's mark carried from another)
    clock = 1000000;
    provider = new RedisMeteringProvider({redisClient: client, now: () => clock});
    await cmd('del', ...Object.values(KEYS).map(meterId));
    await cmd('hset', meterId(KEYS.good), 'balance', '10');
    await cmd('set', meterId(KEYS.string), 'not a hash');
    await cmd('hset', meterId(KEYS.balance), 'balance', 'abc');
    await cmd('hset', meterId(KEYS.json), 'balance', '10', 'toolPriceRecord', '{not json');
  });

  for (const [which, code] of [['string', 'WRONGTYPE'], ['balance', 'BADRECORD'], ['json', 'BADRECORD']]) {
    it(`a ${which === 'string' ? 'key that isn\'t a hash' : (which === 'balance' ? 'balance that isn\'t a number' : 'free-call record that isn\'t JSON')}: ${code}, that key refused LEDGER_RECORD_INVALID, the provider unmarked, another key served`, async () => {
      const failed = await charge(KEYS[which]);
      assert.strictEqual(failed.err && failed.err.code, code, String(failed.err && failed.err.message));
      const refused = await ask(KEYS[which]);
      assert.strictEqual(refused && refused.code, 'LEDGER_RECORD_INVALID');
      assert.strictEqual(provider._chargeMark.marked(), false, 'the provider is not marked');
      assert.strictEqual(await ask(KEYS.good), null);
      const good = await charge(KEYS.good);
      assert.strictEqual(good.err, null, String(good.err && good.err.message));
      assert.strictEqual(good.r.charged, 1);
    });
  }

  for (const shown of [' 5', '5 ', 'nan', 'inf', '', '1e-5000']) {
    it(`a balance Redis won't add to (${JSON.stringify(shown)}): BADRECORD, that key refused LEDGER_RECORD_INVALID, the provider unmarked, another key served`, async () => {
      await cmd('hset', meterId(KEYS.balance), 'balance', shown);
      const failed = await charge(KEYS.balance);
      assert.strictEqual(failed.err && failed.err.code, 'BADRECORD', String(failed.err && failed.err.message));
      // (the CHANGELOG's words: its billed calls are refused until it is repaired)
      const refused = await ask(KEYS.balance);
      assert.strictEqual(refused && refused.code, 'LEDGER_RECORD_INVALID');
      assert.strictEqual(provider._chargeMark.marked(), false, 'the provider is not marked');
      assert.strictEqual(await ask(KEYS.good), null);
    });
  }

  for (const shown of ['abc', '1e-5000']) {
    it(`a balance asked of a record whose balance the scripts refuse (${shown}): LEDGER_RECORD_INVALID, as its charged calls are`, async () => {
      await cmd('hset', meterId(KEYS.balance), 'balance', shown);
      const r = await new Promise((resolve) => provider.checkBalance(KEYS.balance, (err, b) => resolve({err, b})));
      assert.strictEqual(r.err && r.err.code, 'LEDGER_RECORD_INVALID', JSON.stringify(r.b));
      assert.strictEqual((await ask(KEYS.balance)).code, 'LEDGER_RECORD_INVALID');
    });
  }

  it('a free-call record Redis decodes but won\'t encode (a count of 1e999): BADRECORD, that key\'s alone, the provider unmarked', async () => {
    await cmd('hset', meterId(KEYS.json), 'toolPriceRecord', '{"tool-a":{"count":1e999}}');
    const failed = await charge(KEYS.json);
    assert.strictEqual(failed.err && failed.err.code, 'BADRECORD', String(failed.err && failed.err.message));
    assert.strictEqual(provider._chargeMark.marked(), false, 'the provider is not marked');
    assert.strictEqual((await ask(KEYS.json)).code, 'LEDGER_RECORD_INVALID');
  });

  it('a free call on a marked key clears nothing: only a paid charge shows its balance can be charged', async () => {
    await cmd('hset', meterId(KEYS.balance), 'balance', '1e-5000');
    assert.strictEqual((await charge(KEYS.balance)).err.code, 'BADRECORD');
    await cmd('hset', meterId(KEYS.balance), 'toolPriceRecord', '{"tool-a":{"count":1}}');
    const free = await charge(KEYS.balance);
    assert.ok(free.err == null && free.r.charged === 0, JSON.stringify(free));
    assert.strictEqual((await ask(KEYS.balance)).code, 'LEDGER_RECORD_INVALID', 'a free call cleared the mark');
  });

  it('a charge that succeeds on a marked key\'s record clears its mark at once, and forgets it', async () => {
    await charge(KEYS.string);
    await cmd('del', meterId(KEYS.string));
    const after = await charge(KEYS.string);
    assert.strictEqual(after.err, null, String(after.err && after.err.message));
    assert.strictEqual(await ask(KEYS.string), null, 'served within the second');
    assert.strictEqual(provider._recordMarks.size, 0);
  });

  // (Redis 6.2 places and dashes a shared error from redis.pcall, "@user_script:
  // 1: -READONLY ...\r\n", checked against 6.2.24; an ordinary one comes
  // unplaced: the scripts' own function takes the place off, run here as
  // Redis runs it)
  it('a redis.pcall error as Redis 6 words it: the script\'s place taken off, its code word first', async () => {
    const run = (e) => cmd('eval', `${RedisMeteringProvider.UNPLACED}\nreturn unplaced(ARGV[1])`, 0, e);
    assert.deepStrictEqual(await Promise.all([
      run('@user_script: 32: -OOM command not allowed when used memory > \'maxmemory\'.\r\n'),
      run('@user_script: 1: -READONLY You can\'t write against a read only replica.\r\n'),
      run('READONLY You can\'t write against a read only replica.'),
      run('ERR hash value is not a float')]),
    ['OOM command not allowed when used memory > \'maxmemory\'.', 'READONLY You can\'t write against a read only replica.',
      'READONLY You can\'t write against a read only replica.', 'ERR hash value is not a float']);
  });

  it('a repaired record is found by that key\'s own probe, at most once a second: its calls are served again', async () => {
    await charge(KEYS.string);
    assert.strictEqual((await ask(KEYS.string)).code, 'LEDGER_RECORD_INVALID');
    await cmd('del', meterId(KEYS.string));
    // (within the second: refused from the mark, the record not probed)
    assert.strictEqual((await ask(KEYS.string)).code, 'LEDGER_RECORD_INVALID');
    clock += 1000;
    assert.strictEqual(await ask(KEYS.string), null);
    const after = await charge(KEYS.string);
    assert.strictEqual(after.err, null, String(after.err && after.err.message));
  });
});

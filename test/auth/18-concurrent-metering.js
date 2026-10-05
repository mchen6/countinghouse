const assert = require('assert');
const util   = require('util');

const RedisMeteringProvider = require('../../lib/metering/redis-provider');

// Pure unit tests -- no server needed, RedisMeteringProvider is instantiated
// directly against the same db (0) lib/countinghouse-interface.js hands it.
//
// Covers charges lost under concurrency. recordCall used to read the balance
// (HMGET) and write it back (HMSET) as two separate round trips, so calls
// that overlapped all read the same balance and all wrote the same result.
// Measured before the fix with a composite fanning ten ctx.call hops out
// through Promise.all at --mcpToolCallCost 1: the caller's balance moved by
// 2, not 10, and every hop after the first reported the same running balance.
// Sequential hops were always correct, which is why nothing caught it -- no
// composite in the tree ran its hops concurrently.
//
// The quota case is the same race on the other field: every overlapping call
// read the same remaining free-call count, so a quota of 5 served all 20.
describe('auth 18: RedisMeteringProvider.recordCall keeps every charge under concurrency', function() {
  this.timeout(20000);

  const KEY  = `concurrent-metering-18-${process.pid}`;
  const TOOL = 'concurrent-metering-tool';

  let provider = null;
  let recordCall = null;

  before(() => {
    provider   = new RedisMeteringProvider({redisUrl: 'redis://127.0.0.1:6379', redisDb: 0});
    recordCall = util.promisify(provider.recordCall.bind(provider));
  });

  beforeEach((done) => { provider.redisClient.del(KEY, done); });

  after((done) => {
    provider.redisClient.del(KEY, () => { provider.redisClient.quit(done); });
  });

  function storedBalance() {
    return util.promisify(provider.checkBalance.bind(provider))(KEY).then((r) => r.balance);
  }

  function concurrentCalls(n) {
    return Promise.all(Array.from({length: n}, () => recordCall(KEY, TOOL, 1)));
  }

  it('50 overlapping calls at cost 1 leave the balance at exactly -50', async () => {
    await concurrentCalls(50);
    assert.strictEqual(await storedBalance(), -50);
  });

  it('each overlapping call reports its own running balance, none repeated', async () => {
    const results  = await concurrentCalls(50);
    const reported = results.map((r) => r.balance).sort((a, b) => b - a);
    const expected = Array.from({length: 50}, (_, i) => -(i + 1));

    assert.deepStrictEqual(reported, expected);
    assert.ok(results.every((r) => r.charged === 1), 'every call must report charged: 1');
  });

  it('a free-call quota of 5 serves exactly 5 of 20 overlapping calls, and the rest are charged', async () => {
    const record = {};
    record[TOOL] = {count: 5};
    await util.promisify(provider.redisClient.hmset.bind(provider.redisClient))(
      KEY, 'toolPriceRecord', JSON.stringify(record));

    const results = await concurrentCalls(20);
    const free    = results.filter((r) => r.charged === 0);
    const remaining = free.map((r) => r.remainingFreeCalls).sort((a, b) => b - a);

    assert.strictEqual(free.length, 5, `expected 5 free calls, got ${free.length}`);
    assert.deepStrictEqual(remaining, [4, 3, 2, 1, 0]);
    assert.strictEqual(await storedBalance(), -15);

    const stored = await util.promisify(provider.redisClient.hget.bind(provider.redisClient))(
      KEY, 'toolPriceRecord');
    assert.strictEqual(JSON.parse(stored)[TOOL].count, 0);
  });

  // Not a concurrency case: it pins the legacy-schema fallback, which the fix
  // moved across the same boundary as everything else and which had no test.
  it('still seeds a free-call quota from the legacy `devices` field, then charges once it is spent', async () => {
    const DEVICE_ID  = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767';
    const SERVICE_ID = 'urn:countinghouse-com:serviceID:echoService';
    const legacyTool = RedisMeteringProvider.encodeLegacyTool(DEVICE_ID, SERVICE_ID, 'echo');

    const priceRecord = {};
    priceRecord[SERVICE_ID] = {echo: {count: 2}};
    await util.promisify(provider.redisClient.hmset.bind(provider.redisClient))(
      KEY, 'devices', JSON.stringify([{deviceID: DEVICE_ID, priceRecord: priceRecord}]));

    const first  = await recordCall(KEY, legacyTool, 1);
    const second = await recordCall(KEY, legacyTool, 1);
    const third  = await recordCall(KEY, legacyTool, 1);

    assert.deepStrictEqual([first.charged, first.remainingFreeCalls],   [0, 1]);
    assert.deepStrictEqual([second.charged, second.remainingFreeCalls], [0, 0]);
    assert.deepStrictEqual([third.charged, third.balance],              [1, -1]);
  });
});

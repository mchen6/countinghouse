'use strict';
// A billed call runs only while its charge can be recorded (the owner's
// decision, 11-27: option a). A provider that fails a charge -- the local
// ledger's write, Redis's answer -- is marked: the next billed call is refused
// retryably (LEDGER_UNWRITABLE, LEDGER_UNREACHABLE), with one log line when the
// mark is set and one when it clears. While marked, at most one probe a
// second (a write of the ledger, a PING): one that succeeds clears the mark
// and the call goes on; between probes the mark refuses without touching the
// store. An unbilled call never asks. A refused call is never charged and is
// not counted by the limiter. Without --meter nothing is recorded, so every
// call can be.
const assert = require('assert');
const path = require('path');
const {CODES} = require('../../lib/error-catalogue');
const {keyFingerprint} = require('../../lib/key-fingerprint');

const KEY = `charge-mark-key-${process.pid}`;

describe('metering 05: a billed call runs only while its charge can be recorded', function() {
  this.timeout(30000);
  const trees = require('../helpers/test-tmp').forFile(['ch-metering-05-']);
  const logger = require('../../lib/logger');
  let logged = [];
  let real = null;
  before(() => { real = {E: logger.E, I: logger.I, W: logger.W}; });
  beforeEach(() => {
    logged = [];
    logger.E = (x) => { logged.push(['E', String(x && x.message != null ? x.message : x)]); };
    logger.I = (x) => { logged.push(['I', String(x)]); };
    logger.W = (x) => { logged.push(['W', String(x)]); };
  });
  afterEach(() => { Object.assign(logger, real); });

  const ask = (provider, billed) => new Promise((resolve) => provider.rateLimit(KEY, (err, r) => resolve({err, r}), {billed}));
  const charge = (provider) => new Promise((resolve) => provider.recordCall(KEY, 'tool-a', 1, (err, r) => resolve({err, r})));

  it('the two texts word for word: retryable, 503, the runtime\'s', () => {
    assert.strictEqual(CODES.LEDGER_UNREACHABLE.en, 'The usage ledger can\'t be reached right now; charged calls and balance checks are refused until it can be reached again: retry shortly');
    assert.strictEqual(CODES.LEDGER_UNWRITABLE.en, 'The usage ledger can\'t be written right now; charged calls are refused until a write succeeds again: retry shortly');
    for (const c of [CODES.LEDGER_UNREACHABLE, CODES.LEDGER_UNWRITABLE]) assert.deepStrictEqual([c.kind, c.retryable, c.httpStatus], ['runtime', true, 503]);
  });

  describe('the local ledger (--meter)', () => {
    const LocalMeteringProvider = require('../../lib/metering/local-provider');
    let clock = 0;
    const open = () => {
      const storePath = trees.mkdtemp('ch-metering-05-');
      clock = 1000000;
      return {storePath, provider: new LocalMeteringProvider({storePath, meter: true, now: () => clock})};
    };

    it('a charge whose write fails marks the ledger: the next billed call is refused LEDGER_UNWRITABLE, an unbilled one is not; one log line naming the ledger and the code', async () => {
      const {storePath, provider} = open();
      const update = provider.file.update;
      provider.file.update = (key, fn, cb) => cb(Object.assign(new Error('no space left on device'), {code: 'ENOSPC', storeWrite: true}));
      const first = await charge(provider);
      assert.strictEqual(first.err && first.err.code, 'ENOSPC');
      provider.file.writeNow = (cb) => cb(Object.assign(new Error('still full'), {code: 'ENOSPC'}));
      const billed = await ask(provider, true);
      assert.strictEqual(billed.err && billed.err.code, 'LEDGER_UNWRITABLE');
      const unbilled = await ask(provider, false);
      assert.strictEqual(unbilled.err, null);
      await ask(provider, true);
      const ledger = path.join(storePath, 'metering.json');
      const marks = logged.filter(([, l]) => l.includes('could not be written'));
      assert.deepStrictEqual(marks, [['E', `the usage ledger at ${ledger} could not be written (ENOSPC); charged calls are refused until a write succeeds: check the disk (space, permissions)`]]);
      provider.file.update = update;
    });

    it('while marked, at most one probe write a second; one that succeeds clears the mark, says so once, and the call goes on', async () => {
      const {storePath, provider} = open();
      provider.file.update = (key, fn, cb) => cb(Object.assign(new Error('io'), {code: 'EIO', storeWrite: true}));
      await charge(provider);
      let probes = 0;
      let writable = false;
      provider.file.writeNow = (cb) => { probes++; return writable ? cb(null) : cb(Object.assign(new Error('io'), {code: 'EIO'})); };
      // (within the second the mark was set: refused from the mark, no write)
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNWRITABLE');
      assert.strictEqual(probes, 0);
      clock += 1000;
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNWRITABLE');
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNWRITABLE');
      assert.strictEqual(probes, 1);
      writable = true;
      clock += 1000;
      assert.strictEqual((await ask(provider, true)).err, null);
      assert.strictEqual(probes, 2);
      assert.strictEqual((await ask(provider, true)).err, null);
      assert.strictEqual(probes, 2, 'no probe once clear');
      const ledger = path.join(storePath, 'metering.json');
      assert.deepStrictEqual(logged.filter(([, l]) => l.includes('can be written again')), [['I', `the usage ledger at ${ledger} can be written again; charged calls are served`]]);
    });

    it('a refused call is not counted by the limiter', async () => {
      const storePath = trees.mkdtemp('ch-metering-05-');
      const provider = new LocalMeteringProvider({storePath, meter: true, now: () => 1, rateLimitMaxPerInterval: 1});
      provider.file.update = (key, fn, cb) => cb(Object.assign(new Error('io'), {code: 'EIO', storeWrite: true}));
      await charge(provider);
      provider.file.writeNow = (cb) => cb(Object.assign(new Error('io'), {code: 'EIO'}));
      let counted = 0;
      const limiter = provider._rateLimiter;
      provider._rateLimiter = (id, cb) => { counted++; return limiter(id, cb); };
      for (let i = 0; i < 3; i++) assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNWRITABLE');
      assert.strictEqual(counted, 0);
    });

    it('a write that fails in the store is told as a write\'s failure (storeWrite); a lock that stays busy is not', async () => {
      const {provider} = open();
      const fsMod = require('fs');
      const realOpen = fsMod.openSync;
      fsMod.openSync = function(p, ...rest) {
        if (String(p).includes('.tmp-')) throw Object.assign(new Error('no space left on device'), {code: 'ENOSPC'});
        return realOpen.call(this, p, ...rest);
      };
      let r;
      try { r = await charge(provider); } finally { fsMod.openSync = realOpen; }
      assert.ok(r.err != null && r.err.code === 'ENOSPC' && r.err.storeWrite === true, String(r.err && r.err.message));
      provider.file.writeNow = (cb) => cb(Object.assign(new Error('no space'), {code: 'ENOSPC'}));
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNWRITABLE');
      // (busy: no storeWrite, so no mark)
      const other = open().provider;
      other.file.update = (key, fn, cb) => cb(new Error('the store lock stayed busy for 10000 ms'));
      await charge(other);
      assert.strictEqual((await ask(other, true)).err, null);
    });

    it('without --meter nothing is recorded, so every call can be', async () => {
      const provider = new LocalMeteringProvider({storePath: trees.mkdtemp('ch-metering-05-'), meter: false});
      assert.strictEqual(await new Promise((resolve) => provider.chargeable(KEY, resolve)), null);
      assert.strictEqual((await ask(provider, true)).err, null);
    });
  });

  describe('Redis', () => {
    const RedisMeteringProvider = require('../../lib/metering/redis-provider');
    // a client as node_redis's, on a Redis this test plays
    function fakeClient() {
      const c = {ready: true, pings: 0, pingOk: false, evalErr: null, hmgetErr: null,
        ping(cb) { c.pings++; process.nextTick(cb, c.pingOk ? null : Object.assign(new Error('Redis did not answer PING within 3000 ms'), {code: 'REDIS_COMMAND_TIMEOUT'}), c.pingOk ? 'PONG' : undefined); },
        eval(...args) { const cb = args[args.length - 1]; process.nextTick(cb, c.evalErr, c.evalErr ? undefined : [0, '9', 0]); },
        hmget(id, f, cb) { process.nextTick(cb, c.hmgetErr, c.hmgetErr ? undefined : ['5']); },
        on() {}};
      return c;
    }
    let clock = 0;
    const make = (client) => { clock = 1000000; return new RedisMeteringProvider({redisClient: client, now: () => clock}); };

    it('a charge that fails marks it: the next billed call is refused LEDGER_UNREACHABLE; a PING at most once a second clears it; one line each way, no URL or message', async () => {
      const client = fakeClient();
      const provider = make(client);
      client.evalErr = Object.assign(new Error('Redis did not answer EVAL within 3000 ms (redis://user:pw@host.invalid)'), {code: 'REDIS_COMMAND_TIMEOUT'});
      assert.strictEqual((await charge(provider)).err.code, 'REDIS_COMMAND_TIMEOUT');
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNREACHABLE');
      assert.strictEqual(client.pings, 0);
      assert.strictEqual((await ask(provider, false)).err, null);
      clock += 1000;
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNREACHABLE');
      assert.strictEqual(client.pings, 1);
      client.pingOk = true;
      clock += 1000;
      assert.strictEqual((await ask(provider, true)).err, null);
      assert.strictEqual(client.pings, 2);
      assert.deepStrictEqual(logged.filter(([, l]) => l.includes('usage ledger (Redis)')), [
        ['E', 'the usage ledger (Redis) can\'t be reached (REDIS_COMMAND_TIMEOUT); charged calls are refused until it answers'],
        ['I', 'the usage ledger (Redis) answers again; charged calls are served']]);
    });

    it('a client that isn\'t connected refuses a billed call before any command, and marks it', async () => {
      const client = fakeClient();
      client.ready = false;
      const provider = make(client);
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNREACHABLE');
      assert.ok(logged.some(([w, l]) => w === 'E' && l === 'the usage ledger (Redis) can\'t be reached (NR_CLOSED); charged calls are refused until it answers'), JSON.stringify(logged));
    });

    it('a balance asked while Redis can\'t answer: LEDGER_UNREACHABLE, never node_redis\'s code or message', async () => {
      const client = fakeClient();
      const provider = make(client);
      client.hmgetErr = Object.assign(new Error('HMGET can\'t be processed. The connection is already closed.'), {code: 'NR_CLOSED'});
      const r = await new Promise((resolve) => provider.checkBalance(KEY, (err, b) => resolve({err, b})));
      assert.strictEqual(r.err && r.err.code, 'LEDGER_UNREACHABLE');
      assert.ok(!r.err.message.includes('connection is already closed'), r.err.message);
    });
  });

  it('a charge lost mid-call is logged with the key\'s fingerprint, the tool and the amount, never the key or the store\'s message', () => {
    const {chargeLost} = require('../../lib/metering/charge-bound');
    const line = chargeLost('dev:::svc:::act', KEY, 3, Object.assign(new Error(`ERR something ${KEY}`), {code: 'NR_CLOSED'})).message;
    assert.strictEqual(line, `metering: a call's charge was not recorded: ${keyFingerprint(KEY)}, tool dev:::svc:::act, amount 3 (NR_CLOSED)`);
    assert.ok(!line.includes(KEY));
  });

  trees.hooks();
});

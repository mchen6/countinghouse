'use strict';
// A billed call runs only while its charge can be recorded (the owner's
// decision, 11-27: option a). A provider that fails a charge -- the local
// ledger's write, Redis's answer -- is marked: the next billed call is refused
// retryably (LEDGER_UNWRITABLE, LEDGER_UNREACHABLE), with one log line when the
// mark is set and one when it clears. While marked, at most one probe a
// second (a write of the ledger, a Redis probe key set): one that succeeds clears the mark
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
      provider.file.update = (key, fn, cb) => cb(Object.assign(new Error('no space left on device'), {code: 'ENOSPC'}));
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
      provider.file.update = (key, fn, cb) => cb(Object.assign(new Error('io'), {code: 'EIO'}));
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
      provider.file.update = (key, fn, cb) => cb(Object.assign(new Error('io'), {code: 'EIO'}));
      await charge(provider);
      provider.file.writeNow = (cb) => cb(Object.assign(new Error('io'), {code: 'EIO'}));
      let counted = 0;
      const limiter = provider._rateLimiter;
      provider._rateLimiter = (id, cb) => { counted++; return limiter(id, cb); };
      for (let i = 0; i < 3; i++) assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNWRITABLE');
      assert.strictEqual(counted, 0);
    });

    it('a write that fails in the store marks the ledger, as a lock held past the wait does; a read that failed does not', async () => {
      const {provider} = open();
      const fsMod = require('fs');
      const realOpen = fsMod.openSync;
      fsMod.openSync = function(p, ...rest) {
        if (String(p).includes('.tmp-')) throw Object.assign(new Error('no space left on device'), {code: 'ENOSPC'});
        return realOpen.call(this, p, ...rest);
      };
      let r;
      try { r = await charge(provider); } finally { fsMod.openSync = realOpen; }
      assert.ok(r.err != null && r.err.code === 'ENOSPC', String(r.err && r.err.message));
      provider.file.writeNow = (cb) => cb(Object.assign(new Error('no space'), {code: 'ENOSPC'}));
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNWRITABLE');
      // (a lock held past the wait: the charge was lost, so marked too)
      const busy = open().provider;
      busy.file.update = (key, fn, cb) => cb(new Error('the store lock stayed busy for 10000 ms'));
      busy.file.writeNow = (cb) => cb(Object.assign(new Error('busy'), {code: 'EBUSY'}));
      await charge(busy);
      assert.strictEqual((await ask(busy, true)).err.code, 'LEDGER_UNWRITABLE');
      // (a read that failed is the ledger's other state, refused as itself: no mark)
      const read = open().provider;
      read.file.update = (key, fn, cb) => cb(Object.assign(new Error('EIO, read'), {code: 'EIO', storeRead: true}));
      await charge(read);
      assert.strictEqual(read._chargeMark.marked(), false);
    });

    it('without --meter nothing is recorded, so every call can be', async () => {
      const provider = new LocalMeteringProvider({storePath: trees.mkdtemp('ch-metering-05-'), meter: false});
      assert.strictEqual(await new Promise((resolve) => provider.chargeable(KEY, resolve)), null);
      assert.strictEqual((await ask(provider, true)).err, null);
    });
  });

  describe('Redis', () => {
    const RedisMeteringProvider = require('../../lib/metering/redis-provider');
    const {CountinghouseError} = require('../../lib/countinghouse-error');
    // a client as node_redis's, on a Redis this test plays: evalErr(key,
    // probe) answers each EVAL (the record script, or the record probe)
    function fakeClient() {
      const c = {ready: true, sets: 0, setErr: null, recordProbes: 0, hmgetErr: null, evalErr: () => null,
        set(...args) { c.sets++; const cb = args[args.length - 1]; process.nextTick(cb, c.setErr, c.setErr ? undefined : 'OK'); },
        eval(script, n, key, ...rest) {
          const cb = rest[rest.length - 1];
          // (the record probe: the record's checks and a zero write, no tool)
          const probe = !/ARGV\[1\]/.test(script);
          if (probe) c.recordProbes++;
          const err = c.evalErr(key, probe);
          process.nextTick(cb, err, err ? undefined : (probe ? '0' : [0, '9', 0]));
        },
        hmget(id, f, cb) { process.nextTick(cb, c.hmgetErr, c.hmgetErr ? undefined : ['5']); },
        listeners: [],
        on(ev, f) { if (ev === 'ready') c.listeners.push(f); },
        connect() { c.ready = true; for (const f of c.listeners) f(); }};
      return c;
    }
    let clock = 0;
    const make = (client) => { clock = 1000000; return new RedisMeteringProvider({redisClient: client, now: () => clock}); };
    // (a URL with userinfo in the store's message, built at run time: the
    // log line must never carry it)
    const withUserinfo = `redis://${['te', 'st'].join('')}:${['x', 'y'].join('')}@host.invalid`;
    const timeout = () => Object.assign(new Error(`Redis did not answer EVAL within 3000 ms (${withUserinfo})`), {code: 'REDIS_COMMAND_TIMEOUT'});
    const askAs = (provider, key) => new Promise((resolve) => provider.rateLimit(key, (err) => resolve(err), {billed: true}));
    const chargeAs = (provider, key) => new Promise((resolve) => provider.recordCall(key, 'tool-a', 1, (err) => resolve(err)));

    it('a charge that fails marks it: the next billed call is refused LEDGER_UNREACHABLE; a probe write at most once a second clears it; one line each way, no URL or message', async () => {
      const client = fakeClient();
      const provider = make(client);
      client.evalErr = () => timeout();
      client.setErr = timeout();
      assert.strictEqual((await charge(provider)).err.code, 'REDIS_COMMAND_TIMEOUT');
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNREACHABLE');
      assert.strictEqual(client.sets, 0);
      assert.strictEqual((await ask(provider, false)).err, null);
      clock += 1000;
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNREACHABLE');
      assert.strictEqual(client.sets, 1);
      client.setErr = null;
      client.evalErr = () => null;
      clock += 1000;
      assert.strictEqual((await ask(provider, true)).err, null);
      assert.strictEqual(client.sets, 2);
      assert.deepStrictEqual(logged.filter(([, l]) => l.includes('usage ledger (Redis)')), [
        ['E', 'the usage ledger (Redis) can\'t be reached (REDIS_COMMAND_TIMEOUT); charged calls are refused until it answers'],
        ['I', 'the usage ledger (Redis) answers again; charged calls are served']]);
    });

    it('a Redis that answers but refuses writes (READONLY) keeps the mark: the probe is a write', async () => {
      const client = fakeClient();
      const provider = make(client);
      client.evalErr = () => Object.assign(new Error('READONLY You can\'t write against a read only replica.'), {code: 'READONLY'});
      client.setErr = Object.assign(new Error('READONLY You can\'t write against a read only replica.'), {code: 'READONLY'});
      await charge(provider);
      clock += 1000;
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNREACHABLE');
      clock += 1000;
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNREACHABLE');
      assert.strictEqual(client.sets, 2);
    });

    it('a failure that comes while a probe is out keeps the mark, whatever the probe answers', async () => {
      const client = fakeClient();
      const provider = make(client);
      client.evalErr = () => timeout();
      await charge(provider);
      clock += 1000;
      // (the probe answers on the next tick; a charge fails before it does)
      const asked = ask(provider, true);
      provider._chargeMark.mark(timeout());
      assert.strictEqual((await asked).err.code, 'LEDGER_UNREACHABLE');
    });

    it('a client that lost its connection refuses a billed call before any command, and marks it', async () => {
      const client = fakeClient();
      const provider = make(client);
      client.ready = false;
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNREACHABLE');
      assert.ok(logged.some(([w, l]) => w === 'E' && l === 'the usage ledger (Redis) can\'t be reached (NR_CLOSED); charged calls are refused until it answers'), JSON.stringify(logged));
    });

    it('a client not yet connected the first time refuses a billed call, retryably, with no outage marked or said; once ready, served at once', async () => {
      const client = fakeClient();
      client.ready = false;
      const provider = make(client);
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNREACHABLE');
      assert.strictEqual(provider._chargeMark.marked(), false);
      assert.deepStrictEqual(logged.filter(([w]) => w === 'E'), []);
      client.connect();
      assert.strictEqual((await ask(provider, true)).err, null, 'served in the same second it connected');
    });

    it('a key\'s record probe that fails for the store (READONLY) marks the store, and that key is refused retryably, never as its record\'s; a check while its probe is out is refused retryably', async () => {
      const client = fakeClient();
      const provider = make(client);
      const {meterId} = require('../../lib/key-fingerprint');
      const readonly = () => Object.assign(new Error('READONLY You can\'t write against a read only replica.'), {code: 'READONLY'});
      let fault = () => Object.assign(new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), {code: 'WRONGTYPE'});
      client.evalErr = (key) => (key === meterId(KEY) ? fault() : null);
      await charge(provider);
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_RECORD_INVALID');
      fault = readonly;
      clock += 1000;
      const during = ask(provider, true);
      // (the record probe answers on the next tick: this check comes while it is out)
      const meanwhile = await ask(provider, true);
      assert.strictEqual(meanwhile.err.code, 'LEDGER_UNREACHABLE', 'a check during the record probe');
      const r = await during;
      assert.strictEqual(r.err.code, 'LEDGER_UNREACHABLE', `the record probe's own answer: ${r.err.code}`);
      assert.strictEqual(provider._chargeMark.marked(), true, 'the store is marked');
      // (the store back, the record repaired: its probe clears both, in turn)
      fault = () => null;
      clock += 1000;
      assert.strictEqual((await ask(provider, true)).err, null);
    });

    it('one key\'s record of the wrong type refuses that key alone, LEDGER_RECORD_INVALID (not retryable), until its own probe can charge it; said by its fingerprint', async () => {
      const client = fakeClient();
      const provider = make(client);
      const A = `${KEY}-a`;
      const B = `${KEY}-b`;
      const {meterId} = require('../../lib/key-fingerprint');
      let bad = true;
      client.evalErr = (key) => ((bad && key === meterId(A)) ? Object.assign(new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), {code: 'WRONGTYPE'}) : null);
      assert.strictEqual((await chargeAs(provider, A)).code, 'WRONGTYPE');
      assert.strictEqual((await askAs(provider, A)).code, 'LEDGER_RECORD_INVALID');
      assert.strictEqual(await askAs(provider, B), null, 'another key is not refused');
      assert.strictEqual(provider._chargeMark.marked(), false, 'the provider is not marked');
      clock += 1000;
      assert.strictEqual((await askAs(provider, A)).code, 'LEDGER_RECORD_INVALID');
      assert.strictEqual(client.recordProbes, 1);
      bad = false;
      clock += 1000;
      assert.strictEqual(await askAs(provider, A), null);
      assert.deepStrictEqual(logged.filter(([, l]) => l.includes('the usage record of')), [
        ['E', `the usage record of ${keyFingerprint(A)} can't be read (WRONGTYPE); its charged calls are refused until it is repaired`],
        ['I', `the usage record of ${keyFingerprint(A)} can be read again; its charged calls are served`]]);
      assert.ok(!logged.some(([, l]) => l.includes(A) || l.includes(meterId(A))), JSON.stringify(logged));
    });

    it('one key\'s free-call record that can\'t be read refuses that key\'s calls: LEDGER_RECORD_INVALID, not retryable', async () => {
      const client = fakeClient();
      const provider = make(client);
      const {meterId} = require('../../lib/key-fingerprint');
      client.evalErr = (key) => (key === meterId(KEY) ? Object.assign(new Error('BADRECORD toolPriceRecord is not valid JSON'), {code: 'BADRECORD'}) : null);
      await charge(provider);
      const err = await askAs(provider, KEY);
      assert.strictEqual(err && err.code, 'LEDGER_RECORD_INVALID');
      assert.strictEqual(CODES.LEDGER_RECORD_INVALID.en, 'This key\'s usage record can\'t be read, so its charged calls are refused until the operator repairs it; the runtime\'s log names the record');
      assert.deepStrictEqual([CODES.LEDGER_RECORD_INVALID.kind, CODES.LEDGER_RECORD_INVALID.retryable, CODES.LEDGER_RECORD_INVALID.httpStatus], ['operator', false, 500]);
    });

    // Redis 6.2 and older wrap an error raised in a script: node_redis reads
    // its code as ERR. The code inside it is the one classified and said.
    it('an error raised in a script, as Redis 6.2 wraps it: the code inside is classified -- a record\'s own that key\'s, any other the store\'s, and said by it', async () => {
      const {meterId} = require('../../lib/key-fingerprint');
      const wrapped = (inner) => Object.assign(new Error(`ERR Error running script (call to f_0123456789abcdef0123456789abcdef01234567): @user_script:3: ${inner}`), {code: 'ERR'});
      const {redisCode} = RedisMeteringProvider;
      assert.deepStrictEqual([
        redisCode(wrapped('WRONGTYPE Operation against a key holding the wrong kind of value')),
        redisCode(wrapped('BADRECORD the balance is not a number')),
        redisCode(wrapped('READONLY You can\'t write against a read only replica.')),
        redisCode(Object.assign(new Error('ERR something else'), {code: 'ERR'})),
        redisCode(Object.assign(new Error('NOSCRIPT No matching script'), {code: 'NOSCRIPT'}))],
      ['WRONGTYPE', 'BADRECORD', 'READONLY', 'ERR', 'NOSCRIPT']);
      for (const [inner, record] of [['WRONGTYPE Operation against a key holding the wrong kind of value', true], ['BADRECORD the balance is not a number', true], ['READONLY You can\'t write against a read only replica.', false]]) {
        logged = [];
        const client = fakeClient();
        const provider = make(client);
        client.evalErr = (key) => (key === meterId(KEY) ? wrapped(inner) : null);
        await charge(provider);
        const code = inner.split(' ')[0];
        assert.strictEqual(provider._chargeMark.marked(), !record, `${code}: the store marked`);
        assert.strictEqual((await ask(provider, true)).err.code, record ? 'LEDGER_RECORD_INVALID' : 'LEDGER_UNREACHABLE', code);
        assert.ok(logged.some(([w, l]) => w === 'E' && l.includes(`(${code})`)), `${code}: ${JSON.stringify(logged)}`);
      }
    });

    it('a balance asked while Redis can\'t answer: LEDGER_UNREACHABLE, never node_redis\'s code or message', async () => {
      const client = fakeClient();
      const provider = make(client);
      client.hmgetErr = Object.assign(new Error('HMGET can\'t be processed. The connection is already closed.'), {code: 'NR_CLOSED'});
      const r = await new Promise((resolve) => provider.checkBalance(KEY, (err, b) => resolve({err, b})));
      assert.strictEqual(r.err && r.err.code, 'LEDGER_UNREACHABLE');
      assert.ok(!r.err.message.includes('connection is already closed'), r.err.message);
    });

    it('a job\'s run refused keeps the refusal\'s code ("CODE: text") and retries as the catalogue says', async () => {
      const {chargeableRun} = require('../../lib/job-control-common');
      const refuse = (code) => ({chargeable: (key, cb) => cb(new CountinghouseError(code))});
      const e1 = await chargeableRun(refuse('LEDGER_UNREACHABLE'), KEY).then(() => null, (e) => e);
      assert.ok(e1.message.startsWith('LEDGER_UNREACHABLE: ') && e1.code === 'LEDGER_UNREACHABLE' && e1.retry === true, e1.message);
      const e2 = await chargeableRun(refuse('LEDGER_RECORD_INVALID'), KEY).then(() => null, (e) => e);
      assert.ok(e2.message.startsWith('LEDGER_RECORD_INVALID: ') && e2.retry === false, e2.message);
      assert.strictEqual(await chargeableRun(refuse('LEDGER_UNREACHABLE'), null), undefined, 'a run with no owner key is not billed');
    });
  });

  it('a probe that throws is a probe that failed: the mark is probed again a second later, never left refusing for good', async () => {
    const {chargeMark} = require('../../lib/metering/charge-mark');
    let clock = 1000000;
    let throws = true;
    const {CountinghouseError} = require('../../lib/countinghouse-error');
    const m = chargeMark({now: () => clock, probe: (cb) => { if (throws) throw new Error('closed'); setImmediate(cb, null); },
      refusal: () => new CountinghouseError('LEDGER_UNREACHABLE'), marked: () => 'marked', cleared: () => 'cleared'});
    const check = () => new Promise((resolve) => m.check(resolve));
    m.mark({code: 'NR_CLOSED'});
    clock += 1000;
    const first = await check().catch((e) => e);
    assert.strictEqual(first && first.code, 'LEDGER_UNREACHABLE');
    throws = false;
    clock += 1000;
    assert.strictEqual(await check(), null);
  });

  it('a charge lost mid-call is logged with the key\'s fingerprint, the tool and the amount, never the key or the store\'s message', () => {
    const {chargeLost} = require('../../lib/metering/charge-bound');
    const line = chargeLost('dev:::svc:::act', KEY, 3, Object.assign(new Error(`ERR something ${KEY}`), {code: 'NR_CLOSED'})).message;
    assert.strictEqual(line, `metering: a call's charge was not recorded: ${keyFingerprint(KEY)}, tool dev:::svc:::act, amount 3 (NR_CLOSED)`);
    assert.ok(!line.includes(KEY));
  });

  trees.hooks();
});

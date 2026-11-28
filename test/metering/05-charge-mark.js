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

    it('a charge of 0 while the ledger\'s write is failing (marked) is skipped: no write tried, no lost charge said', async () => {
      const {provider} = open();
      const update = provider.file.update;
      let tries = 0;
      provider.file.update = (key, fn, cb) => { tries++; cb(Object.assign(new Error('no space left on device'), {code: 'ENOSPC'})); };
      try {
        assert.strictEqual((await charge(provider)).err.code, 'ENOSPC');
        assert.strictEqual(provider._chargeMark.marked(), true);
        const free = await new Promise((resolve) => provider.recordCall(KEY, 'tool-a', 0, (err, r) => resolve({err, r})));
        assert.deepStrictEqual(free, {err: null, r: {tool: 'tool-a', charged: 0, balance: null}});
        assert.strictEqual(tries, 1, 'a write was tried for a charge of 0');
      } finally {
        provider.file.update = update;
      }
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

    it('a client never connected past the first-connect wait: the outage marked and said once', async () => {
      const client = fakeClient();
      client.ready = false;
      // (a command sent while not connected fails at once, as node_redis's)
      client.setErr = Object.assign(new Error('SET can\'t be processed. The connection is not yet established'), {code: 'NR_CLOSED'});
      const provider = make(client);
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNREACHABLE');
      assert.deepStrictEqual(logged.filter(([w]) => w === 'E'), []);
      clock += RedisMeteringProvider.FIRST_CONNECT_MS;
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNREACHABLE');
      clock += 1000;
      assert.strictEqual((await ask(provider, true)).err.code, 'LEDGER_UNREACHABLE');
      assert.deepStrictEqual(logged.filter(([w]) => w === 'E'), [['E', 'the usage ledger (Redis) can\'t be reached (NR_CLOSED); charged calls are refused until it answers']]);
    });

    it('a paid charge that lands while a key\'s record probe is out, then the probe fails: the key stays refused, its mark kept', async () => {
      const client = fakeClient();
      const provider = make(client);
      const {meterId} = require('../../lib/key-fingerprint');
      const wrong = () => Object.assign(new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), {code: 'WRONGTYPE'});
      client.evalErr = (key) => (key === meterId(KEY) ? wrong() : null);
      await charge(provider);
      clock += 1000;
      // (the probe fails, answered later; the charge sent meanwhile succeeds
      // first and clears the mark)
      client.evalErr = (key, probe) => ((key === meterId(KEY) && probe) ? wrong() : null);
      const evalNow = client.eval;
      client.eval = (script, n, key, ...rest) => {
        const cb = rest.pop();
        const later = /ARGV\[1\]/.test(script) ? cb : (e, r) => setTimeout(cb, 5, e, r);
        return evalNow(script, n, key, ...rest, later);
      };
      const during = ask(provider, true);
      assert.strictEqual((await charge(provider)).err, null);
      assert.strictEqual((await during).err.code, 'LEDGER_RECORD_INVALID');
      clock += 100;
      const again = await ask(provider, true);
      assert.strictEqual(again.err && again.err.code, 'LEDGER_RECORD_INVALID', 'the failed probe\'s mark was orphaned');
    });

    it('a stale record probe that the store fails, a newer mark in its place: its asker is answered by the probe\'s own error, retryably', async () => {
      const client = fakeClient();
      const provider = make(client);
      const {meterId} = require('../../lib/key-fingerprint');
      const wrong = () => Object.assign(new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), {code: 'WRONGTYPE'});
      const readonly = () => Object.assign(new Error('READONLY You can\'t write against a read only replica.'), {code: 'READONLY'});
      client.evalErr = (key) => (key === meterId(KEY) ? wrong() : null);
      await charge(provider);
      clock += 1000;
      // (the probe answers READONLY, later; meanwhile a paid charge clears the
      // mark and a balance asked finds the record bad again: a newer mark)
      client.evalErr = (key, probe) => ((key === meterId(KEY) && probe) ? readonly() : null);
      const evalNow = client.eval;
      client.eval = (script, n, key, ...rest) => {
        const cb = rest.pop();
        const later = /ARGV\[1\]/.test(script) ? cb : (e, r) => setTimeout(cb, 5, e, r);
        return evalNow(script, n, key, ...rest, later);
      };
      const during = ask(provider, true);
      assert.strictEqual((await charge(provider)).err, null);
      client.hmget = (id, f, cb) => process.nextTick(cb, null, ['abc']);
      await new Promise((resolve) => provider.checkBalance(KEY, resolve));
      assert.strictEqual((await during).err.code, 'LEDGER_UNREACHABLE', 'answered from the stale mark\'s old code');
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
      // (Redis 6.2.24's words, checked against it: an error raised from
      // redis.call is placed once, a shared one -- READONLY, OOM -- twice and
      // dashed; a script's own error_reply comes through as it is)
      const raised = (inner) => Object.assign(new Error(`ERR Error running script (call to f_983e0b70de8b79daabb450b494a411bd40937370): @user_script:1: ${inner}`), {code: 'ERR'});
      const FORMS = {
        WRONGTYPE: raised('WRONGTYPE Operation against a key holding the wrong kind of value'),
        BADRECORD: Object.assign(new Error('BADRECORD the balance is not a number'), {code: 'BADRECORD'}),
        READONLY: raised('@user_script: 1: -READONLY You can\'t write against a read only replica.')};
      const {redisCode} = RedisMeteringProvider;
      assert.deepStrictEqual([redisCode(FORMS.WRONGTYPE), redisCode(FORMS.BADRECORD), redisCode(FORMS.READONLY),
        redisCode(Object.assign(new Error('ERR something else'), {code: 'ERR'})),
        redisCode(Object.assign(new Error('NOSCRIPT No matching script'), {code: 'NOSCRIPT'}))],
      ['WRONGTYPE', 'BADRECORD', 'READONLY', 'ERR', 'NOSCRIPT']);
      for (const [code, record] of [['WRONGTYPE', true], ['BADRECORD', true], ['READONLY', false]]) {
        logged = [];
        const client = fakeClient();
        const provider = make(client);
        client.evalErr = (key) => (key === meterId(KEY) ? FORMS[code] : null);
        await charge(provider);
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

  // A call nothing would charge (--mcpToolCallCost 0, the default) is not
  // billed: never gated, whatever the ledger. ch-local runs so, with
  // --store local and no --meter; a Redis runtime with no cost set too.
  describe('a call nothing would charge is never gated', () => {
    const CdifInterface = require('../../lib/countinghouse-interface');
    const cli = require('../../lib/cli-options');
    const {CountinghouseError} = require('../../lib/countinghouse-error');
    let savedCost;
    before(() => { savedCost = cli.mcpToolCallCost; });
    after(() => { cli.mcpToolCallCost = savedCost; });
    // an interface over a provider whose ledger refuses every charge now
    const over = (provider) => Object.assign(Object.create(CdifInterface.prototype), {meteringProvider: provider});
    const refusing = () => {
      const asked = [];
      return {asked, chargeable: (k, cb) => { asked.push('chargeable'); cb(new CountinghouseError('LEDGER_UNREACHABLE')); },
        rateLimit: (k, cb, opts) => { asked.push(opts != null && opts.billed === true ? 'billed' : 'unbilled'); cb(opts != null && opts.billed === true ? new CountinghouseError('LEDGER_UNREACHABLE') : null, {limited: false}); }};
    };
    const chargeable = (ci) => new Promise((resolve) => ci.chargeable(KEY, resolve));
    const limited = (ci) => new Promise((resolve) => ci.rateLimit(KEY, (err) => resolve(err), {billed: true}));

    it('cost 0: chargeable, and a billed call\'s limit asked as an unbilled one\'s; cost 1: refused as the ledger says', async () => {
      const provider = refusing();
      const ci = over(provider);
      cli.mcpToolCallCost = 0;
      assert.strictEqual(await chargeable(ci), null);
      assert.strictEqual(await limited(ci), null);
      assert.deepStrictEqual(provider.asked, ['unbilled'], 'the ledger was asked for a call nothing charges');
      cli.mcpToolCallCost = 1;
      assert.strictEqual((await chargeable(ci)).code, 'LEDGER_UNREACHABLE');
      assert.strictEqual((await limited(ci)).code, 'LEDGER_UNREACHABLE');
    });

    it('a local --meter ledger corrupt with no copy here: cost 0 served on every path, its charge skipped, the file byte for byte as it was; cost 1 refused LEDGER_CORRUPT on every path', async () => {
      const fs = require('fs');
      const LocalMeteringProvider = require('../../lib/metering/local-provider');
      const dir = trees.mkdtemp('ch-metering-05-');
      const file = path.join(dir, 'metering.json');
      fs.writeFileSync(file, '{"broken": ');
      const provider = new LocalMeteringProvider({meter: true, storePath: dir});
      const ci = over(provider);
      const charge = (cost) => new Promise((resolve) => ci.recordCall(KEY, 'tool-a', cost, (err, r) => resolve({err, r})));
      try {
        const routeGate = () => new Promise((resolve) => require('../../lib/rate-limit-gate').check(ci, KEY, (limited, refusal) => resolve({limited, code: refusal && refusal.code})));
        cli.mcpToolCallCost = 0;
        assert.strictEqual(await limited(ci), null, 'a tools/call');
        assert.strictEqual(await chargeable(ci), null, 'a hop, a job run, a remote call');
        assert.deepStrictEqual(await routeGate(), {limited: false, code: null}, 'a route (tools/list, a balance\'s limit)');
        assert.deepStrictEqual(await charge(0), {err: null, r: {tool: 'tool-a', charged: 0, balance: null}});
        cli.mcpToolCallCost = 1;
        assert.strictEqual((await limited(ci)).code, 'LEDGER_CORRUPT');
        assert.strictEqual((await chargeable(ci)).code, 'LEDGER_CORRUPT');
        assert.deepStrictEqual(await routeGate(), {limited: false, code: null}, 'a route charges nothing: never refused for the ledger');
      } finally {
        provider.close();
      }
      assert.ok(fs.readFileSync(file).equals(Buffer.from('{"broken": ')), 'the file was changed');
    });

    it('ch-local\'s path: --store local without --meter is chargeable at any cost', async () => {
      const LocalMeteringProvider = require('../../lib/metering/local-provider');
      const provider = new LocalMeteringProvider({meter: false});
      const ci = over(provider);
      for (const cost of [0, 1]) {
        cli.mcpToolCallCost = cost;
        assert.strictEqual(await chargeable(ci), null, `cost ${cost}`);
      }
    });
  });

  // Fail closed means one uniform refusal, never a hang: a limiter that
  // throws, now or in its answer, refuses RUNTIME_BUSY, once; the caller's
  // own continuation is never caught and answered twice.
  describe('a limiter that throws refuses RUNTIME_BUSY, never hangs', () => {
    const CdifInterface = require('../../lib/countinghouse-interface');
    const gate = require('../../lib/rate-limit-gate');
    const throwing = () => { throw new Error('the limiter broke'); };
    // a result whose reading throws, as a provider's answer might
    const unreadable = () => ({get limited() { return throwing(); }});
    const over = (ci) => Object.assign(Object.create(CdifInterface.prototype), {meteringProvider: null, rateLimiter: null}, ci);
    // every answer the gate gives: from its first (bounded: 5 s), then two
    // more turns of the event loop for a second -- the limiters here answer
    // at once or on the next turn
    const answers = (run) => new Promise((resolve) => {
      const got = [];
      const turns = () => setImmediate(() => setImmediate(() => resolve(got)));
      const bound = setTimeout(() => resolve(got), 5000);
      run((x) => { got.push(x); if (got.length === 1) { clearTimeout(bound); turns(); } });
    });
    const session = () => ({appKey: KEY, billed: false});

    for (const [what, rateLimit] of [
      ['throws when asked', throwing],
      ['answers a result that throws when read', (k, cb) => setImmediate(() => cb(null, unreadable()))]]) {
      it(`a key's limiter that ${what}: keyGate and callGate answer RUNTIME_BUSY once; the route gate refuses so`, async () => {
        const ci = over({rateLimit});
        const viaKey = await answers((cb) => ci.keyGate(session(), cb));
        assert.deepStrictEqual(viaKey.map((r) => r && r.code), ['RUNTIME_BUSY']);
        const viaCall = await answers((cb) => ci.callGate(session(), cb));
        assert.deepStrictEqual(viaCall.map((r) => r && r.code), ['RUNTIME_BUSY']);
        const viaRoute = await answers((cb) => gate.check(ci, KEY, (limited, refusal) => cb({limited, code: refusal && refusal.code})));
        assert.deepStrictEqual(viaRoute, [{limited: true, code: 'RUNTIME_BUSY'}]);
      });
    }

    it('the server-wide limiter that throws when asked: callGate answers RUNTIME_BUSY once', async () => {
      const ci = over({rateLimiter: throwing, rateLimit: (k, cb) => cb(null, {limited: false})});
      const got = await answers((cb) => ci.callGate(session(), cb));
      assert.deepStrictEqual(got.map((r) => r && r.code), ['RUNTIME_BUSY']);
    });

    // (a limiter that answers at once: the caller's continuation runs inside
    // the gate's own call, so its throw meets the gate's catch)
    it('a continuation that throws is its own: with a limiter that answers at once, the caller\'s error goes on up, the gate answers once', () => {
      const atOnce = over({rateLimit: (k, cb) => cb(null, {limited: false}), rateLimiter: (k, cb) => cb(null, 0)});
      const own = new Error('the caller\'s own');
      for (const [name, run] of [
        ['keyGate', (cb) => atOnce.keyGate(session(), cb)],
        ['callGate', (cb) => atOnce.callGate(session(), cb)],
        ['the route gate', (cb) => gate.check(atOnce, KEY, (limited) => cb(limited ? new Error('limited') : null))]]) {
        let calls = 0;
        assert.throws(() => run(() => { calls++; throw own; }), (e) => e === own, name);
        assert.strictEqual(calls, 1, `${name}: answered ${calls} times`);
      }
    });

    it('a limiter that throws null when asked: RUNTIME_BUSY once, never taken for the caller\'s own throw', async () => {
      const nul = over({rateLimit: () => { throw null; }});
      const got = await answers((cb) => nul.keyGate(session(), cb));
      assert.deepStrictEqual(got.map((r) => r && r.code), ['RUNTIME_BUSY']);
    });

    it('a limiter that answers twice is decided once: its second answer is not read, nothing more said', () => {
      const lines = [];
      const realE = logger.E;
      logger.E = (x) => lines.push(String(x && x.message != null ? x.message : x));
      try {
        const twice = over({rateLimit: (k, cb) => { cb(null, {limited: false}); cb(null, unreadable()); }});
        const got = [];
        twice.keyGate(session(), (r) => got.push(r));
        assert.deepStrictEqual(got, [null]);
        assert.deepStrictEqual(lines, [], 'a second answer was read');
      } finally {
        logger.E = realE;
      }
    });

    it('a limiter that throws after it has answered: the answer stands, nothing answered twice, nothing thrown at the caller', () => {
      const late = over({rateLimit: (k, cb) => { cb(null, {limited: false}); throw new Error('its own bookkeeping'); }});
      const got = [];
      late.keyGate(session(), (r) => got.push(r));
      gate.check(late, KEY, (limited, refusal) => got.push({limited, refusal}));
      assert.deepStrictEqual(got, [null, {limited: false, refusal: null}]);
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

  it('with no clock given, the mark keeps time by a monotonic clock: the wall clock stepped back an hour still probes a second later', async () => {
    const {chargeMark} = require('../../lib/metering/charge-mark');
    const {CountinghouseError} = require('../../lib/countinghouse-error');
    const realNow = Date.now;
    const realPerf = performance.now;
    let mono = 5000000;
    let wall = realNow();
    Date.now = () => wall;
    performance.now = () => mono;
    try {
      let probes = 0;
      const m = chargeMark({probe: (cb) => { probes++; setImmediate(cb, null); },
        refusal: () => new CountinghouseError('LEDGER_UNREACHABLE'), marked: () => 'marked', cleared: () => 'cleared'});
      m.mark({code: 'NR_CLOSED'});
      wall -= 3600000;
      mono += 1000;
      assert.strictEqual(await new Promise((resolve) => m.check(resolve)), null, 'refused: the mark kept the wall clock');
      assert.strictEqual(probes, 1);
    } finally {
      Date.now = realNow;
      performance.now = realPerf;
    }
  });

  it('a charge lost mid-call is logged with the key\'s fingerprint, the tool and the amount, never the key or the store\'s message', () => {
    const {chargeLost} = require('../../lib/metering/charge-bound');
    const line = chargeLost('dev:::svc:::act', KEY, 3, Object.assign(new Error(`ERR something ${KEY}`), {code: 'NR_CLOSED'})).message;
    assert.strictEqual(line, `metering: a call's charge was not recorded: ${keyFingerprint(KEY)}, tool dev:::svc:::act, amount 3 (NR_CLOSED)`);
    assert.ok(!line.includes(KEY));
  });

  trees.hooks();
});

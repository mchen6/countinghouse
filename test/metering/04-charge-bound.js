'use strict';
// B-hopcharge: lib/metering/charge-bound.js, the one bound on a hop's wait
// for its charge (a peer hop, a routed device hop, a remote call). The
// charge is issued once; the caller hears once -- the charge's answer in
// time, or billingPending at the bound; a late outcome is logged, a failure
// by the key's meterId, never the key.
const assert = require('assert');
const {boundedCharge, lateOutcome, METER_PENDING_MS} = require('../../lib/metering/charge-bound');
const {meterId} = require('../../lib/key-fingerprint');
const LOG = require('../../lib/logger');

describe('metering 04: a hop\'s charge, waited for at most METER_PENDING_MS (B-hopcharge)', () => {
  const KEY = `bound-${require('crypto').randomBytes(6).toString('hex')}`;
  const logged = [];
  let saved = null;
  before(() => {
    saved = {E: LOG.E, I: LOG.I};
    LOG.E = (e) => logged.push(['E', String(e && e.message ? e.message : e)]);
    LOG.I = (line) => logged.push(['I', String(line)]);
  });
  after(() => { Object.assign(LOG, saved); require('../../lib/metering/charge-bound').resetForTests(); });
  // a bounded wait on something observable (never a fixed sleep)
  const until = async (check, ms = 5000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('not seen in time');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  beforeEach(() => { logged.length = 0; });

  it('is the peer path\'s 500 ms', () => {
    assert.strictEqual(METER_PENDING_MS, 500);
  });

  it('a charge in time: its own answer, once, with the options passed as given', async () => {
    const seen = [];
    const ci = {recordCall: (key, tool, cost, cb, opts) => { seen.push([key, tool, cost, opts]); cb(null, {charged: cost}); cb(null, {charged: 99}); }};
    const answers = [];
    boundedCharge(ci, KEY, 't', 1, (...a) => answers.push(a), {opts: {session: 's1'}, boundMs: 50});
    await until(() => answers.length > 0);
    await new Promise((r) => setTimeout(r, 80));   // (past the bound: still the one answer)
    assert.deepStrictEqual(seen, [[KEY, 't', 1, {session: 's1'}]]);
    assert.deepStrictEqual(answers, [[null, {charged: 1}, false]], 'once, never at the bound too');
  });

  it('a charge past the bound: billingPending at the bound, never charged again, its landing logged', async () => {
    let land = null;
    let calls = 0;
    const ci = {recordCall: (key, tool, cost, cb) => { calls++; land = cb; }};
    const answers = [];
    boundedCharge(ci, KEY, 'svc_t', 1, (...a) => answers.push(a), {what: 'hop', boundMs: 30});
    await until(() => answers.length > 0);
    assert.deepStrictEqual(answers, [[null, null, true]]);
    land(null, {charged: 1});
    assert.deepStrictEqual([calls, answers.length], [1, 1]);
    assert.ok(logged.some(([l, line]) => l === 'I' && line === 'hop svc_t: the pending billing landed (charged 1)'), JSON.stringify(logged));
  });

  it('a charge that fails past the bound: logged at error by meterId, never the key; the caller had its answer', async () => {
    let land = null;
    const ci = {recordCall: (key, tool, cost, cb) => { land = cb; }};
    const answers = [];
    boundedCharge(ci, KEY, 'svc_t', 1, (...a) => answers.push(a), {what: 'hop', boundMs: 30});
    await until(() => answers.length > 0);
    land(new Error('the store lock stayed busy for 10000 ms'));
    const errors = logged.filter(([l]) => l === 'E').map(([, line]) => line);
    assert.deepStrictEqual(answers, [[null, null, true]]);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes(`meter ${meterId(KEY)}`) && errors[0].includes('goes unbilled') && !errors[0].includes(KEY), errors[0]);
  });

  it('a charge that fails in time: its error, once', async () => {
    const ci = {recordCall: (key, tool, cost, cb) => cb(new Error('redis down'))};
    const answers = [];
    boundedCharge(ci, KEY, 't', 1, (...a) => answers.push(a), {boundMs: 30});
    await until(() => answers.length > 0);
    assert.strictEqual(answers.length, 1);
    assert.deepStrictEqual([answers[0][0].message, answers[0][1], answers[0][2]], ['redis down', null, false]);
  });

  it('a recordCall that throws: answered as its error, once, not at the bound', async () => {
    const ci = {recordCall: () => { throw new Error('boom'); }};
    const answers = [];
    boundedCharge(ci, KEY, 't', 1, (...a) => answers.push(a), {boundMs: 30});
    await until(() => answers.length > 0);
    assert.deepStrictEqual(answers.map((a) => [a[0] && a[0].message, a[2]]), [['boom', false]]);
  });

  // (the reviewer's ruling on #496) at most MAX_PENDING_PER_KEY charges of
  // one key pending past the bound; any more wait for their charge, as
  // before; a slot is given back on every outcome
  describe('the per-key allowance of pending charges', () => {
    const {MAX_PENDING_PER_KEY, pendingForTests} = require('../../lib/metering/charge-bound');
    const held = () => {
      const lands = [];
      return {ci: {recordCall: (key, tool, cost, cb) => { lands.push(cb); }}, lands};
    };

    it(`past ${MAX_PENDING_PER_KEY} pending for one key, the next waits for its own charge; another key is not held back`, async () => {
      const K = `${KEY}-cap`;
      const {ci, lands} = held();
      const answers = [];
      for (let i = 0; i <= MAX_PENDING_PER_KEY; i++) boundedCharge(ci, K, `t${i}`, 1, (...a) => answers.push([i, ...a]), {boundMs: 20});
      const other = held();
      const otherAnswers = [];
      boundedCharge(other.ci, `${KEY}-other`, 'o', 1, (...a) => otherAnswers.push(a), {boundMs: 20});
      await until(() => answers.length === MAX_PENDING_PER_KEY && otherAnswers.length === 1 && logged.some(([, line]) => line.includes(`t${MAX_PENDING_PER_KEY}`) && /waiting for it/.test(line)));
      assert.deepStrictEqual(answers.map(([i, , , p]) => [i, p]), Array.from({length: MAX_PENDING_PER_KEY}, (_, i) => [i, true]), 'the allowance, pending; the next not answered');
      assert.strictEqual(pendingForTests(K), MAX_PENDING_PER_KEY);
      assert.deepStrictEqual(otherAnswers.map((a) => a[2]), [true], 'another key has its own allowance');
      // the one that waited answers with its own charge
      lands[MAX_PENDING_PER_KEY](null, {charged: 1});
      assert.deepStrictEqual(answers[MAX_PENDING_PER_KEY], [MAX_PENDING_PER_KEY, null, {charged: 1}, false]);
      // every pending one lands: every slot given back
      for (let i = 0; i < MAX_PENDING_PER_KEY; i++) lands[i](null, {charged: 1});
      other.lands[0](null, {charged: 1});
      assert.deepStrictEqual([pendingForTests(K), pendingForTests(`${KEY}-other`)], [0, 0]);
      assert.strictEqual(lands.length, MAX_PENDING_PER_KEY + 1, 'each charged once');
    });

    it('a slot is given back when a pending charge rejects, and when a provider throws none is taken', async () => {
      const K = `${KEY}-reject`;
      const {ci, lands} = held();
      for (let i = 0; i < MAX_PENDING_PER_KEY; i++) boundedCharge(ci, K, 'r', 1, () => undefined, {boundMs: 20});
      await until(() => pendingForTests(K) === MAX_PENDING_PER_KEY);
      for (const land of lands) land(new Error('the store lock stayed busy for 10000 ms'));
      assert.strictEqual(pendingForTests(K), 0, 'no slot leaked by a rejected charge');
      const thrown = [];
      boundedCharge({recordCall: () => { throw new Error('provider threw'); }}, K, 'thrown', 1, (...a) => thrown.push(a), {boundMs: 20});
      await until(() => thrown.length > 0);
      await new Promise((r) => setTimeout(r, 40));   // (past its bound: still none taken)
      assert.strictEqual(pendingForTests(K), 0, 'a thrown provider takes none');
      // and the allowance is whole again
      const again = held();
      const answers = [];
      for (let i = 0; i < MAX_PENDING_PER_KEY; i++) boundedCharge(again.ci, K, 'again', 1, (...a) => answers.push(a[2]), {boundMs: 20});
      await until(() => answers.length === MAX_PENDING_PER_KEY);
      assert.deepStrictEqual(answers, new Array(MAX_PENDING_PER_KEY).fill(true));
      for (const land of again.lands) land(null, {charged: 1});
      assert.strictEqual(pendingForTests(K), 0);
    });

    it('a charge still unanswered at the ceiling gives its slot back, said at error; its outcome is still logged if it comes', async () => {
      const K = `${KEY}-ceiling`;
      const {ci, lands} = held();
      boundedCharge(ci, K, 'stuck', 1, () => undefined, {boundMs: 20, ceilingMs: 60});
      await until(() => pendingForTests(K) === 1);
      await until(() => pendingForTests(K) === 0);   // (given back at the ceiling)
      assert.ok(logged.some(([l, line]) => l === 'E' && line.includes('stuck') && line.includes('its slot is given back') && !line.includes(K)), JSON.stringify(logged));
      lands[0](null, {charged: 1});
      assert.strictEqual(pendingForTests(K), 0, 'never given back twice');
      assert.ok(logged.some(([l, line]) => l === 'I' && line === 'hop stuck: the pending billing landed (charged 1)'));
    });

    // (the medium on the cap, 1 and 2) a hop past the allowance waits at
    // most until the ceiling, or its caller's deadline if sooner: then it is
    // answered as pending, taking no slot, its outcome logged when it comes
    it('a hop past the allowance waits at most until its caller\'s deadline, then is answered pending, taking no slot', async () => {
      const K = `${KEY}-deadline`;
      const {ci, lands} = held();
      const answers = [];
      for (let i = 0; i < MAX_PENDING_PER_KEY; i++) boundedCharge(ci, K, `d${i}`, 1, () => undefined, {boundMs: 20});
      await until(() => pendingForTests(K) === MAX_PENDING_PER_KEY);
      boundedCharge(ci, K, 'late', 1, (...a) => answers.push(a), {boundMs: 20, deadline: Date.now() + 150});
      await until(() => answers.length === 1, 3000);
      assert.deepStrictEqual(answers, [[null, null, true]]);
      assert.strictEqual(pendingForTests(K), MAX_PENDING_PER_KEY, 'it took no slot');
      assert.ok(logged.some(([l, line]) => l === 'E' && line.includes('late') && line.includes('answered as pending') && !line.includes(K)), JSON.stringify(logged));
      lands[MAX_PENDING_PER_KEY](new Error('busy'));
      assert.ok(logged.some(([l, line]) => l === 'E' && line.includes('late') && line.includes('goes unbilled')));
      for (let i = 0; i < MAX_PENDING_PER_KEY; i++) lands[i](null, {charged: 1});
      assert.strictEqual(pendingForTests(K), 0);
      // and one past the allowance whose charge answers in time: its own
      // answer, its wait's timer cleared
      for (let i = 0; i < MAX_PENDING_PER_KEY; i++) boundedCharge(ci, K, `e${i}`, 1, () => undefined, {boundMs: 20});
      await until(() => pendingForTests(K) === MAX_PENDING_PER_KEY);
      const own = [];
      boundedCharge(ci, K, 'in-time', 1, (...a) => own.push(a), {boundMs: 20, deadline: Date.now() + 100});
      await until(() => logged.some(([, line]) => line.includes('in-time') && /waiting for it/.test(line)));
      lands[lands.length - 1](null, {charged: 1});
      await new Promise((r) => setTimeout(r, 150));   // (past its deadline: still the one answer)
      assert.deepStrictEqual(own, [[null, {charged: 1}, false]]);
      for (const land of lands.slice(-1 - MAX_PENDING_PER_KEY, -1)) land(null, {charged: 1});
      assert.strictEqual(pendingForTests(K), 0);
    });
  });

  it('lateOutcome names the key only by its meterId', () => {
    lateOutcome('peer hop', 'x', KEY, new Error(`detail`), null);
    const line = logged.find(([l]) => l === 'E')[1];
    assert.ok(line.startsWith('peer hop x: the billing failed for meter ') && line.includes('it was pending') && !line.includes(KEY), line);
  });

  // (the medium on B-hopcharge, 3 and 4) the code kept; a message that
  // repeats the key (a store command's arguments) carries its meterId instead
  it('a charge\'s error keeps its code, and a message naming the key names its meterId instead', () => {
    const err = Object.assign(new Error(`ERR in EVAL with args ${KEY} 1`), {code: 'ERR_STORE'});
    const {chargeError} = require('../../lib/metering/charge-bound');
    const out = chargeError('hop', 't', KEY, err);
    assert.strictEqual(out.code, 'ERR_STORE');
    assert.ok(!out.message.includes(KEY) && out.message.includes(`[meter ${meterId(KEY)}]`), out.message);
  });

  // (the medium on B-hopcharge, 1 and 6)
  it('a throw from the answer under a provider that answers at once goes on; a second late answer is heard once', async () => {
    const ci = {recordCall: (key, tool, cost, cb) => cb(null, {charged: 1})};
    assert.throws(() => boundedCharge(ci, KEY, 't', 1, () => { throw new Error('the caller\'s own'); }, {boundMs: 30}), /the caller's own/);
    let land = null;
    const heard = [];
    boundedCharge({recordCall: (key, tool, cost, cb) => { land = cb; }}, KEY, 'twice', 1, (...a) => heard.push(a), {boundMs: 20});
    await until(() => heard.length > 0);
    land(new Error('first'));
    land(null, {charged: 1});
    assert.strictEqual(logged.filter(([, line]) => line.includes('twice')).length, 2, JSON.stringify(logged));
  });

  // (the medium on the cap, 4) a provider that answers, then throws: its
  // own fault, logged; never taken for the caller's throw
  it('a provider that throws after it answered is logged, and the caller\'s answer stands', () => {
    const answers = [];
    assert.doesNotThrow(() => boundedCharge({recordCall: (key, tool, cost, cb) => { cb(null, {charged: 1}); throw new Error('bookkeeping'); }},
      KEY, 'after', 1, (...a) => answers.push(a), {boundMs: 30}));
    assert.deepStrictEqual(answers, [[null, {charged: 1}, false]]);
    assert.ok(logged.some(([l, line]) => l === 'E' && line.includes('after') && line.includes('the provider threw after it answered')), JSON.stringify(logged));
  });
});

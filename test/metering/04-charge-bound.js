'use strict';
// B-hopcharge: lib/metering/charge-bound.js, the one bound on a hop's wait
// for its charge (a peer hop, a routed device hop, a remote call). The
// charge is issued once; the caller hears once -- the charge's answer in
// time, or billingPending -- never later than DEADLINE_MARGIN_MS before its
// caller's deadline; at most MAX_PENDING_PER_KEY of one key's charges pending,
// each slot held until its charge answers; a late outcome logged, a failure
// by the key's meterId, never the key. Every case runs on an injected clock:
// nothing here depends on wall-clock time.
const assert = require('assert');
const cb = require('../../lib/metering/charge-bound');
const {boundedCharge, lateOutcome, chargeError, METER_PENDING_MS, MAX_PENDING_PER_KEY, DEADLINE_MARGIN_MS, PENDING_CEILING_MS, pendingForTests} = cb;
const {meterId, keyFingerprint} = require('../../lib/key-fingerprint');
const LOG = require('../../lib/logger');

// a clock the test moves: timers fire, in order, as it advances
function fakeClock(start = 1000000) {
  let t = start;
  const timers = [];
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { const h = {at: t + Math.max(0, ms), fn, live: true}; timers.push(h); return h; },
    clearTimeout: (h) => { if (h != null) h.live = false; },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((h) => h.live && h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (due == null) break;
        due.live = false;
        t = due.at;
        due.fn();
      }
      t = end;
    }
  };
  return clock;
}
// a provider whose charges answer when the test says
const held = () => {
  const lands = [];
  return {ci: {recordCall: (key, tool, cost, done) => { lands.push(done); }}, lands};
};

describe('metering 04: a hop\'s charge, waited for at most METER_PENDING_MS (B-hopcharge)', () => {
  const KEY = `bound-${require('crypto').randomBytes(6).toString('hex')}`;
  const logged = [];
  let saved = null;
  before(() => {
    saved = {E: LOG.E, I: LOG.I};
    LOG.E = (e) => logged.push(['E', String(e && e.message ? e.message : e)]);
    LOG.I = (line) => logged.push(['I', String(line)]);
  });
  after(() => { Object.assign(LOG, saved); cb.resetForTests(); });
  beforeEach(() => { logged.length = 0; });

  it('is the peer path\'s 500 ms, a quarter second\'s margin, and an allowance of 4', () => {
    assert.deepStrictEqual([METER_PENDING_MS, DEADLINE_MARGIN_MS, MAX_PENDING_PER_KEY, PENDING_CEILING_MS], [500, 250, 4, 60000]);
  });

  it('a charge in time: its own answer, once, with the options passed as given', () => {
    const clock = fakeClock();
    const seen = [];
    const ci = {recordCall: (key, tool, cost, done, opts) => { seen.push([key, tool, cost, opts]); done(null, {charged: cost}); done(null, {charged: 99}); }};
    const answers = [];
    boundedCharge(ci, KEY, 't', 1, (...a) => answers.push(a), {opts: {session: 's1'}, clock});
    clock.advance(10 * METER_PENDING_MS);
    assert.deepStrictEqual(seen, [[KEY, 't', 1, {session: 's1'}]]);
    assert.deepStrictEqual(answers, [[null, {charged: 1}, false]], 'once, never at the bound too');
  });

  it('a charge past the bound: billingPending at the bound, never charged again, its landing logged', () => {
    const clock = fakeClock();
    const {ci, lands} = held();
    const answers = [];
    boundedCharge(ci, KEY, 'svc_t', 1, (...a) => answers.push([clock.now(), ...a]), {what: 'hop', clock});
    const t0 = clock.now();
    clock.advance(METER_PENDING_MS - 1);
    assert.deepStrictEqual(answers, [], 'not before the bound');
    clock.advance(1);
    assert.deepStrictEqual(answers, [[t0 + METER_PENDING_MS, null, null, true]]);
    lands[0](null, {charged: 1});
    assert.deepStrictEqual([lands.length, answers.length], [1, 1]);
    assert.ok(logged.some(([l, line]) => l === 'I' && line === 'hop svc_t: the pending billing landed (charged 1)'), JSON.stringify(logged));
  });

  it('a charge that fails past the bound: logged at error by the key\'s fingerprint, never the key; the caller had its answer', () => {
    const clock = fakeClock();
    const {ci, lands} = held();
    const answers = [];
    boundedCharge(ci, KEY, 'svc_t', 1, (...a) => answers.push(a), {what: 'hop', clock});
    clock.advance(METER_PENDING_MS);
    lands[0](new Error('the store lock stayed busy for 10000 ms'));
    const errors = logged.filter(([l]) => l === 'E').map(([, line]) => line);
    assert.deepStrictEqual(answers, [[null, null, true]]);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes(keyFingerprint(KEY)) && errors[0].includes('goes unbilled') && !errors[0].includes(KEY), errors[0]);
  });

  it('a charge that fails in time: its error, once; a recordCall that throws: its error, once', () => {
    const clock = fakeClock();
    const answers = [];
    boundedCharge({recordCall: (key, tool, cost, done) => done(new Error('redis down'))}, KEY, 't', 1, (...a) => answers.push(a), {clock});
    boundedCharge({recordCall: () => { throw new Error('boom'); }}, KEY, 't', 1, (...a) => answers.push(a), {clock});
    clock.advance(10 * METER_PENDING_MS);
    assert.deepStrictEqual(answers.map((a) => [a[0].message, a[1], a[2]]), [['redis down', null, false], ['boom', null, false]]);
  });

  it('a charge\'s error keeps its code, and its line names the key\'s fingerprint and the code, never the key or the store\'s message', () => {
    const out = chargeError('hop', 't', KEY, Object.assign(new Error(`ERR in EVAL with args ${KEY} 1`), {code: 'ERR_STORE'}));
    assert.strictEqual(out.code, 'ERR_STORE');
    assert.ok(!out.message.includes(KEY) && out.message.includes(keyFingerprint(KEY)) && out.message.includes('(ERR_STORE)') && !out.message.includes('EVAL') && !out.message.includes(meterId(KEY)), out.message);
    lateOutcome('peer hop', 'x', KEY, new Error('detail'), null);
    const line = logged.find(([l]) => l === 'E')[1];
    assert.ok(line.startsWith(`peer hop x: the billing failed for ${keyFingerprint(KEY)}`) && line.includes('it was pending') && !line.includes(KEY), line);
  });

  it('a throw from the caller\'s own answer goes on; a provider\'s throw after it answered is logged; a second late answer is heard once', () => {
    const clock = fakeClock();
    assert.throws(() => boundedCharge({recordCall: (key, tool, cost, done) => done(null, {charged: 1})}, KEY, 't', 1, () => { throw new Error('the caller\'s own'); }, {clock}), /the caller's own/);
    const answers = [];
    assert.doesNotThrow(() => boundedCharge({recordCall: (key, tool, cost, done) => { done(null, {charged: 1}); throw new Error('bookkeeping'); }},
      KEY, 'after', 1, (...a) => answers.push(a), {clock}));
    assert.deepStrictEqual(answers, [[null, {charged: 1}, false]]);
    assert.ok(logged.some(([l, line]) => l === 'E' && line.includes('after') && line.includes('the provider threw after it answered')), JSON.stringify(logged));
    const {ci, lands} = held();
    boundedCharge(ci, KEY, 'twice', 1, () => undefined, {clock});
    clock.advance(METER_PENDING_MS);
    lands[0](new Error('first'));
    lands[0](null, {charged: 1});
    assert.strictEqual(logged.filter(([, line]) => line.includes('twice')).length, 2, 'the pending line and one outcome');
  });

  // (the reviewer's high on #496, 1) never answered later than the margin
  // before its caller's deadline, so it is never answered after the caller's
  // own timer failed it: a hop told it failed is never billed
  describe('the caller\'s deadline', () => {
    it('a deadline nearer than the bound: answered pending the margin before it', () => {
      const clock = fakeClock();
      const {ci} = held();
      const answers = [];
      const deadline = clock.now() + 300;
      boundedCharge(ci, `${KEY}-near`, 'near', 1, (...a) => answers.push([clock.now(), a[2]]), {clock, deadline});
      clock.advance(300);
      assert.deepStrictEqual(answers, [[deadline - DEADLINE_MARGIN_MS, true]]);
    });

    // (the reviewer's round 2, b) a getter, read again while it waits: a
    // tightened deadline (Session.rearm) is kept, before the bound and past
    // the allowance alike
    it('a deadline tightened while it waits: answered the margin before the new one', () => {
      const clock = fakeClock();
      const {ci} = held();
      let deadline = clock.now() + 30000;
      const answers = [];
      boundedCharge(ci, `${KEY}-tight`, 'tight', 1, (...a) => answers.push([clock.now(), a[2]]), {clock, deadline: () => deadline});
      const {RECHECK_MS} = cb;
      // answered within RECHECK_MS of the new latest instant: still at least
      // DEADLINE_MARGIN_MS - RECHECK_MS before the tightened deadline
      const inTime = (at, d) => at >= d - DEADLINE_MARGIN_MS && at <= d - DEADLINE_MARGIN_MS + RECHECK_MS;
      clock.advance(100);
      deadline = clock.now() + 300;   // tightened before the bound
      clock.advance(1000);
      assert.strictEqual(answers.length, 1);
      assert.ok(answers[0][1] === true && inTime(answers[0][0], deadline), JSON.stringify({answers, deadline}));
      // past the allowance: tightened during its wait
      const K = `${KEY}-tight-capped`;
      const cap = held();
      for (let i = 0; i < MAX_PENDING_PER_KEY; i++) boundedCharge(cap.ci, K, `p${i}`, 1, () => undefined, {clock});
      clock.advance(METER_PENDING_MS);
      let d2 = clock.now() + 30000;
      const waited = [];
      boundedCharge(cap.ci, K, 'w', 1, (...a) => waited.push([clock.now(), a[2]]), {clock, deadline: () => d2});
      clock.advance(METER_PENDING_MS + 1000);
      assert.deepStrictEqual(waited, [], 'waiting for its own charge');
      d2 = clock.now() + 1000;        // tightened during the wait
      clock.advance(2000);
      assert.strictEqual(waited.length, 1);
      assert.ok(waited[0][1] === true && inTime(waited[0][0], d2), JSON.stringify({waited, d2}));
      for (const land of cap.lands) land(null, {charged: 1});
    });

    it('a deadline already within the margin: answered pending at once', () => {
      const clock = fakeClock();
      const {ci} = held();
      const answers = [];
      boundedCharge(ci, `${KEY}-past`, 'past', 1, (...a) => answers.push([clock.now(), a[2]]), {clock, deadline: clock.now() + 100});
      const t0 = clock.now();
      clock.advance(0);
      assert.deepStrictEqual(answers, [[t0, true]]);
    });
  });

  // (the reviewer's ruling on #496) at most MAX_PENDING_PER_KEY charges of
  // one key pending past the bound; any more wait for their charge, as
  // before; a slot is held until its charge answers
  describe('the per-key allowance of pending charges', () => {
    it(`past ${MAX_PENDING_PER_KEY} pending for one key, the next waits for its own charge; another key is not held back`, () => {
      const clock = fakeClock();
      const K = `${KEY}-cap`;
      const {ci, lands} = held();
      const answers = [];
      for (let i = 0; i <= MAX_PENDING_PER_KEY; i++) boundedCharge(ci, K, `t${i}`, 1, (...a) => answers.push([i, ...a]), {clock, deadline: clock.now() + 30000});
      const other = held();
      const otherAnswers = [];
      boundedCharge(other.ci, `${KEY}-other`, 'o', 1, (...a) => otherAnswers.push(a), {clock});
      clock.advance(METER_PENDING_MS);
      assert.deepStrictEqual(answers.map(([i, , , p]) => [i, p]), Array.from({length: MAX_PENDING_PER_KEY}, (_, i) => [i, true]), 'the allowance, pending; the next waiting');
      assert.strictEqual(pendingForTests(K), MAX_PENDING_PER_KEY);
      assert.deepStrictEqual(otherAnswers.map((a) => a[2]), [true], 'another key has its own allowance');
      // the one that waits answers with its own charge
      lands[MAX_PENDING_PER_KEY](null, {charged: 1});
      assert.deepStrictEqual(answers[MAX_PENDING_PER_KEY], [MAX_PENDING_PER_KEY, null, {charged: 1}, false]);
      for (let i = 0; i < MAX_PENDING_PER_KEY; i++) lands[i](null, {charged: 1});
      other.lands[0](null, {charged: 1});
      assert.deepStrictEqual([pendingForTests(K), pendingForTests(`${KEY}-other`)], [0, 0]);
      assert.strictEqual(lands.length, MAX_PENDING_PER_KEY + 1, 'each charged once');
    });

    it('a hop past the allowance waits until its caller\'s deadline less the margin, then is answered pending (the store-down rule), taking no slot', () => {
      const clock = fakeClock();
      const K = `${KEY}-deadline`;
      const {ci, lands} = held();
      for (let i = 0; i < MAX_PENDING_PER_KEY; i++) boundedCharge(ci, K, `d${i}`, 1, () => undefined, {clock});
      clock.advance(METER_PENDING_MS);
      assert.strictEqual(pendingForTests(K), MAX_PENDING_PER_KEY);
      const answers = [];
      const deadline = clock.now() + 5000;
      boundedCharge(ci, K, 'late', 1, (...a) => answers.push([clock.now(), ...a]), {clock, deadline});
      clock.advance(METER_PENDING_MS);
      assert.deepStrictEqual(answers, [], 'waiting for its own charge');
      clock.advance(5000);
      assert.deepStrictEqual(answers, [[deadline - DEADLINE_MARGIN_MS, null, null, true]]);
      assert.strictEqual(pendingForTests(K), MAX_PENDING_PER_KEY, 'it took no slot');
      assert.ok(logged.some(([l, line]) => l === 'E' && line.includes('late') && line.includes('the store-down rule') && !line.includes(K)), JSON.stringify(logged));
      lands[MAX_PENDING_PER_KEY](new Error('busy'));
      assert.ok(logged.some(([l, line]) => l === 'E' && line.includes('late') && line.includes('goes unbilled')));
      for (let i = 0; i < MAX_PENDING_PER_KEY; i++) lands[i](null, {charged: 1});
      assert.strictEqual(pendingForTests(K), 0);
    });

    it('a slot is given back when a pending charge rejects; a provider that throws takes none', () => {
      const clock = fakeClock();
      const K = `${KEY}-reject`;
      const {ci, lands} = held();
      for (let i = 0; i < MAX_PENDING_PER_KEY; i++) boundedCharge(ci, K, 'r', 1, () => undefined, {clock});
      clock.advance(METER_PENDING_MS);
      assert.strictEqual(pendingForTests(K), MAX_PENDING_PER_KEY);
      for (const land of lands) land(new Error('the store lock stayed busy for 10000 ms'));
      assert.strictEqual(pendingForTests(K), 0, 'no slot leaked by a rejected charge');
      boundedCharge({recordCall: () => { throw new Error('provider threw'); }}, K, 'thrown', 1, () => undefined, {clock});
      clock.advance(10 * METER_PENDING_MS);
      assert.strictEqual(pendingForTests(K), 0, 'a thrown provider takes none');
    });

    // (the reviewer's high on #496, 2) the ceiling says a charge is still
    // pending; it never frees its slot: a store that never answers keeps
    // the allowance spent, and the hops past it answer under the store-down
    // rule at their deadline
    it('a charge still unanswered at the ceiling is said at error and keeps its slot until it answers', () => {
      const clock = fakeClock();
      const K = `${KEY}-ceiling`;
      const {ci, lands} = held();
      boundedCharge(ci, K, 'stuck', 1, () => undefined, {clock});
      clock.advance(METER_PENDING_MS);
      assert.strictEqual(pendingForTests(K), 1);
      clock.advance(PENDING_CEILING_MS);
      assert.strictEqual(pendingForTests(K), 1, 'still held at the ceiling');
      assert.ok(logged.some(([l, line]) => l === 'E' && line.includes('stuck') && line.includes('still pending') && !line.includes(K)), JSON.stringify(logged));
      lands[0](null, {charged: 1});
      assert.strictEqual(pendingForTests(K), 0, 'given back when it answers');
      assert.ok(logged.some(([l, line]) => l === 'I' && line === 'hop stuck: the pending billing landed (charged 1)'));
    });

    // (the reviewer's high on #496, 3)
    it('at exit, the charges still pending are said at error, by the key\'s fingerprint (never its meter id)', () => {
      const clock = fakeClock();
      const K = `${KEY}-exit`;
      const {ci, lands} = held();
      boundedCharge(ci, K, 'x', 1, () => undefined, {clock});
      boundedCharge(ci, K, 'y', 1, () => undefined, {clock});
      clock.advance(METER_PENDING_MS);
      logged.length = 0;
      cb.sayPendingAtExit();
      assert.ok(logged.some(([l, line]) => l === 'E' && line === `at exit, 2 charge(s) of ${keyFingerprint(K)} were still pending: their outcome is unknown`), JSON.stringify(logged));
      assert.ok(!logged.some(([, line]) => line.includes(meterId(K))), 'the meter id is never logged');
      // (a key whose pending charges have all landed is said no more)
      lands.forEach((land) => land(null, {charged: 1}));
      logged.length = 0;
      cb.sayPendingAtExit();
      assert.ok(!logged.some(([, line]) => line.includes(keyFingerprint(K))), JSON.stringify(logged));
      // (the medium on round 1, 5) a charge answered pending past the
      // allowance holds no slot, and is said at exit all the same
      const K2 = `${KEY}-exit-capped`;
      const more = held();
      for (let i = 0; i <= MAX_PENDING_PER_KEY; i++) boundedCharge(more.ci, K2, `c${i}`, 1, () => undefined, {clock, deadline: clock.now() + 2000});
      clock.advance(2000);
      logged.length = 0;
      cb.sayPendingAtExit();
      assert.ok(logged.some(([, line]) => line === `at exit, ${MAX_PENDING_PER_KEY + 1} charge(s) of ${keyFingerprint(K2)} were still pending: their outcome is unknown`), JSON.stringify(logged));
      for (const land of more.lands) land(null, {charged: 1});
      assert.ok(!logged.some(([, line]) => line.includes(K)));
      for (const land of lands) land(null, {charged: 1});
    });
  });
});

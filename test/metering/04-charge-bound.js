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
  after(() => { Object.assign(LOG, saved); });
  beforeEach(() => { logged.length = 0; });

  it('is the peer path\'s 500 ms', () => {
    assert.strictEqual(METER_PENDING_MS, 500);
  });

  it('a charge in time: its own answer, once, with the options passed as given', async () => {
    const seen = [];
    const ci = {recordCall: (key, tool, cost, cb, opts) => { seen.push([key, tool, cost, opts]); cb(null, {charged: cost}); cb(null, {charged: 99}); }};
    const answers = [];
    boundedCharge(ci, KEY, 't', 1, (...a) => answers.push(a), {opts: {session: 's1'}, boundMs: 50});
    await new Promise((r) => setTimeout(r, 80));
    assert.deepStrictEqual(seen, [[KEY, 't', 1, {session: 's1'}]]);
    assert.deepStrictEqual(answers, [[null, {charged: 1}, false]], 'once, never at the bound too');
  });

  it('a charge past the bound: billingPending at the bound, never charged again, its landing logged', async () => {
    let land = null;
    let calls = 0;
    const ci = {recordCall: (key, tool, cost, cb) => { calls++; land = cb; }};
    const answers = [];
    boundedCharge(ci, KEY, 'svc_t', 1, (...a) => answers.push(a), {what: 'hop', boundMs: 30});
    await new Promise((r) => setTimeout(r, 60));
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
    await new Promise((r) => setTimeout(r, 60));
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
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(answers.length, 1);
    assert.deepStrictEqual([answers[0][0].message, answers[0][1], answers[0][2]], ['redis down', null, false]);
  });

  it('a recordCall that throws: answered as its error, once, not at the bound', async () => {
    const ci = {recordCall: () => { throw new Error('boom'); }};
    const answers = [];
    boundedCharge(ci, KEY, 't', 1, (...a) => answers.push(a), {boundMs: 30});
    await new Promise((r) => setTimeout(r, 60));
    assert.deepStrictEqual(answers.map((a) => [a[0] && a[0].message, a[2]]), [['boom', false]]);
  });

  it('lateOutcome names the key only by its meterId', () => {
    lateOutcome('peer hop', 'x', KEY, new Error(`detail`), null);
    const line = logged.find(([l]) => l === 'E')[1];
    assert.ok(line.startsWith('peer hop x: the pending billing failed for meter ') && !line.includes(KEY), line);
  });
});

'use strict';
// B-cancelled (the reviewer's ruling, 2026-11-16, on M19): a call cancelled
// while it ran is recorded once, outcome 'cancelled' (lib/usage/receipt.js
// finishToolCall). It is no error: the report counts it apart, as
// profile.cancelled, by the call id its result record shares with the call's
// In records -- one cancelled call, one count, however many server calls it
// made -- and its errors do not count it.
const assert = require('assert');
const {createUsage} = require('../../lib/usage');
const {usageReport} = require('../../lib/usage/report');

const NOW = Date.parse('2026-11-19T12:00:00Z');
const ADMIN = {caller: 'c1', isAdmin: true};
const reportOf = (u) => usageReport({since: 'all'}, ADMIN, {usage: u, usageDir: null, now: () => NOW});

describe('usage 25: a cancelled call is counted as that, not as an error (B-cancelled)', () => {
  const call = (u, outcome, extra = {}, serverCalls = 0) => {
    const c = u.beginCall({scenario: 'p', module: 'm', tool: 't', caller: 'c1'});
    for (let i = 0; i < serverCalls; i++) u.recordIn(c, {server: 'remote', tool: 'x', bytes: 10, lines: 1, ms: 3, outcome: 'ok'});
    u.recordOut(c, Object.assign({tool: 't', bytes: 5, lines: 1, ms: 7, outcome}, extra));
    return c;
  };

  it('profile.cancelled counts the cancelled calls, each once whatever its server calls; errors leave them out', async () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW});
    call(u, 'cancelled', {}, 3);
    call(u, 'cancelled');
    call(u, 'ok');
    call(u, 'error', {code: 'ASK_STATE_INVALID'});
    const report = await reportOf(u);
    assert.strictEqual(report.profile.cancelled, 2);
    assert.deepStrictEqual(report.profile.errors.calls, {ASK_STATE_INVALID: 1});
    // still calls, in the totals and the call time, as they ran
    assert.strictEqual(report.totals.calls, 4);
    assert.strictEqual(report.profile.callMs.count, 4);
  });

  it('there with none, and a field of the report\'s closed output schema (the tools/list golden moved for it)', async () => {
    const report = await reportOf(createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW}));
    assert.strictEqual(report.profile.cancelled, 0);
    const {OUTPUT_SCHEMA} = require('../../lib/usage/report');
    const profile = OUTPUT_SCHEMA.properties.profile;
    assert.deepStrictEqual(profile.properties.cancelled, {title: 'calls cancelled while they ran (M19): counted once each, by call; no error', type: 'integer', minimum: 0});
    assert.ok(profile.required.includes('cancelled'));
  });

  it('the text says it, when there is any', async () => {
    const {reportText} = require('../../lib/usage/report');
    const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW});
    assert.doesNotMatch(reportText(await reportOf(u)), /cancelled/);
    call(u, 'cancelled');
    assert.match(reportText(await reportOf(u)), /cancelled: 1 call cancelled while it ran/);
  });
});

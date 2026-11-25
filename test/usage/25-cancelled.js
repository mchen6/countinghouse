'use strict';
// B-cancelled (the reviewer's ruling, 2026-11-16, on M19): a call cancelled
// while it ran is recorded once, outcome 'cancelled' (lib/usage/receipt.js
// finishToolCall). It is no error: the report counts it apart, as
// profile.cancelled, one count per result record, and neither its errors nor
// the server calls the cancel aborted are counted as errors.
const assert = require('assert');
const {createUsage} = require('../../lib/usage');
const {usageReport} = require('../../lib/usage/report');

const NOW = Date.parse('2026-11-19T12:00:00Z');
const ADMIN = {caller: 'c1', isAdmin: true};
const reportOf = (u) => usageReport({since: 'all'}, ADMIN, {usage: u, usageDir: null, now: () => NOW});

describe('usage 25: a cancelled call is counted as that, not as an error (B-cancelled)', () => {
  const call = (u, outcome, extra = {}, serverCalls = 0) => {
    const c = u.beginCall({scenario: 'p', module: 'm', tool: 't', caller: 'c1'});
    for (let i = 0; i < serverCalls; i++) u.recordIn(c, {server: 'remote', tool: 'x', bytes: 10, ms: 3, outcome: 'ok'});
    u.recordOut(c, Object.assign({tool: 't', bytes: 5, ms: 7, outcome}, extra));
    return c;
  };

  it('profile.cancelled counts the cancelled calls, one each; errors leave them out', async () => {
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

  it('a server call the cancel aborted (CALL_TOKEN_INVALID) is no server-call error either, with the result in the window or just past it', async () => {
    let clock = NOW - 1000;
    const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => clock});
    const aborted = (resultLate) => {
      const c = u.beginCall({scenario: 'p', module: 'm', tool: 't', caller: 'c1'});
      u.recordIn(c, {server: 'remote', tool: 'x', bytes: 10, ms: 3, outcome: 'ok'});
      u.recordIn(c, {server: 'remote', tool: 'x', bytes: 0, ms: 3, outcome: 'CALL_TOKEN_INVALID'});
      if (resultLate) clock = NOW + 5;
      u.recordOut(c, {tool: 't', bytes: 5, ms: 7, outcome: 'cancelled'});
      clock = NOW - 1000;
    };
    aborted(false);
    aborted(true);
    // a call that was not cancelled keeps its server-call error
    const c = u.beginCall({scenario: 'p', module: 'm', tool: 't', caller: 'c1'});
    u.recordIn(c, {server: 'remote', tool: 'x', bytes: 0, ms: 3, outcome: 'CALL_TOKEN_INVALID'});
    u.recordOut(c, {tool: 't', bytes: 5, ms: 7, outcome: 'error', code: 'CALL_TOKEN_INVALID'});
    const report = await reportOf(u);
    assert.deepStrictEqual(report.profile.errors.serverCalls, {CALL_TOKEN_INVALID: 1});
    // the late result is past the window: counted on the day it lands, as
    // errors.calls and callMs are
    assert.strictEqual(report.profile.cancelled, 1);
    // the aborted server calls still ran: still counted as server calls
    assert.strictEqual(report.totals.serverCalls, 5);
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

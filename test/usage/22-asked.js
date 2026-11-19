'use strict';
// MCP completeness M13 (the design, section 8): the usage record of a call
// that asked its user a question. Each pass of such a call is a tools/call
// of its own; the pass that ends on a question is recorded with outcome
// "asked" and its round, so an operator can see a module that asks, and one
// that asks late (work done before the ask is done again on the next pass).
// It is no error and no result: the report's errors do not count it.
const assert = require('assert');
const {createUsage} = require('../../lib/usage');
const {usageReport} = require('../../lib/usage/report');

const NOW = Date.parse('2026-11-15T12:00:00Z');
const ADMIN = {caller: 'c1', isAdmin: true};

describe('usage 22: the record of a call that asked (MCP completeness M13)', () => {
  const asked = (u, round) => {
    const c = u.beginCall({pack: 'p', module: 'm', tool: 't', caller: 'c1'});
    u.recordOut(c, {tool: 't', bytes: 0, lines: 0, ms: 5, outcome: 'asked', round});
    return c;
  };

  it('the pass that ends on a question is recorded "asked" with its round; no other record has a round', () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW});
    const first = asked(u, 1);
    const second = asked(u, 2);
    const done = u.beginCall({pack: 'p', module: 'm', tool: 't', caller: 'c1'});
    u.recordOut(done, {tool: 't', bytes: 10, lines: 1, ms: 7, outcome: 'ok', round: 3});
    const failed = u.beginCall({pack: 'p', module: 'm', tool: 't', caller: 'c1'});
    u.recordOut(failed, {tool: 't', bytes: 10, lines: 1, ms: 7, outcome: 'error', code: 'ASK_STATE_INVALID'});
    const by = (call) => u.records().find((r) => r.call === call);
    assert.deepStrictEqual([by(first).outcome, by(first).round, by(second).round], ['asked', 1, 2]);
    assert.ok(!('round' in by(done)) && !('round' in by(failed)), 'a round is an asked record\'s only');
    assert.ok(!('code' in by(first)));
    // a round that is no round is not recorded
    for (const bad of [0, -1, 1.5, '2', null, undefined, 99]) assert.ok(!('round' in by(asked(u, bad))), String(bad));
  });

  // M14 (the reviewer's ruling): the dialog carries the listed module's name, and the record names who
  // really asked: a part's module, action and question
  it('an asked pass names who asked: a module, an action, a question, each a bounded clean string', () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW});
    const c = u.beginCall({pack: 'p', module: 'pack', tool: 't', caller: 'c1'});
    u.recordOut(c, {tool: 't', bytes: 0, lines: 0, ms: 5, outcome: 'asked', round: 1, askedBy: {module: 'asks-part', action: 'store', question: 'overwrite'}});
    const by = (call) => u.records().find((r) => r.call === call);
    assert.deepStrictEqual(by(c).askedBy, {module: 'asks-part', action: 'store', question: 'overwrite'});
    // only on an asked pass, and only as three strings: cut to 128 characters, controls taken out
    const ok = u.beginCall({pack: 'p', module: 'pack', tool: 't', caller: 'c1'});
    u.recordOut(ok, {tool: 't', bytes: 1, lines: 1, ms: 5, outcome: 'ok', askedBy: {module: 'x', action: 'y', question: 'z'}});
    assert.ok(!('askedBy' in by(ok)));
    const odd = u.beginCall({pack: 'p', module: 'pack', tool: 't', caller: 'c1'});
    u.recordOut(odd, {tool: 't', bytes: 0, lines: 0, ms: 5, outcome: 'asked', round: 1, askedBy: {module: `m\n${'x'.repeat(300)}`, action: 7, question: 'q'}});
    assert.ok(!('askedBy' in by(odd)), 'not three strings: not recorded');
    const long = u.beginCall({pack: 'p', module: 'pack', tool: 't', caller: 'c1'});
    u.recordOut(long, {tool: 't', bytes: 0, lines: 0, ms: 5, outcome: 'asked', round: 1, askedBy: {module: `m\u001b[2J${'x'.repeat(300)}`, action: 'a', question: 'q'}});
    assert.strictEqual(by(long).askedBy.module.length, 128);
    assert.doesNotMatch(by(long).askedBy.module, /[\u0000-\u001f]/);
    // the one module-text rule: an override, the bidi marks, a zero-width
    // character
    const bidi = u.beginCall({pack: 'p', module: 'pack', tool: 't', caller: 'c1'});
    u.recordOut(bidi, {tool: 't', bytes: 0, lines: 0, ms: 5, outcome: 'asked', round: 1, askedBy: {module: 'a\u202eb\u200fc\u061cd\u200be', action: 'a', question: 'q'}});
    assert.strictEqual(by(bidi).askedBy.module, 'a b c d e');
  });

  it('the report counts it among the outcomes and never among the errors', async () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW});
    asked(u, 1);
    asked(u, 2);
    const done = u.beginCall({pack: 'p', module: 'm', tool: 't', caller: 'c1'});
    u.recordOut(done, {tool: 't', bytes: 10, lines: 1, ms: 7, outcome: 'ok'});
    const failed = u.beginCall({pack: 'p', module: 'm', tool: 't', caller: 'c1'});
    u.recordOut(failed, {tool: 't', bytes: 10, lines: 1, ms: 7, outcome: 'error', code: 'ASK_STATE_INVALID'});
    const report = await usageReport({since: 'all'}, ADMIN, {usage: u, usageDir: null, now: () => NOW});
    assert.deepStrictEqual(report.profile.errors.calls, {ASK_STATE_INVALID: 1});
  });

  // The reviewer's ruling (2026-11-15): cost stays true and counts are
  // honest. A call that asked is one call: its final pass. A pass that ended
  // on a question is counted as that, on its own; what it really did (its
  // server calls) stays in the cost totals; and what a call kept out of the
  // model's context is its final pass's, once, not every pass's.
  describe('a call that asked is one call in the report', () => {
    // one user-visible call of tool t: two passes that each read 100 KB from a server and asked, then the
    // pass that read it again and answered with 2 KB
    const asking = () => {
      const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW});
      for (const round of [1, 2, null]) {
        const c = u.beginCall({pack: 'p', module: 'm', tool: 't', caller: 'c1'});
        u.recordIn(c, {server: 'github', module: 'ch-access-github', tool: 'get_logs', bytes: 100000, lines: 10, ms: 30, outcome: 'ok', credential: 'GITHUB_TOKEN'});
        if (round != null) u.recordOut(c, {tool: 't', bytes: 0, lines: 0, ms: 40, outcome: 'asked', round});
        else u.recordOut(c, {tool: 't', bytes: 2000, lines: 5, ms: 50, outcome: 'ok'});
      }
      return u;
    };
    const reportOf = (u, args = {since: 'all'}) => usageReport(args, ADMIN, {usage: u, usageDir: null, now: () => NOW});

    it('calls, the tool\'s row and the day count it once; the server calls of every pass stay counted', async () => {
      const report = await reportOf(asking(), {since: 'all', groupBy: 'tool'});
      assert.deepStrictEqual([report.totals.calls, report.totals.serverCalls, report.totals.bytesIn, report.totals.bytesOut], [1, 3, 300000, 2000]);
      const row = report.groups.find((g) => g.tool === 't');
      assert.deepStrictEqual([row.calls, row.serverCalls, row.bytesIn], [1, 3, 300000]);
      assert.deepStrictEqual(report.days.map((d) => [d.calls, d.serverCalls, d.bytesIn]), [[1, 3, 300000]]);
    });

    it('what it kept out of the model\'s context is its final pass\'s, once', async () => {
      const report = await reportOf(asking());
      // 100 KB read, 2 KB sent: 98,000 bytes kept, as tokens; never three passes\' worth
      const oncePass = await reportOf((() => {
        const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW});
        const c = u.beginCall({pack: 'p', module: 'm', tool: 't', caller: 'c1'});
        u.recordIn(c, {server: 'github', module: 'ch-access-github', tool: 'get_logs', bytes: 100000, lines: 10, ms: 30, outcome: 'ok', credential: 'GITHUB_TOKEN'});
        u.recordOut(c, {tool: 't', bytes: 2000, lines: 5, ms: 50, outcome: 'ok'});
        return u;
      })());
      assert.deepStrictEqual(report.totals.keptOut, oncePass.totals.keptOut);
      assert.deepStrictEqual(report.days[0].keptOut, oncePass.days[0].keptOut);
    });

    // profile.asked is a field of the report's closed output schema: adding it moved the tools/list golden
    // for countinghouse_usage_report, on purpose (the reviewer's ruling, 2026-11-15)
    it('the passes that asked are a count of their own; a call\'s time and its server calls per call are its final pass\'s', async () => {
      const report = await reportOf(asking());
      assert.strictEqual(report.profile.asked, 2);
      assert.strictEqual((await reportOf(createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW}))).profile.asked, 0, 'there with none, too');
      const text = require('../../lib/usage/report').reportText(report);
      // /code-review of #333, 4: a pass that asked was no call, retried or not: the line never says it was counted
      assert.match(text, /asked the user: 2 passes ended on a question \(a pass that asked is no call; the retry that answers is one\)/);
      assert.doesNotMatch(text, /each retried call is counted once/);
      assert.strictEqual(report.profile.callMs.count, 1, JSON.stringify(report.profile.callMs));
      assert.deepStrictEqual([report.profile.serverCallsPerCall.mean, report.profile.serverCallsPerCall.max], [1, 1]);
      assert.strictEqual(report.profile.serverCallMs.count, 3, 'every server call was made');
      assert.deepStrictEqual(report.profile.errors.calls, {});
    });

    it('the CLI\'s aggregate counts the call once too, and the passes that asked among its outcomes', () => {
      // as the reader hands them to it (lib/usage/read.js normalise: a result's server is null)
      const {normalise} = require('../../lib/usage/read');
      const out = require('../../lib/usage/aggregate').aggregate(asking().records().map((r) => normalise(r)).filter((r) => r != null).map((r) => Object.assign(r, {process: '1-1'})));
      assert.deepStrictEqual([out.totals.calls, out.totals.serverCalls], [1, 3]);
      assert.deepStrictEqual(out.outcomes, {asked: 2, ok: 1});
    });

    // /code-review of #333, 1: a pass whose server calls are inside the window and whose asked result falls
    // just past it still kept nothing out
    it('an asked pass whose result falls just past the window kept nothing out', async () => {
      let now = Date.parse('2026-11-14T23:59:59.900Z');
      const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => now});
      const c = u.beginCall({pack: 'p', module: 'm', tool: 't', caller: 'c1'});
      u.recordIn(c, {server: 'github', module: 'ch-access-github', tool: 'get_logs', bytes: 100000, lines: 10, ms: 30, outcome: 'ok', credential: 'GITHUB_TOKEN'});
      now = Date.parse('2026-11-15T00:00:00.100Z');
      u.recordOut(c, {tool: 't', bytes: 0, lines: 0, ms: 40, outcome: 'asked', round: 1});
      const report = await usageReport({since: '2026-11-14', until: '2026-11-14'}, ADMIN, {usage: u, usageDir: null, now: () => NOW});
      assert.strictEqual(report.totals.serverCalls, 1, 'its server call is in the window');
      const none = await usageReport({since: '2026-11-14', until: '2026-11-14'}, ADMIN, {usage: createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW}), usageDir: null, now: () => NOW});
      assert.deepStrictEqual(report.totals.keptOut, none.totals.keptOut);
    });

    // /code-review of #333, 3: the CLI's "pack calls that replaced server calls" keeps a tool whose only
    // passes in the range asked (its retry in a later file): it still made those server calls
    it('the CLI\'s replaced view keeps a tool whose only passes in the range asked', () => {
      const {normalise} = require('../../lib/usage/read');
      const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW});
      for (const round of [1, 2]) {
        const c = u.beginCall({pack: 'p', module: 'm', tool: 't', caller: 'c1'});
        u.recordIn(c, {server: 'github', module: 'ch-access-github', tool: 'get_logs', bytes: 1000, lines: 1, ms: 30, outcome: 'ok', credential: 'GITHUB_TOKEN'});
        u.recordOut(c, {tool: 't', bytes: 0, lines: 0, ms: 40, outcome: 'asked', round});
      }
      const out = require('../../lib/usage/aggregate').aggregate(u.records().map((r) => normalise(r)).filter((r) => r != null).map((r) => Object.assign(r, {process: '1-1'})));
      assert.deepStrictEqual(out.replaced.map((r) => [r.tool, r.packCalls, r.serverCalls]), [['t', 0, 2]]);
    });

    it('the report and the CLI\'s aggregate tell an asked pass by one rule', () => {
      const {isAskedPass} = require('../../lib/usage/aggregate');
      assert.deepStrictEqual([isAskedPass({server: null, outcome: 'asked'}), isAskedPass({server: null, outcome: 'ok'}), isAskedPass({server: 'github', outcome: 'asked'})], [true, false, false]);
    });

    // The reviewer's ruling (11-15, kept 11-16): kept out is the final pass's. A handler that answers its
    // retry from data an earlier pass read (its own /data) is counted from its final pass only, and the
    // method says so
    it('a call that asked is counted from its final pass only, also when that pass read nothing; the method says so', async () => {
      const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW});
      const first = u.beginCall({pack: 'p', module: 'm', tool: 't', caller: 'c1'});
      u.recordIn(first, {server: 'github', module: 'ch-access-github', tool: 'get_logs', bytes: 100000, lines: 10, ms: 30, outcome: 'ok', credential: 'GITHUB_TOKEN'});
      u.recordOut(first, {tool: 't', bytes: 0, lines: 0, ms: 40, outcome: 'asked', round: 1});
      const retry = u.beginCall({pack: 'p', module: 'm', tool: 't', caller: 'c1'});
      u.recordOut(retry, {tool: 't', bytes: 2000, lines: 5, ms: 50, outcome: 'ok'});
      const report = await reportOf(u);
      assert.strictEqual(report.totals.keptOut.estimate, 0, 'the final pass read nothing, so nothing is counted kept out');
      assert.deepStrictEqual([report.totals.keptOut.bound, report.totals.keptOut.method],
        ['upper', 'utf8 bytes / 4 of max(0, bytes read from servers - bytes returned), rounded per tool call; a call that asked is counted from its final pass only']);
    });

    it('a call that asked and was never retried is no call, and kept nothing out: its server calls are still its cost', async () => {
      const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW});
      const c = u.beginCall({pack: 'p', module: 'm', tool: 't', caller: 'c1'});
      u.recordIn(c, {server: 'github', module: 'ch-access-github', tool: 'get_logs', bytes: 100000, lines: 10, ms: 30, outcome: 'ok', credential: 'GITHUB_TOKEN'});
      u.recordOut(c, {tool: 't', bytes: 0, lines: 0, ms: 40, outcome: 'asked', round: 1});
      const report = await reportOf(u);
      assert.deepStrictEqual([report.totals.calls, report.totals.serverCalls, report.totals.bytesIn], [0, 1, 100000]);
      const none = await reportOf(createUsage({usageDir: null, pid: 1, startMs: 1, now: () => NOW}));
      assert.deepStrictEqual(report.totals.keptOut, none.totals.keptOut);
    });
  });
});

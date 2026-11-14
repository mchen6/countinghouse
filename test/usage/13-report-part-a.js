// countinghouse_usage_report, Part A (Matt, 2026-11-13; #158): `until` and
// `since: "all"`, by-day rows, the tokens kept out of the model's context as
// an upper-bound estimate ({estimate, method, bound: "upper"}), and
// profiling (call time, errors by code, server calls per call). The headline
// is the period's totals. Pure over an in-memory recorder (and a fixture
// directory for "all").
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createUsage} = require('../../lib/usage');
const {finishToolCall} = require('../../lib/usage/receipt');
const {usageReport, reportText, OUTPUT_SCHEMA, KEPT_OUT_METHOD} = require('../../lib/usage/report');
const {writeUsageFixture} = require('../helpers/usage-fixture');
const Ajv2020 = require('ajv/dist/2020');
const {CODES} = require('../../lib/error-catalogue');

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const DAY = 86400000;
const ADMIN = {caller: 'u_admin', isAdmin: true};

// A recorder whose clock the test sets per record.
function recorder() {
  let t = 0;
  const u = createUsage({usageDir: null, pid: 9, startMs: NOW - 400 * DAY, now: () => t});
  // One tools/call: its server calls, then its result (out: null for none).
  u.call = ({at, caller = 'u_a', tool = 'triage', pack = 'ch-pack-x', ins = [], out = {}}) => {
    t = Date.parse(at);
    const c = u.beginCall({pack, tool, caller});
    for (const i of ins) {
      u.recordIn(c, {server: i.server || 'github', module: 'ch-access-github', tool: 'get_logs', bytes: i.bytes || 0, lines: 1, ms: i.ms === undefined ? 1 : i.ms,
        outcome: i.outcome || 'ok', credential: 'GITHUB_TOKEN', mapped: i.mapped === true});
      t += 1;
    }
    if (out !== null) u.recordOut(c, {tool, bytes: out.bytes || 0, lines: 1, ms: out.ms === undefined ? 5 : out.ms, outcome: out.outcome || 'ok', code: out.code});
    return c;
  };
  return u;
}
const report = (u, args, who = ADMIN, usageDir = null) => usageReport(args, who, {usage: u, usageDir, now: () => NOW});

describe('countinghouse_usage_report, Part A', () => {
  describe('the window: until, and since "all"', () => {
    it('until takes a day (its end, inclusive), an ISO time or a duration; the default is now', async () => {
      const u = recorder();
      u.call({at: '2026-11-12T23:59:59.000Z', out: {bytes: 4}});
      u.call({at: '2026-11-13T00:00:01.000Z', out: {bytes: 4}});
      assert.strictEqual((await report(u, {since: '2026-11-01', until: '2026-11-12'})).totals.calls, 1);
      assert.strictEqual((await report(u, {since: '2026-11-01', until: '2026-11-12'})).window.until, '2026-11-12T23:59:59.999Z');
      assert.strictEqual((await report(u, {since: '2026-11-01', until: '2026-11-13T00:00:00Z'})).totals.calls, 1);
      assert.strictEqual((await report(u, {since: '2026-11-01', until: '35h'})).totals.calls, 2);
      assert.strictEqual((await report(u, {since: '2026-11-01'})).window.until, new Date(NOW).toISOString());
    });

    it('refuses an until before since, or one it cannot read, in plain words', async () => {
      const u = recorder();
      await assert.rejects(report(u, {since: '2026-11-12', until: '2026-11-11'}), /until .*before since/);
      for (const bad of ['soon', '2026-02-30', 7]) await assert.rejects(report(u, {until: bad}), /until must be/, String(bad));
      await assert.rejects(report(u, {since: 'all', untill: '1d'}), /unknown argument untill: only since, until and groupBy/);
    });

    it('since "all" is from the first record; the window names the first and last record', async () => {
      const dir = writeUsageFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-a-')));
      try {
        const out = (await usageReport({since: 'all'}, ADMIN, {usage: null, usageDir: dir, now: () => NOW}));
        assert.strictEqual(out.window.since, null);
        assert.strictEqual(out.window.first, '2026-11-09T09:00:00.000Z');
        assert.match(out.window.last, /^2026-11-11T/);
        assert.match(reportText(out).split('\n')[0], /^usage from 2026-11-09 to 2026-11-11 /);
      } finally {
        fs.rmSync(dir, {recursive: true, force: true});
      }
    });

    it('the default since is unchanged: no since is everything recorded', async () => {
      const u = recorder();
      u.call({at: '2026-01-02T00:00:00.000Z'});
      assert.strictEqual((await report(u, {})).window.since, null);
      assert.strictEqual((await report(u, {})).totals.calls, 1);
    });
  });

  describe('kept out of the model\'s context: an upper-bound estimate', () => {
    it('per tool call max(0, bytes read from servers - bytes returned) / 4, summed; method and bound named', async () => {
      const u = recorder();
      u.call({at: '2026-11-13T10:00:00.000Z', ins: [{bytes: 600}, {bytes: 400}], out: {bytes: 200}});   // 800 / 4 = 200
      u.call({at: '2026-11-13T11:00:00.000Z', ins: [{bytes: 100}], out: {bytes: 400}});                 // never negative: 0
      u.call({at: '2026-11-14T09:00:00.000Z', ins: [{bytes: 41}], out: null});                          // no result: 41 / 4 = 10
      u.call({at: '2026-11-14T09:30:00.000Z', ins: [{bytes: 4000, mapped: true}], out: {bytes: 0}});    // a stand-in's: not counted
      const out = (await report(u, {since: 'all'}));
      assert.deepStrictEqual(out.totals.keptOut, {estimate: 210, method: KEPT_OUT_METHOD, bound: 'upper'});
      assert.deepStrictEqual(out.days.map((d) => [d.day, d.keptOut.estimate]), [['2026-11-13', 200], ['2026-11-14', 10]]);
      assert.strictEqual(out.days.reduce((s, d) => s + d.keptOut.estimate, 0), out.totals.keptOut.estimate);
      for (const d of out.days) assert.deepStrictEqual([d.keptOut.method, d.keptOut.bound], [KEPT_OUT_METHOD, 'upper']);
    });

    // A report's until can fall between a call's server calls and its
    // result: the result, though outside the window, is still subtracted.
    it('a call whose result falls just past until still has its result subtracted', async () => {
      const u = recorder();
      u.call({at: '2026-11-12T23:59:59.999Z', ins: [{bytes: 40000}], out: {bytes: 39000}});   // the result at 00:00:00.000
      const out = (await report(u, {since: 'all', until: '2026-11-12'}));
      assert.strictEqual(out.totals.keptOut.estimate, 250);
    });

    it('the text leads with the period\'s totals and says what the estimate is, never a saving or a cost', async () => {
      const u = recorder();
      u.call({at: '2026-11-13T10:00:00.000Z', ins: [{bytes: 4000}], out: {bytes: 400}});
      const text = reportText((await report(u, {since: 'all'})));
      const lines = text.split('\n');
      assert.match(lines[0], /^usage from 2026-11-13 to 2026-11-13 /);
      assert.match(lines[1], /^period: 1 calls, 1 server calls; about 900 fewer tokens: kept out of the model's context, an upper-bound estimate \(/);
      assert.doesNotMatch(text, /sav(e|ed|ing)|lower bill|cost/i);
    });
  });

  describe('by-day rows', () => {
    it('one row per UTC day with activity, oldest first, inside the window only', async () => {
      const u = recorder();
      u.call({at: '2026-11-10T23:59:00.000Z', ins: [{bytes: 8}], out: {bytes: 4}});
      u.call({at: '2026-11-12T00:01:00.000Z', out: {bytes: 4}});
      u.call({at: '2026-11-12T22:00:00.000Z', out: {bytes: 4}});
      const out = (await report(u, {since: '2026-11-11', until: '2026-11-12'}));
      assert.deepStrictEqual(out.days.map((d) => [d.day, d.calls, d.serverCalls]), [['2026-11-12', 2, 0]]);
      const all = (await report(u, {since: 'all'}));
      assert.deepStrictEqual(all.days.map((d) => [d.day, d.calls, d.serverCalls, d.bytesIn, d.bytesOut]),
        [['2026-11-10', 1, 1, 8, 4], ['2026-11-12', 2, 0, 0, 8]]);
      assert.strictEqual(all.daysOmitted, 0);
    });

    it('at most 366 rows, the newest; the rest counted in daysOmitted and still in the totals', async () => {
      const u = recorder();
      for (let i = 0; i < 370; i++) u.call({at: new Date(NOW - (i + 1) * DAY).toISOString(), ins: [{bytes: 8}], out: {bytes: 0}});
      const out = (await report(u, {since: 'all'}));
      assert.strictEqual(out.days.length, 366);
      assert.strictEqual(out.daysOmitted, 4);
      assert.strictEqual(out.days[out.days.length - 1].day, new Date(NOW - DAY).toISOString().slice(0, 10));
      assert.strictEqual(out.totals.calls, 370);
      assert.strictEqual(out.totals.keptOut.estimate, 740);
    });
  });

  describe('profiling', () => {
    it('call time and server-call time: count, total, p50, p95, max', async () => {
      const u = recorder();
      for (let i = 1; i <= 20; i++) u.call({at: '2026-11-13T10:00:00.000Z', ins: [{ms: i * 10}], out: {ms: i}});
      const p = (await report(u, {since: 'all'})).profile;
      assert.deepStrictEqual(p.callMs, {count: 20, totalMs: 210, p50: 10, p95: 19, max: 20});
      assert.deepStrictEqual(p.serverCallMs, {count: 20, totalMs: 2100, p50: 100, p95: 190, max: 200});
      const none = (await report(recorder(), {since: 'all'})).profile;
      assert.deepStrictEqual(none.callMs, {count: 0, totalMs: 0, p50: null, p95: null, max: null});
    });

    // Only the runtime's catalogue codes are named: a module chooses its own
    // codes, and could carry data in one, so they all read MODULE_ERROR.
    it('errors by code: catalogue codes named; a module\'s code, none, free text and old records each named for what they are', async () => {
      const u = recorder();
      u.call({at: '2026-11-13T10:00:00.000Z', out: {outcome: 'error', code: 'ARGUMENTS_INVALID'}});
      u.call({at: '2026-11-13T10:00:01.000Z', out: {outcome: 'error', code: 'ARGUMENTS_INVALID'}});
      u.call({at: '2026-11-13T10:00:02.000Z', out: {outcome: 'error'}});
      u.call({at: '2026-11-13T10:00:02.500Z', out: {outcome: 'error', code: 'ACCT_4F2K9QZ7_LOCKED'}});
      u.call({at: '2026-11-13T10:00:02.700Z', out: {outcome: 'error', code: 'free text, not a code'}});
      u.call({at: '2026-11-13T10:00:03.000Z', ins: [{outcome: 'isError'}, {outcome: 'ECONNREFUSED'}, {outcome: 'not a code!'}, {outcome: 'ACCT_4F2K9QZ7'}, {outcome: 'ok'}]});
      assert.deepStrictEqual((await report(u, {since: 'all'})).profile.errors, {
        calls: {ARGUMENTS_INVALID: 2, MODULE_ERROR: 1, NO_CODE: 1, OTHER: 1},
        serverCalls: {TOOL_ERROR: 1, ECONNREFUSED: 1, OTHER: 2}
      });
      assert.ok(u.records().every((r) => r.code !== 'ACCT_4F2K9QZ7_LOCKED'), 'a module\'s own code is not stored');
    });

    it('an error record from before codes were kept reads UNRECORDED', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-a-'));
      try {
        fs.mkdirSync(path.join(dir, '2026-11-13'));
        fs.writeFileSync(path.join(dir, '2026-11-13', '5-1.jsonl'),
          `${JSON.stringify({t: '2026-11-13T10:00:00.000Z', call: 1, pack: 'p', tool: 'x', bytesOut: 1, linesOut: 1, ms: 3, outcome: 'error', caller: 'u_a'})}\n`);
        assert.deepStrictEqual((await usageReport({since: 'all'}, ADMIN, {usage: null, usageDir: dir, now: () => NOW})).profile.errors.calls, {UNRECORDED: 1});
      } finally {
        fs.rmSync(dir, {recursive: true, force: true});
      }
    });

    it('at most 32 codes per kind; the rest counted under OTHER', async () => {
      const u = recorder();
      const codes = Object.keys(CODES).slice(0, 40);
      for (const code of codes) u.call({at: '2026-11-13T10:00:00.000Z', out: {outcome: 'error', code}});
      const calls = (await report(u, {since: 'all'})).profile.errors.calls;
      assert.ok(Object.keys(calls).length <= 33, Object.keys(calls).length);
      assert.strictEqual(Object.values(calls).reduce((s, n) => s + n, 0), 40);
      assert.ok(calls.OTHER >= 8, JSON.stringify(calls));
    });

    it('server calls per tool call: mean, max, and a distribution', async () => {
      const u = recorder();
      for (const n of [0, 1, 3, 6]) u.call({at: '2026-11-13T10:00:00.000Z', ins: Array.from({length: n}, () => ({bytes: 1}))});
      assert.deepStrictEqual((await report(u, {since: 'all'})).profile.serverCallsPerCall, {mean: 2.5, max: 6, distribution: {'0': 1, '1': 1, '2-4': 1, '5+': 1}});
    });
  });

  describe('privacy and the schema', () => {
    function mixed() {
      const u = recorder();
      u.call({at: '2026-11-13T10:00:00.000Z', caller: 'u_a', ins: [{bytes: 400}], out: {bytes: 0, outcome: 'error', code: 'ARGUMENTS_INVALID'}});
      u.call({at: '2026-11-13T11:00:00.000Z', caller: 'u_b', ins: [{bytes: 8000}, {bytes: 8000}], out: {bytes: 0, ms: 999}});
      return u;
    }

    it('a plain caller\'s totals, days and profile are its own calls only, and name no caller', async () => {
      const out = (await report(mixed(), {since: 'all'}, {caller: 'u_a', isAdmin: false}));
      assert.strictEqual(out.totals.calls, 1);
      assert.strictEqual(out.totals.keptOut.estimate, 100);
      assert.deepStrictEqual(out.days.map((d) => d.calls), [1]);
      assert.strictEqual(out.profile.callMs.max, 5);
      assert.deepStrictEqual(out.profile.errors.calls, {ARGUMENTS_INVALID: 1});
      assert.doesNotMatch(JSON.stringify(out), /u_a|u_b|caller/);
    });

    it('an admin\'s groups name callers by the opaque id only; nothing else does, and no credential appears', async () => {
      const out = (await report(mixed(), {since: 'all'}));
      const paths = [];
      const walk = (v, at) => {
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
        else if (v != null && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'caller') paths.push(at); walk(x, `${at}.${k}`); }
      };
      walk(out, '');
      assert.ok(paths.length > 0 && paths.every((p) => /^\.groups\[\d+\]$/.test(p)), paths.join(', '));
      assert.doesNotMatch(JSON.stringify(out), /GITHUB_TOKEN|credential/);
    });

    it('a name longer than 256 characters is cut to 256', async () => {
      const u = recorder();
      u.call({at: '2026-11-13T10:00:00.000Z', tool: 'x'.repeat(300)});
      assert.strictEqual((await report(u, {since: 'all'})).groups[0].tool.length, 256);
    });

    it('every report validates against the output schema, which is closed and bounded throughout', async () => {
      const ajv = new Ajv2020({strict: false});
      for (const out of [(await report(mixed(), {since: 'all'})), (await report(mixed(), {since: 'all'}, {caller: 'u_a', isAdmin: false})), (await report(recorder(), {}))]) {
        assert.ok(ajv.validate(OUTPUT_SCHEMA, out), JSON.stringify(ajv.errors));
      }
      const open = [];
      const walk = (s, at) => {
        if (s == null || typeof s !== 'object') return;
        const types = [].concat(s.type || []);
        if (types.includes('object') && !(s.additionalProperties === false || (typeof s.additionalProperties === 'object' && Number.isInteger(s.maxProperties)))) open.push(`${at} (object)`);
        if (types.includes('array') && !Number.isInteger(s.maxItems)) open.push(`${at} (array)`);
        if (types.includes('string') && !(Number.isInteger(s.maxLength) || s.const !== undefined || s.enum !== undefined)) open.push(`${at} (string)`);
        if (s.propertyNames != null && !Number.isInteger(s.propertyNames.maxLength) && s.propertyNames.pattern == null) open.push(`${at} (keys)`);
        for (const [k, v] of Object.entries(s.properties || {})) walk(v, `${at}.${k}`);
        if (s.items) walk(s.items, `${at}[]`);
        if (typeof s.additionalProperties === 'object') walk(s.additionalProperties, `${at}{}`);
      };
      walk(OUTPUT_SCHEMA, '');
      assert.deepStrictEqual(open, []);
    });
  });

  describe('recording', () => {
    it('an error result\'s Out record carries its code; a success carries none', async () => {
      let t = Date.parse('2026-11-13T10:00:00Z');
      const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => t++});
      const bad = u.beginCall({pack: 'p', tool: 'x', caller: 'u_a'});
      finishToolCall({usage: u, call: bad, result: {isError: true, content: [{type: 'text', text: 'no'}], _meta: {'countinghouse/code': 'ARGUMENTS_INVALID'}},
        role: 'scenario', tool: 'x', startedMs: t, now: () => t});
      const good = u.beginCall({pack: 'p', tool: 'x', caller: 'u_a'});
      finishToolCall({usage: u, call: good, result: {isError: false, content: [{type: 'text', text: 'ok'}]}, role: 'scenario', tool: 'x', startedMs: t, now: () => t});
      const outs = u.records().filter((r) => r.server == null);
      assert.deepStrictEqual(outs.map((r) => [r.outcome, r.code]), [['error', 'ARGUMENTS_INVALID'], ['ok', undefined]]);
    });

    it('a code that is not one (free text) is recorded as OTHER, never the text', async () => {
      let t = 0;
      const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => t++});
      const c = u.beginCall({pack: 'p', tool: 'x', caller: 'u_a'});
      finishToolCall({usage: u, call: c, result: {isError: true, content: [], _meta: {'countinghouse/code': 'secret text from somewhere'}}, role: 'scenario', tool: 'x', startedMs: 0, now: () => t});
      assert.strictEqual(u.records().find((r) => r.server == null).code, 'OTHER');
    });
  });
});

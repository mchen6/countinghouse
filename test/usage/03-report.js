// countinghouse_usage_report's logic (local-mode spec §5): the window, the
// grouping, the scoping by caller, the sources, and a closed output with token
// estimates that name their method. Pure over a usage recorder and a fixture
// directory.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createUsage} = require('../../lib/usage');
const {usageReport, OUTPUT_SCHEMA} = require('../../lib/usage/report');
const {writeUsageFixture} = require('../helpers/usage-fixture');
const Ajv2020 = require('ajv/dist/2020');

const NOW = Date.parse('2026-11-11T13:00:00.000Z');

describe('countinghouse_usage_report', () => {
  let dir;
  beforeEach(() => { dir = writeUsageFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-r-'))); });
  afterEach(() => { fs.rmSync(dir, {recursive: true, force: true}); });

  // This process: one scenario call by u_alice making two server calls.
  function live() {
    let t = NOW - 1000;
    const u = createUsage({usageDir: null, pid: 7, startMs: NOW - 5000, now: () => t++});
    const call = u.beginCall({pack: 'ch-pack-ci-failure-triage', tool: 'ci_failure_triage', caller: 'u_alice'});
    u.recordIn(call, {server: 'github', module: 'ch-access-github', tool: 'actions_list', bytes: 100, lines: 10, ms: 1, outcome: 'ok', credential: 'GITHUB_TOKEN'});
    u.recordIn(call, {server: 'github', module: 'ch-access-github', tool: 'get_job_logs', bytes: 300, lines: 30, ms: 1, outcome: 'ok', credential: 'GITHUB_TOKEN'});
    u.recordOut(call, {tool: 'ci_failure_triage', bytes: 40, lines: 4, ms: 9, outcome: 'ok'});
    return u;
  }
  const run = (args, who, u = live()) => usageReport(args, who, {usage: u, usageDir: dir, now: () => NOW});

  it('a call made in this process is in the next report (memory), and earlier processes\' files are in it too', () => {
    const out = run({since: '2026-11-11'}, {caller: 'u_alice', isAdmin: false});
    assert.deepStrictEqual(out.source, ['memory', 'files']);
    const triage = out.groups.find((g) => g.tool === 'ci_failure_triage');
    // 11-11 fixture: 2 calls (one from a stopped process), 4 server calls; memory: 1 call, 2 server calls.
    assert.deepStrictEqual([triage.calls, triage.serverCalls], [3, 5]);
  });

  it('a plain key sees only its own calls; an admin sees every caller, grouped by the opaque id', () => {
    const mine = run({since: '2026-11-11'}, {caller: 'u_alice', isAdmin: false});
    assert.ok(!mine.groups.some((g) => g.tool === 'usage_report'), 'u_bob\'s call is not u_alice\'s to see');
    assert.ok(mine.groups.every((g) => !('caller' in g)));
    const all = run({since: '2026-11-11'}, {caller: 'u_admin', isAdmin: true});
    assert.deepStrictEqual([...new Set(all.groups.map((g) => g.caller))].sort(), ['u_alice', 'u_bob']);
    const text = JSON.stringify(all);
    assert.ok(!/alice@|apiKey|"key"|userName/.test(text), 'no user name or key, only opaque ids');
  });

  it('groups by tool, server, pack or module', () => {
    const who = {caller: 'u_alice', isAdmin: false};
    assert.deepStrictEqual(run({since: '2026-11-11', groupBy: 'server'}, who).groups.map((g) => [g.server, g.serverCalls]), [['github', 6], ['(no server)', 0]]);
    assert.ok(run({since: '2026-11-11', groupBy: 'pack'}, who).groups.some((g) => g.pack === 'ch-pack-ci-failure-triage'));
    const modules = run({since: '2026-11-11', groupBy: 'module'}, who).groups.map((g) => g.module);
    assert.ok(modules.includes('ch-access-github') && modules.includes('ch-pack-ci-failure-triage'), modules.join(','));
  });

  it('since takes a day, an ISO time or a duration, and the window says what it was', () => {
    const who = {caller: 'u_alice', isAdmin: false};
    const w = run({since: '2h'}, who).window;
    // Part A: the window also names its first and last record
    assert.deepStrictEqual([w.since, w.until], ['2026-11-11T11:00:00.000Z', '2026-11-11T13:00:00.000Z']);
    assert.ok(w.first >= w.since && w.last <= w.until, JSON.stringify(w));
    assert.strictEqual(run({since: '2026-11-10T00:00:00Z'}, who).window.since, '2026-11-10T00:00:00.000Z');
    assert.strictEqual(run({}, who).window.since, null, 'no since: everything recorded');
    for (const bad of [{since: 'soon'}, {since: '2026-02-30'}, {groupBy: 'colour'}, {util: '2026-11-11'}]) {
      assert.throws(() => run(bad, who), /since|groupBy|argument/, JSON.stringify(bad));
    }
  });

  it('the token columns are an estimate that names its method, and the output validates against its closed schema', () => {
    const out = run({since: '2026-11-11'}, {caller: 'u_alice', isAdmin: false});
    assert.strictEqual(out.method, 'utf8 bytes / 4');
    for (const g of out.groups) assert.strictEqual(g.tokensInEst, Math.round(g.bytesIn / 4));
    const ajv = new Ajv2020({strict: false});
    assert.ok(ajv.validate(OUTPUT_SCHEMA, out), JSON.stringify(ajv.errors));
    assert.ok(!ajv.validate(OUTPUT_SCHEMA, {...out, extra: 1}), 'closed');
  });

  it('without a usage directory the report is the memory alone', () => {
    const out = usageReport({}, {caller: 'u_alice', isAdmin: false}, {usage: live(), usageDir: null, now: () => NOW});
    assert.deepStrictEqual(out.source, ['memory']);
    assert.strictEqual(out.totals.calls, 1);
  });
});

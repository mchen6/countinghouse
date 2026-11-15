// lib/usage (local-mode spec §5): the boundary counters, the usage files and
// the receipt. A tools/call begins a call; every server call made for it is an
// In record (recordIn, from the remote client), its result is one Out record
// (recordOut, from the gateway), and the receipt sums that call's In records.
// Records go to memory at once and to <usageDir>/<YYYY-MM-DD>/<pid>-<startMs>.jsonl.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createUsage, countText, receiptSentence} = require('../../lib/usage');

const day = (t) => t.slice(0, 10);

describe('usage: counters, files and the receipt', () => {
  let dir;
  let clock;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-')); clock = Date.parse('2026-11-11T10:00:00.000Z'); });
  afterEach(() => { fs.rmSync(dir, {recursive: true, force: true}); });
  const usage = (opts = {}) => createUsage({usageDir: dir, pid: 4242, startMs: 1794391200000, now: () => clock++, ...opts});

  it('counts bytes as UTF-8 and lines newline-separated, a trailing newline not a line', () => {
    assert.deepStrictEqual(countText(''), {bytes: 0, lines: 0});
    assert.deepStrictEqual(countText('a\nb'), {bytes: 3, lines: 2});
    assert.deepStrictEqual(countText('a\nb\n'), {bytes: 4, lines: 2});
    assert.deepStrictEqual(countText('é'), {bytes: 2, lines: 1});
  });

  it('a scenario call making N server calls gives N In records, one Out record and exact totals', () => {
    const u = usage();
    const call = u.beginCall({pack: 'ch-pack-ci-failure-triage', tool: 'ci_failure_triage', caller: 'u_local'});
    u.recordIn(call, {server: 'github', tool: 'actions_list', bytes: 8000, lines: 300, ms: 120, outcome: 'ok', credential: 'COUNTINGHOUSE_GITHUB_TOKEN'});
    u.recordIn(call, {server: 'github', tool: 'get_job_logs', bytes: 4000, lines: 100, ms: 90, outcome: 'ok', credential: 'COUNTINGHOUSE_GITHUB_TOKEN'});
    const receipt = u.recordOut(call, {tool: 'ci_failure_triage', bytes: 1200, lines: 30, ms: 900, outcome: 'ok'});
    assert.deepStrictEqual(receipt, {calls: 2, linesIn: 400, bytesIn: 12000, linesOut: 30, bytesOut: 1200, servers: ['github']});
    const records = u.records();
    assert.strictEqual(records.length, 3);
    assert.deepStrictEqual(records.map((r) => [r.call, r.server || null, r.tool]), [[call, 'github', 'actions_list'], [call, 'github', 'get_job_logs'], [call, null, 'ci_failure_triage']]);
    assert.deepStrictEqual(Object.keys(records[0]).sort(), ['bytesIn', 'call', 'caller', 'credential', 'linesIn', 'ms', 'outcome', 'server', 't', 'tool']);
    assert.deepStrictEqual(Object.keys(records[2]).sort(), ['bytesOut', 'call', 'caller', 'linesOut', 'ms', 'outcome', 'pack', 't', 'tool']);
    assert.strictEqual(records[2].pack, 'ch-pack-ci-failure-triage');
    assert.ok(records.every((r) => r.caller === 'u_local'));
  });

  it('every record is appended as it happens to <usageDir>/<day>/<pid>-<startMs>.jsonl', () => {
    const u = usage();
    const call = u.beginCall({pack: 'p', tool: 't', caller: 'u_1'});
    u.recordIn(call, {server: 'github', tool: 'x', bytes: 1, lines: 1, ms: 1, outcome: 'ok', credential: 'GITHUB_TOKEN'});
    const file = path.join(dir, day(new Date(Date.parse('2026-11-11T10:00:00Z')).toISOString()), '4242-1794391200000.jsonl');
    assert.strictEqual(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1, 'written before the call ends');
    u.recordOut(call, {tool: 't', bytes: 2, lines: 1, ms: 2, outcome: 'ok'});
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines, u.records());
  });

  it('a record never holds a credential value or content, only names and counts', () => {
    const u = usage();
    const call = u.beginCall({pack: 'p', tool: 't', caller: 'u_1'});
    u.recordIn(call, {server: 'github', tool: 'x', bytes: 1, lines: 1, ms: 1, outcome: 'ok', credential: 'GITHUB_TOKEN', value: 'ghp_secret', text: 'log line'});
    const text = JSON.stringify(u.records());
    assert.ok(!text.includes('ghp_secret') && !text.includes('log line'));
  });

  it('without a usageDir nothing is written, and the counters still count', () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1, now: () => clock++});
    const call = u.beginCall({pack: 'p', tool: 't', caller: 'u_1'});
    u.recordIn(call, {server: 'github', tool: 'x', bytes: 5, lines: 1, ms: 1, outcome: 'ok', credential: 'GITHUB_TOKEN'});
    assert.deepStrictEqual(u.totals(call), {calls: 1, linesIn: 1, bytesIn: 5, linesOut: 0, bytesOut: 0, servers: ['github']});
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });

  it('an In record for a call that was never begun is refused, not invented', () => {
    const u = usage();
    assert.throws(() => u.recordIn(999, {server: 'github', tool: 'x', bytes: 1, lines: 1, ms: 1, outcome: 'ok', credential: 'GITHUB_TOKEN'}), /no call 999/);
  });

  it('the receipt sentence: lines, size and calls per server, never "saved"', () => {
    assert.strictEqual(receiptSentence({calls: 14, linesIn: 48210, bytesIn: 3250586, linesOut: 35, bytesOut: 2458, servers: ['github']}, {github: 14}),
      'read 48,210 lines (3.1 MB) in 14 calls to github; 35 lines (2.4 KB) reached the model.');
    assert.strictEqual(receiptSentence({calls: 16, linesIn: 10, bytesIn: 100, linesOut: 1, bytesOut: 10, servers: ['github', 'linear']}, {github: 14, linear: 2}),
      'read 10 lines (100 B) in 14 calls to github and 2 to linear; 1 line (10 B) reached the model.');
    assert.strictEqual(receiptSentence({calls: 0, linesIn: 0, bytesIn: 0, linesOut: 3, bytesOut: 40, servers: []}, {}),
      'no server was called; 3 lines (40 B) reached the model.');
    assert.strictEqual(receiptSentence({calls: 1, linesIn: 1, bytesIn: 1, linesOut: 1, bytesOut: 1, servers: ['github']}, {github: 1}),
      'read 1 line (1 B) in 1 call to github; 1 line (1 B) reached the model.');
  });

  it('the receipt sentence matches the spec\'s form', () => {
    const u = usage();
    const call = u.beginCall({pack: 'p', tool: 't', caller: 'u_1'});
    u.recordIn(call, {server: 'github', tool: 'x', bytes: 3100000, lines: 48210, ms: 1, outcome: 'ok', credential: 'GITHUB_TOKEN'});
    u.recordOut(call, {tool: 't', bytes: 2400, lines: 35, ms: 1, outcome: 'ok'});
    assert.match(u.receiptSentenceOf(call), /^read [\d,]+ lines \([\d.]+ [KM]B\) in \d+ calls? to github; [\d,]+ lines? \([\d.]+ (KB|B)\) reached the model\.$/);
    assert.ok(!/saved/i.test(u.receiptSentenceOf(call)));
  });
});

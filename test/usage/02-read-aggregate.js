// lib/usage's reader, aggregation and formatting: ch-report's tests, moved with
// its code (local-mode spec §5), over the same fixture.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {writeUsageFixture, PACK, TOOL} = require('../helpers/usage-fixture');
const {readUsage} = require('../../lib/usage/read');
const {aggregate, ESTIMATE_METHOD} = require('../../lib/usage/aggregate');
const {formatText, formatCsv, CSV_HEADER} = require('../../lib/usage/format');

let home;
const test = it;
describe('usage: the reader, aggregation and formatting (from ch-report)', () => {
before(() => { home = writeUsageFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-fx-'))); });
after(() => fs.rmSync(home, {recursive: true, force: true}));

test('reads every file in the window and skips a truncated last line', () => {
  const all = readUsage(home, {});
  assert.strictEqual(all.length, 12); // 2 + 3 + 5 + 2, the truncated line skipped
  const windowed = readUsage(home, {since: '2026-11-10', until: '2026-11-10'});
  assert.deepStrictEqual(windowed.map((r) => r.call), [1, 1, 1]);
  assert.ok(windowed.every((r) => r.process === '1111-1794304800000'));
  assert.deepStrictEqual(readUsage(path.join(home, 'nowhere'), {}), []);
});

test('records keep only the fields that apply: absent counters are 0, an absent server is null', () => {
  const [inRecord, outRecord] = readUsage(home, {since: '2026-11-10', until: '2026-11-10'}).filter((_, i) => i !== 1);
  assert.strictEqual(inRecord.bytesOut, 0);
  assert.strictEqual(outRecord.server, null);
  assert.strictEqual(outRecord.bytesIn, 0);
});

test('a record is read by its own date, whatever day its directory is named for', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-report-tz-'));
  try {
    fs.mkdirSync(path.join(dir, '2026-11-12'), {recursive: true});
    fs.writeFileSync(path.join(dir, '2026-11-12', '9-1794450000000.jsonl'),
      `${JSON.stringify({t: '2026-11-11T16:00:00.000Z', call: 1, pack: 'p', tool: 't', bytesOut: 4, linesOut: 1, ms: 1, outcome: 'ok'})  }\n`);
    assert.strictEqual(readUsage(dir, {until: '2026-11-11'}).length, 1);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('aggregates per process, tool, server and pack with exact sums, server calls joined to their tool call', () => {
  const agg = aggregate(readUsage(home, {since: '2026-11-10'}));
  assert.deepStrictEqual(agg.totals, {calls: 4, serverCalls: 6, bytesIn: 18500, linesIn: 465, bytesOut: 2802, linesOut: 51, tokensInEst: 4625, tokensOutEst: 701});
  assert.deepStrictEqual(agg.processes.map((p) => [p.process, p.calls, p.serverCalls, p.bytesIn, p.bytesOut, p.first, p.last]), [
    ['1111-1794304800000', 1, 2, 12000, 1200, '2026-11-10T10:00:01.000Z', '2026-11-10T10:00:03.000Z'],
    ['2222-1794391200000', 2, 3, 6000, 1202, '2026-11-11T10:00:01.000Z', '2026-11-11T11:00:00.000Z'],
    ['3333-1794394800000', 1, 1, 500, 400, '2026-11-11T12:00:00.000Z', '2026-11-11T12:00:05.000Z']
  ]);
  assert.strictEqual(agg.processes[0].pid, 1111);
  assert.strictEqual(agg.processes[0].started, '2026-11-10T10:00:00.000Z');
  assert.deepStrictEqual(agg.byTool.map((t) => [t.pack, t.tool, t.calls, t.serverCalls, t.linesIn, t.linesOut]), [
    [PACK, TOOL, 3, 5, 460, 39],
    ['ch-report', 'usage_report', 1, 0, 0, 12],
    ['(unknown)', '(no result recorded)', 0, 1, 5, 0] // the call a stopped process never finished
  ]);
  assert.deepStrictEqual(agg.byServer, [{server: 'github', serverCalls: 6, bytesIn: 18500, linesIn: 465, tokensInEst: 4625, credentials: ['GITHUB_TOKEN'], tools: {actions_list: 2, get_job_logs: 4}}]);
  assert.deepStrictEqual(agg.byPack.map((p) => [p.pack, p.calls, p.serverCalls]), [[PACK, 3, 5], ['ch-report', 1, 0], ['(unknown)', 0, 1]]);
  assert.deepStrictEqual(agg.outcomes, {ok: 3, error: 1});
});

test('replaced counts one pack call as N server calls', () => {
  const agg = aggregate(readUsage(home, {since: '2026-11-10'}));
  assert.deepStrictEqual(agg.replaced, [{pack: PACK, tool: TOOL, packCalls: 3, serverCalls: 5}]);
});

test('token estimates are bytes/4 and every rendering carries the estimate label', () => {
  const agg = aggregate(readUsage(home, {}));
  assert.strictEqual(ESTIMATE_METHOD, 'utf8 bytes / 4');
  assert.strictEqual(agg.estimateMethod, ESTIMATE_METHOD);
  assert.strictEqual(agg.totals.tokensInEst, Math.round(agg.totals.bytesIn / 4));
  assert.match(formatText(agg), /tokens, estimate \(bytes\/4\)/);
  assert.ok(formatCsv(agg).startsWith(`${CSV_HEADER  }\n`));
  assert.match(CSV_HEADER, /tokens_in_est,tokens_out_est/);
});

test('csv has one row per tool with the fixed header', () => {
  const csv = formatCsv(aggregate(readUsage(home, {since: '2026-11-10'})));
  assert.strictEqual(CSV_HEADER, 'pack,tool,calls,server_calls,bytes_in,lines_in,bytes_out,lines_out,tokens_in_est,tokens_out_est');
  assert.deepStrictEqual(csv.split('\n'), [
    CSV_HEADER,
    `${PACK},${TOOL},3,5,18000,460,2400,39,4500,600`,
    'ch-report,usage_report,1,0,0,0,402,12,0,101',
    '(unknown),(no result recorded),0,1,500,5,0,0,125,0',
    ''
  ]);
  assert.strictEqual(formatCsv(aggregate([{t: '2026-11-11T00:00:00Z', call: 1, process: '1-1', pack: 'a,"b"', tool: 't', server: null, bytesIn: 0, linesIn: 0, bytesOut: 4, linesOut: 1, ms: 1, outcome: 'ok'}])).split('\n')[1],
    '"a,""b""",t,1,0,0,0,4,1,0,1');
});

test('text output states what pack calls stood for, per pack, tool, server and process, and never says saved', () => {
  const text = formatText(aggregate(readUsage(home, {since: '2026-11-10'})));
  assert.match(text, /^3 pack calls stood for 5 server calls; 4 tool calls in all, from 3 launcher process\(es\)\.$/m);
  assert.match(text, /read 465 lines \(18\.1 KB\) from servers; 51 lines \(2\.7 KB\) returned to the model/);
  for (const heading of ['by pack:', 'by tool:', 'by server:', 'by process:']) assert.ok(text.includes(heading), heading);
  assert.match(text, /ci_failure_triage: 3 calls stood for 5 server calls/);
  assert.doesNotMatch(text, /saved/i);
  assert.match(formatText(aggregate([])), /^no usage recorded/);
});

test('the current process\'s own file can be skipped: the report takes it from memory', () => {
  assert.strictEqual(readUsage(home, {skip: '1111-1794304800000'}).filter((r) => r.process === '1111-1794304800000').length, 0);
  assert.ok(readUsage(home, {}).some((r) => r.process === '1111-1794304800000'));
});

test('records keep their caller', () => {
  assert.deepStrictEqual([...new Set(readUsage(home, {}).map((r) => r.caller))].sort(), ['u_alice', 'u_bob']);
});
});

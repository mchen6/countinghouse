// The receipt on a tools/call result (local-mode spec §5, as amended by the
// reviewer, 2026-11-11): the Out record counts the module's own text content;
// a scenario's result gains _meta['countinghouse/receipt'] and the sentence as
// a second text block; structuredContent is never touched; a module output
// with a top-level `receipt` is refused RECEIPT_RESERVED.
const assert = require('assert');
const {createUsage} = require('../../lib/usage');
const {finishToolCall, receiptReserved} = require('../../lib/usage/receipt');

const result = (output) => ({isError: false, content: [{type: 'text', text: JSON.stringify(output)}], structuredContent: output});

describe('the receipt on a tools/call result', () => {
  let t;
  beforeEach(() => { t = Date.parse('2026-11-11T10:00:00Z'); });
  const usage = () => createUsage({usageDir: null, pid: 1, startMs: 1, now: () => t++});

  it('a scenario\'s result gains the receipt in _meta and its sentence, structuredContent unchanged', () => {
    const u = usage();
    const call = u.beginCall({pack: 'ch-pack-ci-failure-triage', tool: 'ci_failure_triage', caller: 'u_a'});
    for (let i = 0; i < 3; i++) u.recordIn(call, {server: 'github', module: 'ch-access-github', tool: 'get_job_logs', bytes: 1000, lines: 100, ms: 1, outcome: 'ok', credential: 'GITHUB_TOKEN'});
    const output = {summary: 'x', coverage: {logsFetched: 3}};
    const r = finishToolCall({usage: u, call, result: result(output), role: 'scenario', tool: 'ci_failure_triage', startedMs: t - 5, now: () => t});
    assert.deepStrictEqual(r.structuredContent, output);
    assert.strictEqual(r.content.length, 2);
    assert.strictEqual(r.content[0].text, JSON.stringify(output));
    assert.match(r.content[1].text, /^read 300 lines \(2\.9 KB\) in 3 calls to github; 1 line \(\d+ B\) reached the model\.$/);
    assert.deepStrictEqual(r._meta['countinghouse/receipt'], {calls: 3, linesIn: 300, bytesIn: 3000, linesOut: 1, bytesOut: Buffer.byteLength(JSON.stringify(output)), servers: ['github']});
  });

  it('the Out record counts the module\'s text only, not the sentence', () => {
    const u = usage();
    const call = u.beginCall({pack: 'p', tool: 't', caller: 'u_a'});
    const text = JSON.stringify({a: 'line1\nline2'});
    finishToolCall({usage: u, call, result: result({a: 'line1\nline2'}), role: 'scenario', tool: 't', startedMs: t, now: () => t});
    const out = u.records().find((r) => r.server === undefined || r.server === null);
    assert.deepStrictEqual([out.bytesOut, out.linesOut], [Buffer.byteLength(text), 1]);
  });

  it('a module that is not a scenario gets an Out record and no receipt', () => {
    const u = usage();
    const call = u.beginCall({pack: null, tool: 'plain_svc_go', caller: 'u_a'});
    const r = finishToolCall({usage: u, call, result: result({ok: true}), role: null, tool: 'plain_svc_go', startedMs: t, now: () => t});
    assert.strictEqual(r.content.length, 1);
    assert.ok(r._meta == null || !('countinghouse/receipt' in r._meta));
    assert.strictEqual(u.records().length, 1);
  });

  it('an error result is counted with outcome error, keeps its code, and gets no receipt', () => {
    const u = usage();
    const call = u.beginCall({pack: 'p', tool: 't', caller: 'u_a'});
    const err = {isError: true, content: [{type: 'text', text: 'it broke'}], _meta: {'countinghouse/code': 'X'}};
    const r = finishToolCall({usage: u, call, result: err, role: 'scenario', tool: 't', startedMs: t, now: () => t});
    assert.deepStrictEqual(r._meta, {'countinghouse/code': 'X'});
    assert.strictEqual(r.content.length, 1);
    assert.strictEqual(u.records()[0].outcome, 'error');
  });

  it('a module output with a top-level receipt is reserved', () => {
    assert.strictEqual(receiptReserved({output: {receipt: {calls: 1}}}), true);
    assert.strictEqual(receiptReserved({output: {summary: 'x', coverage: {receipt: 1}}}), false, 'only the top level is the runtime\'s');
    assert.strictEqual(receiptReserved({output: 'text'}), false);
    assert.strictEqual(receiptReserved(null), false);
  });

  it('with no call (counting unavailable) the result passes through unchanged', () => {
    const r = result({a: 1});
    assert.strictEqual(finishToolCall({usage: usage(), call: null, result: r, role: 'scenario', tool: 't', startedMs: t, now: () => t}), r);
  });
});

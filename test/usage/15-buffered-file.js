// lib/usage's file writes, off the call path (the per-call latency work,
// 2026-11-15, (a)): a record is in memory at once, as before, so receipts,
// ctx.usage() and this process's report are exact at once. Its line reaches
// <usageDir>/<day>/<pid>-<startMs>.jsonl from a bounded buffer, flushed:
// - after flushRecords records or flushBytes bytes (whichever first);
// - flushMs after the first record not yet written;
// - when a record's day differs from the open file's (before switching);
// - by flush(), and at process exit (a clean stop loses nothing).
// A crash (SIGKILL, a native abort) can lose what is in the buffer: at most
// flushRecords records or flushMs of them. Billing is not here (metering
// records each call itself), so it is unchanged.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {createUsage} = require('../../lib/usage');

const linesOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('usage 15: file writes off the call path, bounded and flushed', () => {
  let dir;
  let clock;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-buf-')); clock = Date.parse('2026-11-11T10:00:00.000Z'); });
  afterEach(() => { fs.rmSync(dir, {recursive: true, force: true}); });
  const fileOn = (d) => path.join(dir, d, '7-1.jsonl');
  const usage = (opts = {}) => createUsage({usageDir: dir, pid: 7, startMs: 1, now: () => clock++, ...opts});
  const one = (u, n = 0) => { const c = u.beginCall({pack: 'p', tool: 't', caller: 'u_1'}); return u.recordOut(c, {tool: `t${n}`, bytes: 1, lines: 1, ms: 1, outcome: 'ok'}); };

  it('a record is in memory and its receipt exact at once; its line waits for a trigger', () => {
    const u = usage({flushMs: 60000});
    const receipt = one(u);
    assert.deepStrictEqual(receipt, {calls: 0, linesIn: 0, bytesIn: 0, linesOut: 1, bytesOut: 1, servers: []});
    assert.strictEqual(u.records().length, 1);
    assert.deepStrictEqual(linesOf(fileOn('2026-11-11')), [], 'written on the call path');
    u.flush();
    assert.deepStrictEqual(linesOf(fileOn('2026-11-11')), u.records());
  });

  it('is written flushMs after the first unwritten record', async () => {
    const u = usage({flushMs: 30});
    one(u, 1);
    one(u, 2);
    assert.strictEqual(linesOf(fileOn('2026-11-11')).length, 0);
    await new Promise((r) => setTimeout(r, 120));
    assert.deepStrictEqual(linesOf(fileOn('2026-11-11')).map((r) => r.tool), ['t1', 't2']);
  });

  it('is written at once when the buffer reaches flushRecords or flushBytes', () => {
    const u = usage({flushMs: 60000, flushRecords: 3});
    one(u, 1); one(u, 2);
    assert.strictEqual(linesOf(fileOn('2026-11-11')).length, 0);
    one(u, 3);
    assert.deepStrictEqual(linesOf(fileOn('2026-11-11')).map((r) => r.tool), ['t1', 't2', 't3'], 'the record bound did not flush');
    const v = createUsage({usageDir: dir, pid: 8, startMs: 1, now: () => clock++, flushMs: 60000, flushBytes: 200});
    one(v, 4); one(v, 5);
    assert.ok(linesOf(path.join(dir, '2026-11-11', '8-1.jsonl')).length >= 1, 'the byte bound did not flush');
  });

  it('keeps each record in its own day\'s file across a day change', () => {
    clock = Date.parse('2026-11-11T23:59:59.999Z');
    const u = usage({flushMs: 60000});
    one(u, 1);
    clock = Date.parse('2026-11-12T00:00:01.000Z');
    one(u, 2);
    u.flush();
    assert.deepStrictEqual(linesOf(fileOn('2026-11-11')).map((r) => r.tool), ['t1']);
    assert.deepStrictEqual(linesOf(fileOn('2026-11-12')).map((r) => r.tool), ['t2']);
  });

  it('loses nothing at a clean exit', () => {
    const lib = path.join(__dirname, '..', '..', 'lib', 'usage');
    const code = `const {createUsage} = require(${JSON.stringify(lib)});
      const u = createUsage({usageDir: ${JSON.stringify(dir)}, pid: 9, startMs: 1, flushMs: 600000});
      for (let i = 0; i < 5; i++) { const c = u.beginCall({tool: 't'}); u.recordOut(c, {tool: 't' + i, bytes: 1, lines: 1, ms: 1, outcome: 'ok'}); }
      process.exit(0);`;
    const r = spawnSync(process.execPath, ['-e', code], {encoding: 'utf8'});
    assert.strictEqual(r.status, 0, r.stderr);
    const days = fs.readdirSync(dir);
    const all = days.flatMap((d) => linesOf(path.join(dir, d, '9-1.jsonl')));
    assert.deepStrictEqual(all.map((x) => x.tool), ['t0', 't1', 't2', 't3', 't4'], 'records lost at exit');
  });
  it('a report reading this process\'s own file flushes it first, so it misses no call', async () => {
    const {usageReport} = require('../../lib/usage/report');
    const u = usage({flushMs: 600000});
    for (let i = 0; i < 3; i++) one(u, i);
    assert.strictEqual(linesOf(fileOn('2026-11-11')).length, 0);
    const out = await usageReport({}, {caller: 'u_1', isAdmin: false}, {usage: u, usageDir: dir, now: () => Date.parse('2026-11-11T12:00:00Z')});
    assert.deepStrictEqual(out.source, ['files']);
    assert.strictEqual(out.totals.calls, 3, 'the report missed calls still in the buffer');
  });
});

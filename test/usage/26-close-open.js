'use strict';
// B-shutdown-usage: a call begun is always ended in the record. At exit the
// runtime closes every call still open -- a task's pass a runner dropped, a
// direct tools/call still running -- as a cancelled one (lib/usage/index.js
// closeOpen): nothing sent, its time so far. And the runtime's exit sequence
// (lib/exit-sequence.js) runs before the local store's exit flush, so what it
// writes there reaches disk.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const {createUsage} = require('../../lib/usage');
const tmp = require('../helpers/test-tmp').forFile(['ch-usage-26-']);

const {readUsage} = require('../../lib/usage/read');
// the records as the report reads them
const recordsUnder = (dir) => readUsage(dir);

describe('usage 26: every open call is closed at exit, cancelled (B-shutdown-usage)', () => {
  it('closeOpen writes a cancelled Out record for each open call, with its time so far and nothing sent; none for a finished call; once', () => {
    const dir = tmp.mkdtemp('ch-usage-26-');
    let t = Date.parse('2026-11-20T12:00:00Z');
    const u = createUsage({usageDir: dir, pid: 1, startMs: 1, now: () => t});
    const a = u.beginCall({scenario: null, module: 'm', tool: 'slow_a', caller: 'c1'});
    t += 200;
    const b = u.beginCall({scenario: 'p', module: 'm', tool: 'slow_b', caller: 'c2', session: 's1'});
    const done = u.beginCall({module: 'm', tool: 'quick', caller: 'c1'});
    u.recordOut(done, {tool: 'quick', bytes: 3, ms: 1, outcome: 'ok'});
    t += 300;
    assert.strictEqual(u.closeOpen(), 2);
    assert.strictEqual(u.inFlight(), 0);
    const outs = recordsUnder(dir).filter((r) => r.outcome != null && r.bytesOut !== undefined);
    const byCall = new Map(outs.map((r) => [r.call, r]));
    assert.deepStrictEqual([byCall.get(a).outcome, byCall.get(a).ms, byCall.get(a).bytesOut, byCall.get(a).tool], ['cancelled', 500, 0, 'slow_a']);
    assert.deepStrictEqual([byCall.get(b).outcome, byCall.get(b).ms, byCall.get(b).session, byCall.get(b).caller], ['cancelled', 300, 's1', 'c2']);
    assert.strictEqual(byCall.get(b).code, undefined, 'a cancelled call carries no error code');
    assert.strictEqual(byCall.get(done).outcome, 'ok');
    assert.strictEqual(u.closeOpen(), 0, 'nothing left open');
    assert.strictEqual(recordsUnder(dir).length, 3);
  });

  // the runtime's own chain (framework.js): the store's exit flush, the
  // monitor's signal handling and the exit sequence, registered in any
  // order, and a SIGTERM through them all
  for (const order of [['sequence', 'flush', 'monitor'], ['flush', 'monitor', 'sequence'], ['monitor', 'flush', 'sequence']]) {
    it(`the exit sequence runs before the local store's exit flush, a SIGTERM through the monitor: what it writes reaches disk (${order.join(', ')})`, () => {
      const dir = tmp.mkdtemp('ch-usage-26-');
      const file = path.join(dir, 'm.json');
      const ROOT = path.resolve(__dirname, '..', '..');
      const run = spawnSync(process.execPath, ['-e', `
        const {openJsonFile, flushAllOnExit} = require(${JSON.stringify(path.join(ROOT, 'lib/store/json-file'))});
        const exitSequence = require(${JSON.stringify(path.join(ROOT, 'lib/exit-sequence'))});
        const map = openJsonFile(${JSON.stringify(file)}, {debounceMs: 60000});
        const steps = {
          sequence: () => exitSequence.atExit(() => map.set('late', 'written at exit')),
          flush: () => flushAllOnExit(),
          monitor: () => require(${JSON.stringify(path.join(ROOT, 'lib/monitor'))}).init()
        };
        for (const name of ${JSON.stringify(order)}) steps[name]();
        process.kill(process.pid, 'SIGTERM');
        setTimeout(() => {}, 5000);
      `], {encoding: 'utf8', timeout: 20000});
      assert.deepStrictEqual([run.status, run.signal], [143, null], run.stderr);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {late: 'written at exit'});
    });
  }

  it('a call whose failure was noted while its record was being written is recorded as that failure, not a cancel', () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1});
    const {taskHooks} = require('../../lib/usage/task');
    const hooks = taskHooks({usage: () => u, targetFor: () => ({name: 'slow', role: 'tool', module: 'm'}),
      buildResult: (err) => (err != null ? {content: [{type: 'text', text: err.message}], isError: true, _meta: {'countinghouse/code': err.code}} : {content: []})});
    const failing = hooks.start({ownerId: 'u_c1'});
    const plain = hooks.start({ownerId: 'u_c1'});
    hooks.failed({extra: failing}, Object.assign(new Error('timed out'), {code: 'JOB_TIMEOUT'}));
    assert.strictEqual(u.closeOpen(hooks.outcomeOf), 2);
    const outs = u.records().filter((r) => r.bytesOut !== undefined);
    assert.deepStrictEqual(outs.map((r) => [r.call, r.outcome, r.code]).sort(), [[failing.usageCall, 'error', 'JOB_TIMEOUT'], [plain.usageCall, 'cancelled', undefined]].sort());
  });

  // (the high review of #488, 1 and 3) a pass that settled -- answered and
  // charged, or failed -- while its record was still being written is
  // recorded at a stop as it settled: its answer's bytes, its error's code,
  // whose fault as the result says (the one reading, outFieldsOf)
  const {RESULT_KIND} = require('../../lib/countinghouse-error');
  // (as the gateway's: an error result marked the caller's fault only when
  // a module said so -- toolCallResult's origin rule)
  const buildResult = (err, results) => {
    if (err == null) return {content: [{type: 'text', text: JSON.stringify(results)}]};
    const r = {content: [{type: 'text', text: `failed: ${err.message}`}], isError: true, _meta: {'countinghouse/code': err.code}};
    if (err.origin === 'module' && err.kind === 'caller') Object.defineProperty(r, RESULT_KIND, {value: 'caller', enumerable: false});
    return r;
  };
  const settledHooks = (u) => require('../../lib/usage/task').taskHooks({usage: () => u, targetFor: () => ({name: 'slow', role: 'tool', module: 'm'}), buildResult});

  it('an answered pass still being written is recorded with its answer, not as a cancel; cancel() records it the same', () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1});
    const hooks = settledHooks(u);
    const a = hooks.start({ownerId: 'u_k'});
    const b = hooks.start({ownerId: 'u_k'});
    hooks.answered({extra: a}, {n: 12345});
    hooks.answered({extra: b}, {n: 1});
    hooks.cancel({}, {extra: b});
    assert.strictEqual(u.closeOpen(hooks.outcomeOf), 1);
    const byCall = new Map(u.records().filter((r) => r.bytesOut !== undefined).map((r) => [r.call, r]));
    assert.deepStrictEqual([byCall.get(a.usageCall).outcome, byCall.get(a.usageCall).bytesOut], ['ok', JSON.stringify({n: 12345}).length]);
    assert.deepStrictEqual([byCall.get(b.usageCall).outcome, byCall.get(b.usageCall).bytesOut], ['ok', JSON.stringify({n: 1}).length]);
  });

  it('a failed pass still being written: its code, its bytes, and the caller\'s fault only when a module said so', () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1});
    const hooks = settledHooks(u);
    const byModule = hooks.start({ownerId: 'u_k'});
    const notModule = hooks.start({ownerId: 'u_k'});
    hooks.failed({extra: byModule}, Object.assign(new Error('bad input'), {code: 'X_BAD_INPUT', kind: 'caller', origin: 'module'}));
    hooks.failed({extra: notModule}, Object.assign(new Error('bad input'), {code: 'X_BAD_INPUT', kind: 'caller'}));
    assert.strictEqual(u.closeOpen(hooks.outcomeOf), 2);
    const byCall = new Map(u.records().filter((r) => r.bytesOut !== undefined).map((r) => [r.call, r]));
    assert.deepStrictEqual([byCall.get(byModule.usageCall).outcome, byCall.get(byModule.usageCall).code], ['error', 'CALLER_ERROR']);
    assert.deepStrictEqual([byCall.get(notModule.usageCall).outcome, byCall.get(notModule.usageCall).code], ['error', 'MODULE_ERROR']);
    assert.ok(byCall.get(byModule.usageCall).bytesOut > 0, 'the error\'s text counted');
  });

  // (the medium on #488's round 1) a task this process cancelled is
  // recorded cancelled at a stop, though its tombstone was not yet read
  it('a settled pass whose task this process cancelled is recorded cancelled, with what it sent', () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1});
    const hooks = require('../../lib/usage/task').taskHooks({usage: () => u, targetFor: () => ({name: 'slow', role: 'tool', module: 'm'}), buildResult,
      cancelledNow: (jobId) => jobId === 'task-7'});
    const cancelled = hooks.start({ownerId: 'u_k'});
    const kept = hooks.start({ownerId: 'u_k'});
    hooks.answered({extra: cancelled, jobId: 'task-7'}, {n: 7});
    hooks.failed({extra: kept, jobId: 'task-8'}, Object.assign(new Error('x'), {code: 'JOB_TIMEOUT'}));
    assert.strictEqual(u.closeOpen(hooks.outcomeOf), 2);
    const byCall = new Map(u.records().filter((r) => r.bytesOut !== undefined).map((r) => [r.call, r]));
    assert.deepStrictEqual([byCall.get(cancelled.usageCall).outcome, byCall.get(cancelled.usageCall).bytesOut], ['cancelled', JSON.stringify({n: 7}).length]);
    assert.deepStrictEqual([byCall.get(kept.usageCall).outcome, byCall.get(kept.usageCall).code], ['error', 'JOB_TIMEOUT']);
  });

  it('this process\'s cancels are known at once (lib/task-tombstones.js), before the store has the tombstone', () => {
    const tombstones = require('../../lib/task-tombstones');
    assert.strictEqual(tombstones.cancelledByThisProcess('t-usage-26'), false);
    tombstones.put('t-usage-26', {owner: 'o', createdAt: 'x'}, 1000).catch(() => undefined);
    assert.strictEqual(tombstones.cancelledByThisProcess('t-usage-26'), true);
  });

  // (the medium on #488's round 1) a pass recorded while its values were
  // being stored: as its placement will send them (the planned placement)
  it('a settled pass noted with its planned placement is recorded with its linked bytes', () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1});
    const placedBuild = (err, results, placed) => (placed != null && placed.uris.big != null
      ? {content: [{type: 'text', text: 'small'}, {type: 'resource_link', uri: placed.uris.big, name: 'big', size: 5000}]}
      : {content: [{type: 'text', text: JSON.stringify(results)}]});
    const hooks = require('../../lib/usage/task').taskHooks({usage: () => u, targetFor: () => ({name: 'slow', role: 'tool', module: 'm'}), buildResult: placedBuild});
    const a = hooks.start({ownerId: 'u_k'});
    hooks.answered({extra: a}, {big: 'x'.repeat(5000)});
    hooks.answered({extra: a}, {big: 'x'.repeat(5000)}, {raw: {}, uris: {big: 'countinghouse://pending'}, error: null, entries: null});
    u.closeOpen(hooks.outcomeOf);
    const out = u.records().find((r) => r.call === a.usageCall);
    assert.deepStrictEqual([out.outcome, out.bytesOut, out.linkedBytesOut], ['ok', 5, 5000]);
  });

  it('one call that cannot be recorded leaves the rest to be', () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1});
    const calls = [1, 2, 3].map((i) => u.beginCall({module: 'm', tool: `t${i}`, caller: 'c'}));
    let n = 0;
    assert.strictEqual(u.closeOpen(() => { if (++n === 1) throw new Error('broken'); return null; }), 2);
    assert.strictEqual(u.inFlight(), 0);
    assert.deepStrictEqual(u.records().map((r) => r.call), calls.slice(1));
  });

  tmp.hooks();
});

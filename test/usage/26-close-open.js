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

const recordsUnder = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, {withFileTypes: true})) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(...fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    }
  };
  walk(dir);
  return out;
};

describe('usage 26: every open call is closed at exit, cancelled (B-shutdown-usage)', () => {
  it('closeOpen writes a cancelled Out record for each open call, with its time so far and nothing sent; none for a finished call; once', () => {
    const dir = tmp.mkdtemp('ch-usage-26-');
    let t = Date.parse('2026-11-20T12:00:00Z');
    const u = createUsage({usageDir: dir, pid: 1, startMs: 1, now: () => t});
    const a = u.beginCall({scenario: null, module: 'm', tool: 'slow_a', caller: 'c1'});
    t += 200;
    const b = u.beginCall({scenario: 'p', module: 'm', tool: 'slow_b', caller: 'c2', session: 's1'});
    const done = u.beginCall({module: 'm', tool: 'quick', caller: 'c1'});
    u.recordOut(done, {tool: 'quick', bytes: 3, lines: 1, ms: 1, outcome: 'ok'});
    t += 300;
    assert.strictEqual(u.closeOpen(), 2);
    assert.strictEqual(u.inFlight(), 0);
    const outs = recordsUnder(dir).filter((r) => r.outcome != null && r.bytesOut !== undefined);
    const byCall = new Map(outs.map((r) => [r.call, r]));
    assert.deepStrictEqual([byCall.get(a).outcome, byCall.get(a).ms, byCall.get(a).bytesOut, byCall.get(a).linesOut, byCall.get(a).tool], ['cancelled', 500, 0, 0, 'slow_a']);
    assert.deepStrictEqual([byCall.get(b).outcome, byCall.get(b).ms, byCall.get(b).session, byCall.get(b).caller], ['cancelled', 300, 's1', 'c2']);
    assert.strictEqual(byCall.get(b).code, undefined, 'a cancelled call carries no error code');
    assert.strictEqual(byCall.get(done).outcome, 'ok');
    assert.strictEqual(u.closeOpen(), 0, 'nothing left open');
    assert.strictEqual(recordsUnder(dir).length, 3);
  });

  it('the exit sequence runs before the local store\'s exit flush: what it writes reaches disk', () => {
    const dir = tmp.mkdtemp('ch-usage-26-');
    const file = path.join(dir, 'm.json');
    const ROOT = path.resolve(__dirname, '..', '..');
    const run = spawnSync(process.execPath, ['-e', `
      const {openJsonFile, flushAllOnExit} = require(${JSON.stringify(path.join(ROOT, 'lib/store/json-file'))});
      const map = openJsonFile(${JSON.stringify(file)}, {debounceMs: 60000});
      flushAllOnExit();
      require(${JSON.stringify(path.join(ROOT, 'lib/exit-sequence'))}).atExit(() => map.set('late', 'written at exit'));
      process.exit(0);
    `], {encoding: 'utf8', timeout: 20000});
    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {late: 'written at exit'});
  });

  tmp.hooks();
});

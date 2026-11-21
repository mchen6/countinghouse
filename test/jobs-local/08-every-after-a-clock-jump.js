'use strict';
// The local runner's `every` scheduler when the wall clock jumps ahead (a
// suspend, a VM paused and resumed): the next run was the last one's time plus
// `every`, so each slot the jump passed was due at once, and a minute's jump
// on a 1 s scheduler ran it about 60 times in a burst. Now the next run is the
// first slot that isn't in the past: one run after the jump, then the
// schedule as before (the final pass's gateway part, A10).
// In a child process, its Date.now moved ahead by the test (the runner reads
// the wall clock there), waiting on the runs themselves, each wait bounded.
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');

const LIB = path.join(__dirname, '..', '..', 'lib');

describe('jobs-local 08: an `every` scheduler after the wall clock jumps ahead (A10)', function() {
  this.timeout(60000);

  it('a minute\'s jump on a 1 s scheduler is one catch-up run, never a burst of the missed slots', () => {
    const script = `
      const options = require(${JSON.stringify(path.join(LIB, 'cli-options'))});
      options.workerThread = true;
      const {createRunner} = require(${JSON.stringify(path.join(LIB, 'job-control-local'))});
      const runner = createRunner({resultTtlMs: 0});
      let runs = 0;
      runner.initJobProcess({invokeJobs: (d, s, a, input, id, cb) => { runs += 1; setImmediate(() => cb(null, {output: 1})); }, recordCall: (k, t, c, cb) => cb(null)});
      const realNow = Date.now;
      let skew = 0;
      Date.now = () => realNow() + skew;
      const until = async (ok, ms) => { const t0 = realNow(); while (!ok() && realNow() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return ok(); };
      runner.addJob(runner.INTERNAL, {name: 'tick', repeat: {every: 1000}}, 'dev', 'svc', 'act', {}, async (err) => {
        if (err) { process.stdout.write('OUT ' + JSON.stringify({addErr: err.message}) + '\\n'); process.exit(0); }
        await until(() => runs >= 1, 5000);
        const before = runs;
        skew = 60 * 1000;
        // the first run after the jump, then what else ran within a quarter of
        // the period (a burst of the missed slots runs within milliseconds)
        const caughtUp = await until(() => runs > before, 5000);
        const at = runs;
        await new Promise((r) => setTimeout(r, 250));
        runner.close();
        process.stdout.write('OUT ' + JSON.stringify({caughtUp, afterJump: at - before, withinQuarter: runs - at}) + '\\n');
        process.exit(0);
      });`;
    const r = spawnSync(process.execPath, ['-e', script], {cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 40000});
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('OUT '));
    assert.ok(line != null, `no output: ${r.stdout} ${r.stderr}`);
    const out = JSON.parse(line.slice(4));
    assert.deepStrictEqual(out, {caughtUp: true, afterJump: 1, withinQuarter: 0}, JSON.stringify(out));
  });
});

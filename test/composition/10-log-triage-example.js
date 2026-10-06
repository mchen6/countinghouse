// examples/log-triage, end to end. The example's own verification script is
// the test: it boots a real non-debug server on each hop path (ports 9596 and
// 9597) and asserts the bill. Run from the suite so the example cannot rot
// silently -- and because it is the only place in the suite where ctx.call
// hops run concurrently against real metering, on both paths.
const assert    = require('assert');
const path      = require('path');
const spawnSync = require('child_process').spawnSync;

describe('composition 10: the log-triage example bills 2N + 3 for N files, on both hop paths', function() {
  this.timeout(240000);

  it('examples/log-triage/verify-cost-bound.js exits 0', () => {
    const script = path.join(__dirname, '..', '..', 'examples', 'log-triage', 'verify-cost-bound.js');
    const run    = spawnSync(process.execPath, [script], {encoding: 'utf8', timeout: 220000});

    assert.strictEqual(run.status, 0, `verify-cost-bound.js failed:\n${run.stdout}\n${run.stderr}`);
  });
});

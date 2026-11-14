// Lean worker step 5: the measurement harness (perf/lean-worker-perf.js)
// still reads every metric from the server's own log lines and /proc, so a
// change to those lines shows here, not in a later measurement. Its
// --self-check: the bundled pre-installed packages, once. Linux only (the
// harness reads /proc).
const assert = require('assert');
const fs = require('fs');

const linux = fs.existsSync('/proc/self/status');

(linux ? describe : describe.skip)('module-loading 28: the lean worker\'s measurement harness reads every metric', function() {
  this.timeout(180000);

  it('--self-check: ready, RSS, worker boot and the spawn walk, and the RSS slope', async () => {
    const harness = require('../../perf/lean-worker-perf');
    const result = await harness.main(['--self-check']);
    assert.ok(result.targets.packReadyMs > 0, JSON.stringify(result.targets));
    assert.ok(result.targets.workerBootMedianMs > 0, JSON.stringify(result.targets));
    assert.ok(result.targets.spawnWalkMedianMs >= 0, JSON.stringify(result.targets));
    assert.ok(result.targets.addedRssPerWorkerMb != null, JSON.stringify(result.targets));
  });

  it('the least-squares slope and the median', () => {
    const {slope, median} = require('../../perf/lean-worker-perf');
    assert.ok(Math.abs(slope([[0, 100], [1, 120], [3, 160]]) - 20) < 1e-9);
    assert.strictEqual(slope([[1, 5]]), null);
    assert.strictEqual(median([3, 1, 2]), 2);
    assert.strictEqual(median([4, 1, 3, 2]), 2.5);
  });
});

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
    assert.ok(result.targets.fixedRssMb != null, JSON.stringify(result.targets));
    assert.ok(result.targets.addedRssPerWorkerThroughZeroMb != null, JSON.stringify(result.targets));
    assert.match(result.rssMethod, /1\.\.N workers/);
  });

  // The per-worker slope is fitted over 1..N workers; what the first worker
  // brings once (the validator pool, main's share) is its own number, the
  // fit's intercept above the 0-module RSS. The old slope, through the
  // 0-module row, is kept for comparison with earlier tables.
  it('the RSS fit: a per-worker slope over 1..N workers, the fixed cost beside it, and the old slope through 0', () => {
    const {rssFit, fit: fitOf} = require('../../perf/lean-worker-perf');
    // 100 MB with no module; 40 MB once with the first worker; 20 MB per worker
    const f = rssFit([0, 100], [[1, 160], [3, 200], [5, 240]]);
    assert.ok(Math.abs(f.perWorkerMb - 20) < 1e-9, JSON.stringify(f));
    assert.ok(Math.abs(f.fixedMb - 40) < 1e-9, JSON.stringify(f));
    assert.ok(Math.abs(f.throughZeroMb - 385 / 14.75) < 1e-9, JSON.stringify(f));
    // one configuration with modules fits no slope, and so no fixed cost
    assert.deepStrictEqual(rssFit([0, 100], [[1, 160]]), {perWorkerMb: null, fixedMb: null, throughZeroMb: 60});
    // the baseline is the no-module configuration, whatever a modules row measured:
    // a row whose module failed to load (0 workers) stays a modules row
    const g = rssFit([0, 100], [[0, 101], [1, 160], [3, 200]]);
    assert.ok(Math.abs(g.fixedMb - (fitOf([[0, 101], [1, 160], [3, 200]]).intercept - 100)) < 1e-9, JSON.stringify(g));
  });

  it('the least-squares slope and the median', () => {
    const {slope, median} = require('../../perf/lean-worker-perf');
    assert.ok(Math.abs(slope([[0, 100], [1, 120], [3, 160]]) - 20) < 1e-9);
    assert.strictEqual(slope([[1, 5]]), null);
    assert.strictEqual(median([3, 1, 2]), 2);
    assert.strictEqual(median([4, 1, 3, 2]), 2.5);
  });
});

// Cross-worker call benchmark: main-thread-routed (--directPeerChannels off,
// the default) vs direct peer channel (--directPeerChannels on). See
// docs/direct-peer-channels-design.md section 4 and docs/direct-peer-channels.md
// for the results this produces and how to read them.
//
// Drives HTTP load against pre-installed-packages/perf-caller-demo's `run`
// action, which round-trips a payload of the requested size through
// perf-callee-demo via ServiceClient.invoke -- the exact isRemoteThread
// path lib/service-client.js branches on the flag for. Each response
// includes `durationMs`, measured server-side around just the
// ServiceClient.invoke call (excludes this script's own HTTP/network
// overhead, and this action's own session/routing overhead on either
// side of that call) -- that is the number this script reports as
// "hop latency". Throughput is measured client-side (wall-clock time for
// N requests at a given concurrency), which *does* include full HTTP
// overhead, but that overhead is identical in both conditions, so it
// doesn't distort the relative comparison between them.
//
// Usage: node perf/direct-peer-channels-perf.js
// Starts and stops its own server for each condition; takes several
// minutes for the full 2 x 3 x 3 matrix (conditions x payload sizes x
// concurrency levels). Writes results as JSON to stdout at the end (also
// printed as a table) -- docs/direct-peer-channels.md's numbers come from
// a run of this script.

var cp = require('child_process');
var path = require('path');

var PORT = 18500;
var BASE_URL = 'http://127.0.0.1:' + PORT;
var CALLER_DEVICE_ID = '13793b1a-132d-5a03-a46b-2e0bb72d0d82'; // perf-caller-demo, computed offline via UUID.v5

var PAYLOAD_SIZES = [1024, 102400, 1048576]; // 1KB, 100KB, 1MB
var CONCURRENCY_LEVELS = [1, 16, 64];
var REQUESTS_PER_COMBINATION = 150;

function startServer(directPeerChannels) {
  return new Promise(function(resolve, reject) {
    var args = [
      './framework.js',
      '--workerThread', '--debug',
      '--bindAddr', '127.0.0.1',
      '--port', String(PORT),
      '--loadModule', './pre-installed-packages/perf-callee-demo',
      '--loadModule', './pre-installed-packages/perf-caller-demo'
    ];
    if (directPeerChannels === true) args.push('--directPeerChannels');

    var child = cp.spawn('node', args, {cwd: path.resolve(__dirname, '..'), stdio: 'ignore'});
    child.on('error', reject);

    // module discovery is a fixed ~5s per module (sandbox.js's
    // 'discover-device' handling) -- 2 modules loaded sequentially, plus
    // startup itself, so this is a generous fixed wait rather than a poll
    // loop, matching the rest of this codebase's test/perf conventions.
    setTimeout(function() { resolve(child); }, 13000);
  });
}

function stopServer(child) {
  return fetch(BASE_URL + '/shutdown', {method: 'POST'}).catch(function() {}).then(function() {
    return new Promise(function(resolve) {
      child.on('exit', resolve);
      setTimeout(function() { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 3000);
    });
  });
}

function invoke(payloadSizeBytes) {
  var t0 = Date.now();
  return fetch(BASE_URL + '/devices/' + CALLER_DEVICE_ID + '/invoke-action', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-CH-Key': 'perf'},
    body: JSON.stringify({
      serviceID: 'urn:countinghouse-com:serviceID:perfCallerService',
      actionName: 'run',
      input: {payloadSizeBytes: payloadSizeBytes}
    })
  }).then(function(res) { return res.json(); }).then(function(body) {
    return {wallMs: Date.now() - t0, hopMs: body.output != null ? body.output.durationMs : null, error: body.output == null ? body : null};
  });
}

function percentile(sorted, p) {
  var idx = Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length));
  return sorted[idx];
}

// runs `total` requests at the given concurrency (a fixed-size pool of
// in-flight requests, each starting a new one as soon as one completes --
// not `total` requests fired in lockstep batches).
function runLoad(payloadSizeBytes, concurrency, total) {
  return new Promise(function(resolve, reject) {
    var results = [];
    var errors = 0;
    var started = 0;
    var completed = 0;
    var wallStart = Date.now();

    function next() {
      if (started >= total) return;
      started++;
      invoke(payloadSizeBytes).then(function(r) {
        if (r.error != null) errors++;
        results.push(r);
        completed++;
        if (completed >= total) {
          var totalWallMs = Date.now() - wallStart;
          var hopLatencies = results.filter(function(r) { return r.hopMs != null; }).map(function(r) { return r.hopMs; }).sort(function(a, b) { return a - b; });
          return resolve({
            errors: errors,
            throughputRps: (total / totalWallMs) * 1000,
            hopP50: percentile(hopLatencies, 50),
            hopP99: percentile(hopLatencies, 99),
            hopMean: hopLatencies.reduce(function(a, b) { return a + b; }, 0) / hopLatencies.length
          });
        }
        next();
      }).catch(reject);
    }

    for (var i = 0; i < Math.min(concurrency, total); i++) next();
  });
}

async function benchmarkCondition(directPeerChannels) {
  var label = directPeerChannels === true ? 'directPeerChannels' : 'mainThreadRouted';
  console.error('\n=== ' + label + ' ===');
  var child = await startServer(directPeerChannels);

  var results = {};
  try {
    // warm up the channel (and, for the flag-off case, the worker pair in
    // general) with a couple of throwaway calls before measuring -- the
    // matrix below is about steady-state behavior, not cold-start cost
    // (D1's brokering cost on the very first call is a separate, one-time
    // thing, not what this table is measuring).
    await invoke(1024);
    await invoke(1024);

    for (var s = 0; s < PAYLOAD_SIZES.length; s++) {
      for (var c = 0; c < CONCURRENCY_LEVELS.length; c++) {
        var payloadSizeBytes = PAYLOAD_SIZES[s];
        var concurrency = CONCURRENCY_LEVELS[c];
        var key = payloadSizeBytes + ':' + concurrency;
        console.error('  payload=' + payloadSizeBytes + 'B concurrency=' + concurrency + ' ...');
        var r = await runLoad(payloadSizeBytes, concurrency, REQUESTS_PER_COMBINATION);
        results[key] = r;
        console.error('    throughput=' + r.throughputRps.toFixed(1) + ' req/s, hop p50=' + r.hopP50.toFixed(2) + 'ms p99=' + r.hopP99.toFixed(2) + 'ms, errors=' + r.errors);
      }
    }
  } finally {
    await stopServer(child);
  }
  return results;
}

async function main() {
  var mainThreadRouted = await benchmarkCondition(false);
  var directPeerChannels = await benchmarkCondition(true);

  console.log(JSON.stringify({mainThreadRouted: mainThreadRouted, directPeerChannels: directPeerChannels}, null, 2));
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});

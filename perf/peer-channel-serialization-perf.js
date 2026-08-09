// D2's required sub-benchmark (docs/direct-peer-channels-design.md section
// 2): compares three ways to move a payload across a worker_threads
// MessagePort, independent of the rest of the countinghouse server --
// (a) JSON.stringify to a string, (b) posting the raw object (structured
// clone, what lib/peer-channel.js actually does today), (c) encoding into
// a Buffer/ArrayBuffer and transferring ownership via the transferList
// (zero-copy). worker-message.js's existing top-of-file comment cites a
// 2016 blog post that picked (a) for the old main-thread-routed protocol;
// this is that claim re-measured on the current Node target, for the new
// protocol specifically, per CLAUDE.md's "performance claims cannot cite
// old numbers until re-benchmarked" rule.
//
// Usage: node perf/peer-channel-serialization-perf.js
// Self-contained -- spins up its own worker, no countinghouse server
// involved. Takes well under a minute.

var Worker = require('worker_threads').Worker;
var isMainThread = require('worker_threads').isMainThread;
var parentPort = require('worker_threads').parentPort;
var MessageChannel = require('worker_threads').MessageChannel;

var PAYLOAD_SIZES = [1024, 102400, 1048576]; // 1KB, 100KB, 1MB
var ROUNDTRIPS = 300;

function percentile(sorted, p) {
  var idx = Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length));
  return sorted[idx];
}

function makePayload(sizeBytes) {
  // an object shape roughly matching a real peer-invoke request
  // (lib/peer-channel.js's actual wire shape), not a bare string, so the
  // structured-clone case pays realistic (de)serialization cost for object
  // structure too, not just string length.
  return {
    id: 1,
    command: 'peer-invoke',
    deviceID: 'bench-device-id',
    serviceID: 'urn:countinghouse-com:serviceID:benchService',
    actionName: 'bench',
    input: {data: 'x'.repeat(sizeBytes)}
  };
}

function benchStrategy(port, strategy, payload, roundtrips) {
  return new Promise(function(resolve) {
    var latencies = [];
    var n = 0;

    port.on('message', onMessage);

    function onMessage(msg) {
      var end = process.hrtime.bigint();
      latencies.push(Number(end - sentAt) / 1e6);
      n++;
      if (n >= roundtrips) {
        port.removeListener('message', onMessage);
        latencies.sort(function(a, b) { return a - b; });
        return resolve({
          p50: percentile(latencies, 50),
          p99: percentile(latencies, 99),
          mean: latencies.reduce(function(a, b) { return a + b; }, 0) / latencies.length
        });
      }
      sendOne();
    }

    var sentAt;
    function sendOne() {
      sentAt = process.hrtime.bigint();
      if (strategy === 'stringify') {
        port.postMessage({strategy: strategy, body: JSON.stringify(payload)});
      } else if (strategy === 'structuredClone') {
        port.postMessage({strategy: strategy, body: payload});
      } else if (strategy === 'transferBuffer') {
        var buf = Buffer.from(JSON.stringify(payload), 'utf8');
        // slice to get a standalone ArrayBuffer (Buffer.from a string
        // shares Node's internal pool otherwise, which isn't transferable
        // on its own boundaries)
        var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        port.postMessage({strategy: strategy, body: ab}, [ab]);
      }
    }

    sendOne();
  });
}

async function mainThreadMain() {
  var channel = new MessageChannel();
  var worker = new Worker(__filename, {workerData: {port: channel.port2}, transferList: [channel.port2]});

  var results = {};

  for (var s = 0; s < PAYLOAD_SIZES.length; s++) {
    var sizeBytes = PAYLOAD_SIZES[s];
    results[sizeBytes] = {};
    var strategies = ['stringify', 'structuredClone', 'transferBuffer'];
    for (var i = 0; i < strategies.length; i++) {
      var strategy = strategies[i];
      var payload = makePayload(sizeBytes);
      console.error('payload=' + sizeBytes + 'B strategy=' + strategy + ' ...');
      var r = await benchStrategy(channel.port1, strategy, payload, ROUNDTRIPS);
      results[sizeBytes][strategy] = r;
      console.error('  p50=' + r.p50.toFixed(3) + 'ms p99=' + r.p99.toFixed(3) + 'ms mean=' + r.mean.toFixed(3) + 'ms');
    }
  }

  console.log(JSON.stringify(results, null, 2));
  channel.port1.close();
  await worker.terminate();
}

function workerMain() {
  var require_wt = require('worker_threads');
  var port = require_wt.workerData.port;

  port.on('message', function(msg) {
    // simple echo -- round-trip cost is what's measured, not any
    // processing on the receiving end.
    if (msg.strategy === 'stringify') {
      var parsed = JSON.parse(msg.body); // pay the parse cost too, matching a real receiver
      port.postMessage({strategy: msg.strategy, body: JSON.stringify(parsed)});
    } else if (msg.strategy === 'structuredClone') {
      port.postMessage({strategy: msg.strategy, body: msg.body});
    } else if (msg.strategy === 'transferBuffer') {
      // decode to prove round-trip correctness cost is paid on this side too
      var text = Buffer.from(msg.body).toString('utf8');
      var obj = JSON.parse(text);
      var buf = Buffer.from(JSON.stringify(obj), 'utf8');
      var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      port.postMessage({strategy: msg.strategy, body: ab}, [ab]);
    }
  });
}

if (isMainThread) {
  mainThreadMain().catch(function(err) { console.error(err); process.exit(1); });
} else {
  workerMain();
}

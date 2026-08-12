// Worker-thread peer for the direct-peer-channel condition. Both ends of the
// benchmark's channel run this file: one as the caller (drives the timing
// loop) and one as the callee (echoes), which is the production topology --
// lib/peer-channel.js connects two *workers*, not a worker and the main
// thread (see lib/peer-channel-broker.js's D1 note on port topology).
//
// Uses the real lib/peer-channel.js, so the measurement includes its actual
// request/reply correlation, its per-call timer, and the structured clone
// postMessage performs -- i.e. the transport as shipped, not a mock of it.
var workerData = require('worker_threads').workerData;
var parentPort = require('worker_threads').parentPort;
var PeerChannel = require('../../lib/peer-channel');

var TIMEOUT_MS = 120000; // generous: this benchmark is not testing timeouts

if (workerData.role === 'callee') {
  new PeerChannel(workerData.port, {
    workerId: 'bench-caller',
    onInvoke: function(request, reply) {
      // echo straight back; no work, so the number is transport cost
      reply(null, {echo: request.input});
    }
  });
  parentPort.postMessage({ready: true});
  return;
}

// caller role
var channel = new PeerChannel(workerData.port, {workerId: 'bench-callee'});

function oneChain(payload, hops, done) {
  var i = 0;
  (function hop() {
    if (i >= hops) return done();
    i++;
    channel.invoke('bench-device', 'bench-service', 'echo', payload, TIMEOUT_MS, function(err) {
      if (err != null) return done(err);
      hop();
    });
  })();
}

// stays alive across runs: the driver issues a warmup run first and only
// samples CPU/RSS around the measured one, so worker startup is not charged
// to the measurement (conditions (b) and (c) warm up the same way)
parentPort.on('message', function(msg) {
  if (msg.command !== 'run') return;

  var payload = 'x'.repeat(msg.payloadBytes);
  var latencies = [];
  var n = 0;

  function iteration() {
    if (n >= msg.iterations) {
      return parentPort.postMessage({done: true, latencies: latencies});
    }
    n++;
    var t0 = process.hrtime.bigint();
    oneChain(payload, msg.hops, function(err) {
      if (err != null) return parentPort.postMessage({done: true, error: String(err.message || err)});
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
      iteration();
    });
  }
  iteration();
});

parentPort.postMessage({ready: true});

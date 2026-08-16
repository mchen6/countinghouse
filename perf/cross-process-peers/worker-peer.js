// Worker-thread peer for the direct-peer-channel condition. Both ends of the
// benchmark's channel run this file: one as the caller (drives the timing
// loop) and one as the callee (echoes), which is the production topology --
// lib/peer-channel.js connects two *workers*, not a worker and the main
// thread (see lib/peer-channel-broker.js's D1 note on port topology).
//
// Uses the real lib/peer-channel.js, so the measurement includes its actual
// request/reply correlation, its per-call timer, and the structured clone
// postMessage performs -- i.e. the transport as shipped, not a mock of it.
const workerData = require('worker_threads').workerData;
const parentPort = require('worker_threads').parentPort;
const PeerChannel = require('../../lib/peer-channel');

const TIMEOUT_MS = 120000; // generous: this benchmark is not testing timeouts

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
const channel = new PeerChannel(workerData.port, {workerId: 'bench-callee'});

function oneChain(payload, hops, done) {
  let i = 0;
  (function hop() {
    if (i >= hops) return done();
    i++;
    channel.invoke('bench-device', 'bench-service', 'echo', payload, TIMEOUT_MS, (err) => {
      if (err != null) return done(err);
      hop();
    });
  })();
}

// stays alive across runs: the driver issues a warmup run first and only
// samples CPU/RSS around the measured one, so worker startup is not charged
// to the measurement (conditions (b) and (c) warm up the same way)
parentPort.on('message', (msg) => {
  if (msg.command !== 'run') return;

  const payload = 'x'.repeat(msg.payloadBytes);
  const latencies = [];
  let n = 0;

  function iteration() {
    if (n >= msg.iterations) {
      return parentPort.postMessage({done: true, latencies: latencies});
    }
    n++;
    const t0 = process.hrtime.bigint();
    oneChain(payload, msg.hops, (err) => {
      if (err != null) return parentPort.postMessage({done: true, error: String(err.message || err)});
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
      iteration();
    });
  }
  iteration();
});

parentPort.postMessage({ready: true});

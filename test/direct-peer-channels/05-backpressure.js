const fs = require('fs');
const {deviceIDForName} = require('../../lib/call-address');
const {startServer, shutdownThenStop} = require('../helpers/sandbox-server');
const request = require('supertest');
const {testPort} = require('../helpers/test-env');

const url = `http://127.0.0.1:${testPort(9527)}`;

// docs/direct-peer-channels.md's "Backpressure" section: lib/peer-channel.js
// caps and queues concurrent invokes (both the caller's outgoing invoke()
// calls and the callee's incoming dispatch to onInvoke) instead of letting
// them all fire at once. This test isn't a performance assertion (that's
// what perf/direct-peer-channels-perf.js is for) -- it's a correctness
// check for the queueing mechanism itself: with a deliberately low cap and
// a burst of concurrent calls well above it, every call must still
// eventually complete successfully with the right data, none dropped or
// corrupted by the queue.
//
// Self-contained, own server (like 03/04): needs a specific
// --directPeerChannelsMaxConcurrency value lower than test8.js's default
// (16) to actually exercise queueing with a request burst this test can
// reasonably send.
describe('direct-peer-channels 05: backpressure queueing is correct, not just fast', function() {
  this.timeout(0);

  // started on the run's own port (testPort), stopped in after() whatever
  // happens (#234: it used to listen on the default port, and to be asked
  // to stop on another, so a failing run left it running)
  let server = null;
  before(async function() {
    this.timeout(0);
    console.log('starting countinghouse with --directPeerChannelsMaxConcurrency 2...');
    server = await startServer(testPort(9527), '--workerThread --debug --directPeerChannels --directPeerChannelsMaxConcurrency 2 --loadModule ./pre-installed-packages/perf-callee-demo --loadModule ./pre-installed-packages/perf-caller-demo'.split(/\s+/).filter(Boolean), {nodeArgs: ['--expose-gc']});
  });

  after(() => {
    // asked to stop, then stopped whatever it answered, or did not (#234)
    return shutdownThenStop(server, testPort(9527), null);
  });

  const CALLER_DEVICE_ID = deviceIDForName('perf-caller-demo'); // perf-caller-demo

  it('a burst of concurrent calls well above the cap all complete correctly, none dropped', (done) => {
    const TOTAL = 20; // 10x the cap of 2
    let remaining = TOTAL;
    let failed = null;

    for (let i = 0; i < TOTAL; i++) {
      request(url).post(`/devices/${CALLER_DEVICE_ID}/invoke-action`)
      .set('X-CH-Key', 'anything')
      .send({serviceID: 'urn:countinghouse-com:serviceID:perfCallerService', actionName: 'run', input: {payloadSizeBytes: 1024}})
      .end((err, res) => {
        if (err != null) failed = failed || new Error(`direct-peer-channels 05 fail: request error: ${err.message}`);
        else if (res.body.output == null || typeof(res.body.output.durationMs) !== 'number') {
          failed = failed || new Error(`direct-peer-channels 05 fail: unexpected response: ${JSON.stringify(res.body)}`);
        }
        remaining--;
        if (remaining === 0) return done(failed || undefined);
      });
    }
  });
});

const fs = require('fs');
const exec = require('child_process').exec;
const request = require('supertest');

const url = 'http://127.0.0.1:9527';

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

  before(function(done) {
    this.timeout(0);
    console.log('starting countinghouse with --directPeerChannelsMaxConcurrency 2...');
    exec('"./bin/countinghouse" --workerThread --debug --bindAddr 127.0.0.1 --directPeerChannels --directPeerChannelsMaxConcurrency 2 --loadModule ./pre-installed-packages/perf-callee-demo --loadModule ./pre-installed-packages/perf-caller-demo', (err, stdout, stderr) => { console.log(err); });
    setTimeout(() => { done(); }, 13000);
  });

  after((done) => {
    request(url).post('/shutdown').end(() => { done(); });
  });

  const CALLER_DEVICE_ID = '13793b1a-132d-5a03-a46b-2e0bb72d0d82'; // perf-caller-demo

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

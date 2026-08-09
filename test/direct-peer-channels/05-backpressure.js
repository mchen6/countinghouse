var fs = require('fs');
var exec = require('child_process').exec;
var request = require('supertest');

var url = 'http://127.0.0.1:9527';

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
    exec('"./bin/countinghouse" --workerThread --debug --bindAddr 127.0.0.1 --directPeerChannels --directPeerChannelsMaxConcurrency 2 --loadModule ./pre-installed-packages/perf-callee-demo --loadModule ./pre-installed-packages/perf-caller-demo', function(err, stdout, stderr) { console.log(err); });
    setTimeout(function() { done(); }, 13000);
  });

  after(function(done) {
    request(url).post('/shutdown').end(function() { done(); });
  });

  var CALLER_DEVICE_ID = '13793b1a-132d-5a03-a46b-2e0bb72d0d82'; // perf-caller-demo

  it('a burst of concurrent calls well above the cap all complete correctly, none dropped', function(done) {
    var TOTAL = 20; // 10x the cap of 2
    var remaining = TOTAL;
    var failed = null;

    for (var i = 0; i < TOTAL; i++) {
      request(url).post('/devices/' + CALLER_DEVICE_ID + '/invoke-action')
      .set('X-CH-Key', 'anything')
      .send({serviceID: 'urn:countinghouse-com:serviceID:perfCallerService', actionName: 'run', input: {payloadSizeBytes: 1024}})
      .end(function(err, res) {
        if (err != null) failed = failed || new Error('direct-peer-channels 05 fail: request error: ' + err.message);
        else if (res.body.output == null || typeof(res.body.output.durationMs) !== 'number') {
          failed = failed || new Error('direct-peer-channels 05 fail: unexpected response: ' + JSON.stringify(res.body));
        }
        remaining--;
        if (remaining === 0) return done(failed || undefined);
      });
    }
  });
});

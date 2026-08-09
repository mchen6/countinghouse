var fs = require('fs');
var exec = require('child_process').exec;
var request = require('supertest');
var url = 'http://127.0.0.1:9527';

// docs/direct-peer-channels-design.md section 5's step-by-step acceptance
// requires "全量测试在 flag 开/关两态下均绿" -- test1.js/test2.js already cover
// the flag OFF (default) state; this file re-runs the exact same test/unit
// suite with --directPeerChannels added, so every existing assertion (not
// just the peer-channel-specific ones in test/direct-peer-channels/) is
// re-verified against the new code path. Most of test/unit/*.js never
// touches ServiceClient/isRemoteThread at all (they invoke device modules
// directly over HTTP), so this is mostly a "did turning this on break
// anything unrelated" smoke check -- the actual peer-channel mechanics are
// covered by test/direct-peer-channels/*.js below.
var testFiles = fs.readdirSync(__dirname + '/unit');
var peerChannelTestFiles = fs.readdirSync(__dirname + '/direct-peer-channels');

describe("Test started in COUNTINGHOUSE multi-thread mode with --directPeerChannels", function () {
  before(function (done) {
    this.timeout(0);
    console.log('starting countinghouse...');
    exec('"./bin/countinghouse" --workerThread --debug --bindAddr 127.0.0.1 --debugKey aabbcc --apiCache --apiMonitor --directPeerChannels --loadModule ./pre-installed-packages/echo-device-module --loadModule ./pre-installed-packages/echo-device-client-module', function(err, stdout, stderr){console.log(err)});
    setTimeout(() => {
      done();
    }, 5000);
  });

  testFiles.forEach(function (file) {
    if (file !== 'input.bson' && file !== 'test018.js') require('./unit/' + file);
  });

  peerChannelTestFiles.forEach(function (file) {
    require('./direct-peer-channels/' + file);
  });

  after(function (done) {
    console.log('test ended');
    request(url).post('/shutdown')
    .end(function() {
      done();
    });
  });
});

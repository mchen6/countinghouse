var fs = require('fs');
var exec = require('child_process').exec;
var request = require('supertest');
var url = 'http://127.0.0.1:9527';

var testFiles = fs.readdirSync(__dirname + '/unit');

describe("Test started in COUNTINGHOUSE multi-thread mode", function () {
  before(function (done) {
    this.timeout(0);
    console.log('starting countinghouse...');
    exec('"./bin/countinghouse" --workerThread --debug --bindAddr 127.0.0.1 --debugKey aabbcc --apiMonitor --loadModule ./pre-installed-packages/echo-device-module --loadModule ./pre-installed-packages/echo-device-client-module', function(err, stdout, stderr){console.log(err)});
    // Two modules have to finish discovery before the first request fires;
    // 5000ms was too short (measured: ~8.8s to both devices online here),
    // producing spurious DEVICE_NOT_FOUND across the whole suite. 13000ms
    // matches every other 2-module standalone server in this repo -- see
    // test8.js for the same fix.
    setTimeout(() => {
      done();
    }, 13000);
  });

  testFiles.forEach(function (file) {
    if (file !== 'input.bson' && file !== 'test018.js') require('./unit/' + file);
  });

  after(function (done) {
    console.log('test ended');
    request(url).post('/shutdown')
    .set('X-CH-Key', 'aabbcc') // /shutdown is now admin-gated (lib/routes/admin-only.js) -- this server's --debugKey
    .end(function() {
      done();
    });
  });
});


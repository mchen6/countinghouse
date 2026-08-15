var fs = require('fs');
var exec = require('child_process').exec;
var request = require('supertest');
var url = 'http://127.0.0.1:9527';

var testFiles = fs.readdirSync(__dirname + '/unit');

describe("Test started in COUNTINGHOUSE single-thread mode", function () {
  before(function (done) {
    this.timeout(0);
    console.log('starting countinghouse...');
    exec('"./bin/countinghouse" --debug --bindAddr 127.0.0.1 --debugKey aabbcc --apiMonitor --loadModule ./pre-installed-packages/echo-device-module --loadModule ./pre-installed-packages/echo-device-client-module', function(err, stdout, stderr){console.log(err)});
    // Same startup race as test1.js: 5000ms is not enough for two modules
    // to finish discovery, and the shortfall shows up as spurious
    // DEVICE_NOT_FOUND rather than as a startup failure.
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


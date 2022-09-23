var fs = require('fs');
var exec = require('child_process').exec;
var request = require('supertest');
var url = 'http://127.0.0.1:9527';

var testFiles = fs.readdirSync(__dirname + '/unit');

describe("Test started in CDIF multi-thread mode", function () {
  before(function (done) {
    this.timeout(0);
    console.log('starting cdif...');
    exec('"./bin/cdif" --workerThread --debug --bindAddr 127.0.0.1 --debugKey aabbcc --apiCache --apiMonitor --loadModule ./pre-installed-packages/echo-device-module --loadModule ./pre-installed-packages/echo-device-client-module', function(err, stdout, stderr){console.log(err)});
    setTimeout(() => {
      done();
    }, 5000);
  });

  testFiles.forEach(function (file) {
    if (file !== 'input.bson' && file !== 'test018.js') require('./unit/' + file);
  });

  after(function (done) {
    console.log('test ended');
    request(url).post('/shutdown')
    .end(function() {
      done();
    });
  });
});


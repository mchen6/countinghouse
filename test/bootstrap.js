var exec = require('child_process').exec;
var request = require('supertest');
var url = 'http://127.0.0.1:9527';

before(function(done) {
  this.timeout(0);
  console.log('starting cdif...');
  exec('"./bin/cdif" --workerThread --debug --bindAddr 127.0.0.1 --debugKey aabbcc --apiCache --apiMonitor --loadModule ./pre-installed-packages/echo-device-module --loadModule ./pre-installed-packages/echo-device-client-module', function(err, stdout, stderr){console.log(err)});
  setTimeout(() => {
    done();
  }, 5000);
});

after(function(done) {
  console.log('test ended');
  request(url).post('/shutdown')
  .end(function() {
    done();
  });
});


//var exec = require('child_process').exec;

//module.exports = function() {
//  exec('"../bin/cdif" --workerThread --debug --bindAddr 127.0.0.1 --loadModule ./test/pre-installed-packages/echo-device-module/');
//}

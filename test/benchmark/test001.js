
var request = require('supertest');
var benchrest = require('bench-rest');
var url = 'http://127.0.0.1:9527';


module.exports = function (cp, isSingleThread) {
  describe('Benchmarking API performance', function() {
    this.timeout(0);

    var flow = {
      main: [
        { post: 'http://localhost:9527/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action',
          json: {serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: {foo: [], bar: 'vv'}},
          headers: {
            'X-Apemesh-Key': 'aabbcc',
            'Content-Type': 'application/json'
          }
        }
      ]
    };

    var runOptions = {
      limit: 100,     // concurrent connections
      iterations: 100000  // number of iterations to perform
    };

    it('perform benchmarking', function(done) {
      cp.on('message', message => {
        if (message !== 'ready') return done(new Error('didnt receive ready message'));

        benchrest(flow, runOptions)
        .on('error', function (err, ctxName) { return done(err); })
        .on('end', function (stats, errorCount) {
          console.log('error count: ', errorCount);
          console.log('stats', stats);
          return done();
        });
      });
    });
  });
};


var request = require('supertest');
var benchrest = require('bench-rest');
var url = 'http://127.0.0.1:9527';


module.exports = function (cp, isSingleThread) {
  describe('Benchmarking API performance with Service Client', function() {
    this.timeout(0);

    var flow = {
      main: [
        { post: 'http://localhost:9527/devices/efefb416-bdc0-54eb-96a9-38f96f52779d/invoke-action',
          json: {serviceID: 'urn:example-com:serviceID:服务名称', actionName: 'API名称', input:{foo: 'vv'}},
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
      benchrest(flow, runOptions)
      .on('error', function (err, ctxName) { return done(err); })
      .on('end', function (stats, errorCount) {
        console.log('error count: ', errorCount);
        console.log('stats', stats);
        request(url).post('/shutdown').end(function() {});
        return done();
      });
    });
  });
};

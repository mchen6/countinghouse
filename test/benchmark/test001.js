
const request = require('supertest');
const waitForReady = require('../helpers/wait-for-ready');
const benchrest = require('bench-rest');
const url = 'http://127.0.0.1:9527';


module.exports = function (cp, isSingleThread) {
  describe('Benchmarking API performance', function() {
    this.timeout(0);

    const flow = {
      main: [
        { post: 'http://localhost:9527/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action',
          json: {serviceID: 'urn:countinghouse-com:serviceID:echoService', actionName: 'echo', input: {foo: [], bar: 'vv'}},
          headers: {
            'X-CH-Key': 'aabbcc',
            'Content-Type': 'application/json'
          }
        }
      ]
    };

    const runOptions = {
      limit: 100,     // concurrent connections
      iterations: 100000  // number of iterations to perform
    };

    it('perform benchmarking', (done) => {
      waitForReady.inText(() => cp.log, (readyErr) => {
        if (readyErr != null) return done(readyErr);

        benchrest(flow, runOptions)
        .on('error', (err, ctxName) => { return done(err); })
        .on('end', (stats, errorCount) => {
          console.log('error count: ', errorCount);
          console.log('stats', stats);
          return done();
        });
      });
    });
  });
};

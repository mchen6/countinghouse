
const request = require('supertest');
const {deviceIDForName} = require('../../lib/call-address');
const benchrest = require('bench-rest');
const {testPort} = require('../helpers/test-env');
const url = `http://127.0.0.1:${testPort(9527)}`;


module.exports = function (cp, isSingleThread) {
  describe('Benchmarking API performance with Service Client', function() {
    this.timeout(0);

    const flow = {
      main: [
        { post: `http://localhost:${testPort(9527)}/devices/${deviceIDForName('echo-device-client')}/invoke-action`,
          json: {serviceID: 'urn:example-com:serviceID:服务名称', actionName: 'API名称', input:{foo: 'vv'}},
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
      benchrest(flow, runOptions)
      .on('error', (err, ctxName) => { return done(err); })
      .on('end', (stats, errorCount) => {
        console.log('error count: ', errorCount);
        console.log('stats', stats);
        request(url).post('/shutdown').set('X-CH-Key', 'aabbcc').end(() => {}); // /shutdown is now admin-gated, shared with test6/test7's debugKey
        return done();
      });
    });
  });
};

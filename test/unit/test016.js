var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://127.0.0.1:9527';

describe('test16: invoke error expect unknown error', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:countinghouse-com:serviceID:errorInfoTestService', actionName: 'testErrorInfo', input: {foo: "444"} };

  it('invoke error expect unknown error', function(done) {
    request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
    .set('X-CH-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);

      // note: the dynamic "unknown error" suffix (a second arg passed to the
      // original DeviceError) doesn't survive the worker_threads postMessage
      // boundary -- only `code` is propagated across it, not the full
      // arguments array -- so this only checks the code, not that suffix.
      if (res.body.code !== 'DEVICE_INVOKE_FAIL'
      ) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test16 fail: not an unknown error'));
      }
      return done();
    });
  });
});
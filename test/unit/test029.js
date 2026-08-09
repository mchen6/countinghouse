var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://127.0.0.1:9527';

describe('test29: invoke action which throws inside a detached setTimeout', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:countinghouse-com:serviceID:errorInfoTestService', actionName: 'testAsyncThrowInDomain', input: {} };

  // testAsyncThrowInDomain throws inside a bare setTimeout that never calls
  // its own callback -- the exception happens fully detached from the
  // try/catch in Service.prototype.doActionCall (lib/service.js), so it
  // can no longer be caught there (that capability was specific to the
  // deprecated `domain` module, removed in favor of try/catch -- see the
  // comment above doActionCall). The request now times out instead of
  // getting a fast structured error.
  it('never calls back, so the request times out as DEVICE_NOT_RESPONDING', function(done) {
    request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
    .set('X-CH-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);

      if (res.body.topic !== 'device error' ||
          res.body.code !== 'DEVICE_NOT_RESPONDING'
      ) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test29 fail'));
      }
      return done();
    });
  });
});
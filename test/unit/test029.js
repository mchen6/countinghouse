var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://127.0.0.1:9527';

describe('test29: invoke action which throw async exception', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:errorInfoTestService', actionName: 'testAsyncThrowInDomain', input: {} };

  it('invoke action which throw async exception', function(done) {
    request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
    .set('X-Apemesh-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);

      if (res.body.topic !== 'device error' ||
          res.body.message !== '设备接口调用抛出异常' ||
          res.body.fault == null ||
          res.body.fault.message.startsWith('Cannot read properties of null') === false
      ) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test29 fail'));
      }
      return done();
    });
  });
});
var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://127.0.0.1:9527';

describe('test13: invoke with timeout', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:timeOutTestService', actionName: 'testTimeout', input: {} };

  it('invoke with timeout', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .set('X-Apemesh-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);

      if (res.body.message !== '设备无响应') {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test13 invoke with timeout fail'));
      }
      return done();
    });
  });
});
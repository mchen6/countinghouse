var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://127.0.0.1:9527';

describe('test10: invoke specify incorrect input type', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: false };

  it('invoke without specifying input', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .set('X-Apemesh-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);
      if (res.body.message.startsWith('输入数据校验错误') === false || res.body.fault.reason !== '数据不是object类型') {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test10 invoke specify incorrect input type fail'));
      }
      return done();
    });
  });
});
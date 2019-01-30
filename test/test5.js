var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://192.168.0.15:9527';

describe('test5: invoke without specifying actionName', function() {
  this.timeout(0);
  var req = { serviceID: 'pseudo', input: {} };

  it('invoke without specifying actionName', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);
      if (res.body.message.startsWith('未找到actionName') === false) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test invoke without specifying actionName fail'));
      }
      return done();
    });
  });
});
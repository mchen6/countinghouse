var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://127.0.0.1:9527';


describe('test17: invoke with BSON content-type and JSON text', function() {
  this.timeout(0);
  var req = BSON.serialize({ serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: {foo: [{item1: '111', item2: false}], bar: '222'} });

  it('invoke with BSON content-type and JSON text', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .set('X-Apemesh-Key', 'aabbcc')
    .set('Content-Type', 'application/bson')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(200, function(err, res) {
      if (err) return done(new Error('test17 fail: ' + err.message));

      return done();
    });
  });
});
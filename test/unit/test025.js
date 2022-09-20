var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');
var redis   = require('redis');
redisClient = redis.createClient();

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://127.0.0.1:9527';

describe('test25: test API log feature', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: { foo: [], bar: 'vv'} };

  it('invoke should write API log to redis', function(done) {
    var beforeLen = 0, afterLen = 0;
    redisClient.llen('list:aabbcc#c5284c70-ae5f-591c-b2f1-cf0b4ebd0767#urn:apemesh-com:serviceID:echoService#echo', function(err, data) {
      if (err) return done(err);
      beforeLen = data;

      request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
      .set('X-Apemesh-Key', 'aabbcc')
      .send(req)
      .expect('Content-Type', /[json | text]/)
      .expect(200, function(err, res) {
        if (err) return done(err);
        redisClient.llen('list:aabbcc#c5284c70-ae5f-591c-b2f1-cf0b4ebd0767#urn:apemesh-com:serviceID:echoService#echo', function(err, data) {
          redisClient.end(true);
          if (err) return done(err);
          if ((beforeLen + 1) !== data) return done(new Error('API log length mismatch'));
          return done();
        });
      });
    });
  });
});

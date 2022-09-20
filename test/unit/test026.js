var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');
var redis   = require('redis');
var redisClient = redis.createClient({db: 5});

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://127.0.0.1:9527';

describe('test26: test API Cache feature', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echoWithAPICache', input: { foo: [], bar: 'vv'} };

  it('invoke should write API cache to redis', function(done) {
    var hashKey = '2672998512'; //manually set key value according to the input above, if this is changed in the future, we can see cdif code on how to generate this key, or it can be observed in redis API cache
    redisClient.del(hashKey, function(err) {
      if (err) return done(err);

      request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
      .set('X-Apemesh-Key', 'aabbcc')
      .send(req)
      .expect('Content-Type', /[json | text]/)
      .expect(200, function(err, res) {
        if (err) {
          redisClient.end(true);
          return done(err);
        }
        setTimeout(() => {
          redisClient.hgetall(hashKey, function(err, data) {
            redisClient.del(hashKey, function(err){});
            redisClient.end(true);
            if (err) return done(err);
            if (data.deviceID !== 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767' || data.value == null) {
              console.error(data);
              return done(new Error('API cache content wrong'));
            }
            return done();
          });
        }, 1000); //wait 1000ms to allow previous redisClient.del operation effective
      });
    });
  });
});

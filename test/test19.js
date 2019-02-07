var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://192.168.0.15:9527';

describe('test19: invoke with BSON content-type with large binary data', function() {
  this.timeout(0);
  var largeBuffer = Buffer.alloc(1024 * 1024 * 20); // 20MB binary data
  var req = BSON.serialize({ serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: {foo: [{item1: '111', item2: false}], bar: '222', binaryData: largeBuffer} });

  it('invoke with BSON content-type with binary data', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .set('Content-Type', 'application/bson')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(200, function(err, res) {
      if (err) return done(new Error('test18 fail: ' + err.message));

      if (res.body.output == null
        || res.body.output.binaryData == null
        || res.body.output.binaryData.data == null
      ) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(BSON.deserialize(req))));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test19 fail'));
      }

      return done();
    });
  });
});

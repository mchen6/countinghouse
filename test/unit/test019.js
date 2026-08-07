var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://127.0.0.1:9527';

describe('test19: invoke with BSON content-type with large binary data', function() {
  this.timeout(0);
  var largeBuffer = Buffer.alloc(1024 * 1024 * 20); // 20MB binary data
  var reqObj = { serviceID: 'urn:countinghouse-com:serviceID:echoService', actionName: 'echo', input: {foo: [{item1: '111', item2: false}], bar: '222', binaryData: largeBuffer} };
  // bson's default internal serialization buffer is fixed at 17MB (see bson/lib/bson.js MAXSIZE),
  // which is smaller than this test's 20MB payload and overflows during serializeInto.
  // Size the internal buffer to fit this object plus headroom for BSON's own overhead.
  var req = BSON.serialize(reqObj, { minInternalBufferSize: BSON.calculateObjectSize(reqObj) + 1024 });

  it('invoke with BSON content-type with binary data', function(done) {
    request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
    .set('X-CH-Key', 'aabbcc')
    .set('Content-Type', 'application/bson')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(200, function(err, res) {
      if (err) return done(new Error('test19 fail: ' + err.message));

      if (res.body.output == null
        || res.body.output.binaryData == null
      ) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(BSON.deserialize(req))));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test19 fail'));
      }

      return done();
    });
  });
});

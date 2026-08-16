const request = require('supertest');
const jsf     = require('json-schema-faker');
const chalk   = require('chalk');
const BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

const url = 'http://127.0.0.1:9527';

describe('test19: invoke with BSON content-type with large binary data', function() {
  this.timeout(0);
  const largeBuffer = Buffer.alloc(1024 * 1024 * 20); // 20MB binary data
  const reqObj = { serviceID: 'urn:countinghouse-com:serviceID:echoService', actionName: 'echo', input: {foo: [{item1: '111', item2: false}], bar: '222', binaryData: largeBuffer} };
  // bson's default internal serialization buffer is fixed at 17MB (see bson/lib/bson.js MAXSIZE),
  // which is smaller than this test's 20MB payload and overflows during serializeInto.
  // Size the internal buffer to fit this object plus headroom for BSON's own overhead.
  const req = BSON.serialize(reqObj, { minInternalBufferSize: BSON.calculateObjectSize(reqObj) + 1024 });

  it('invoke with BSON content-type with binary data', (done) => {
    request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
    .set('X-CH-Key', 'aabbcc')
    .set('Content-Type', 'application/bson')
    // the 20MB binary payload comes back JSON-serialized (Buffer -> {type,data:[...]}),
    // which balloons well past superagent's 200MB buffered-response default cap added
    // in newer versions; raise it for this deliberately-large-payload test
    .maxResponseSize(1024 * 1024 * 1024)
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(200, (err, res) => {
      if (err) return done(new Error(`test19 fail: ${err.message}`));

      if (res.body.output == null
        || res.body.output.binaryData == null
      ) {
        console.error(chalk.white.bgRed.bold(`Request:${JSON.stringify(BSON.deserialize(req))}`));
        console.error(chalk.white.bgRed.bold(`Response: ${JSON.stringify(res.body)}`));
        return done(new Error('test19 fail'));
      }

      return done();
    });
  });
});

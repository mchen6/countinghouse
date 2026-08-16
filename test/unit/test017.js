const request = require('supertest');
const jsf     = require('json-schema-faker');
const chalk   = require('chalk');
const BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

const url = 'http://127.0.0.1:9527';


describe('test17: invoke with BSON content-type and JSON text', function() {
  this.timeout(0);
  const req = BSON.serialize({ serviceID: 'urn:countinghouse-com:serviceID:echoService', actionName: 'echo', input: {foo: [{item1: '111', item2: false}], bar: '222'} });

  it('invoke with BSON content-type and JSON text', (done) => {
    request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
    .set('X-CH-Key', 'aabbcc')
    .set('Content-Type', 'application/bson')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(200, (err, res) => {
      if (err) return done(new Error(`test17 fail: ${err.message}`));

      return done();
    });
  });
});
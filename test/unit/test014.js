const request = require('supertest');
const jsf     = require('json-schema-faker');
const chalk   = require('chalk');
const BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

const url = 'http://127.0.0.1:9527';

describe('test14: invoke error expect fault as an object', function() {
  this.timeout(0);
  const req = { serviceID: 'urn:countinghouse-com:serviceID:errorInfoTestService', actionName: 'testErrorInfo', input: {foo: "222"} };

  it('invoke error expect fault as an object', (done) => {
    request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
    .set('X-CH-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, (err, res) => {
      if (err) return done(err);

      if (res.body.code !== 'DEVICE_INVOKE_FAIL'
        || res.body.fault.reason !== 'err'
        || res.body.fault.info !== '222'
      ) {
        console.error(chalk.white.bgRed.bold(`Request:${JSON.stringify(req)}`));
        console.error(chalk.white.bgRed.bold(`Response: ${JSON.stringify(res.body)}`));
        return done(new Error('test14 fail: fault is not an object'));
      }
      return done();
    });
  });
});
const request = require('supertest');
const jsf     = require('json-schema-faker');
const chalk   = require('chalk');
const BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

const url = 'http://127.0.0.1:9527';

describe('test28: invoke async action which throw exception', function() {
  this.timeout(0);
  const req = { serviceID: 'urn:countinghouse-com:serviceID:errorInfoTestService', actionName: 'testThrowErrorAsync', input: {} };

  it('invoke async action which throw exception', (done) => {
    request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
    .set('X-CH-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, (err, res) => {
      if (err) return done(err);

      if (res.body.topic !== 'device error' ||
          res.body.code !== 'DEVICE_INVOKE_EXCEPTION' ||
          res.body.fault == null ||
          res.body.fault.message.startsWith('Cannot read properties of null') === false
      ) {
        console.error(chalk.white.bgRed.bold(`Request:${JSON.stringify(req)}`));
        console.error(chalk.white.bgRed.bold(`Response: ${JSON.stringify(res.body)}`));
        return done(new Error('test28 fail'));
      }
      return done();
    });
  });
});
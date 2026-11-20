const request = require('supertest');
const {deviceIDForName} = require('../../lib/call-address');
const jsf     = require('json-schema-faker');
const chalk   = require('chalk');
const {testPort} = require('../helpers/test-env');

jsf.option({
  alwaysFakeOptionals: true
});

const url = `http://127.0.0.1:${testPort(9527)}`;

describe('test15: invoke error expect fault as a string', function() {
  this.timeout(0);
  const req = { serviceID: 'urn:countinghouse-com:serviceID:errorInfoTestService', actionName: 'testErrorInfo', input: {foo: "333"} };

  it('invoke error expect fault as a string', (done) => {
    request(url).post(`/devices/${deviceIDForName('echo-device')}/invoke-action`)
    .set('X-CH-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, (err, res) => {
      if (err) return done(err);

      if (res.body.code !== 'DEVICE_INVOKE_FAIL'
        || res.body.fault !== '333'
      ) {
        console.error(chalk.white.bgRed.bold(`Request:${JSON.stringify(req)}`));
        console.error(chalk.white.bgRed.bold(`Response: ${JSON.stringify(res.body)}`));
        return done(new Error('test15 fail: fault is not a string'));
      }
      return done();
    });
  });
});
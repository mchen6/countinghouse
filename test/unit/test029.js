const request = require('supertest');
const {deviceIDForName} = require('../../lib/call-address');
const jsf     = require('json-schema-faker');
const chalk   = require('chalk');
const {testPort} = require('../helpers/test-env');

jsf.option({
  alwaysFakeOptionals: true
});

const url = `http://127.0.0.1:${testPort(9527)}`;

describe('test29: invoke action which throws inside a detached setTimeout', function() {
  this.timeout(0);
  const req = { serviceID: 'urn:countinghouse-com:serviceID:errorInfoTestService', actionName: 'testAsyncThrowInDomain', input: {} };

  // testAsyncThrowInDomain throws inside a bare setTimeout that never calls
  // its own callback -- the exception happens fully detached from the
  // try/catch in Service.prototype.doActionCall (lib/service.js), so it
  // can no longer be caught there (that capability was specific to the
  // deprecated `domain` module, removed in favor of try/catch -- see the
  // comment above doActionCall). The request now times out instead of
  // getting a fast structured error.
  it('never calls back, so the request times out as DEVICE_NOT_RESPONDING', (done) => {
    request(url).post(`/devices/${deviceIDForName('echo-device')}/invoke-action`)
    .set('X-CH-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, (err, res) => {
      if (err) return done(err);

      if (res.body.code !== 'DEVICE_NOT_RESPONDING'
      ) {
        console.error(chalk.white.bgRed.bold(`Request:${JSON.stringify(req)}`));
        console.error(chalk.white.bgRed.bold(`Response: ${JSON.stringify(res.body)}`));
        return done(new Error('test29 fail'));
      }
      return done();
    });
  });
});
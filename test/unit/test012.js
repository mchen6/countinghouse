const request = require('supertest');
const {deviceIDForName} = require('../../lib/call-address');
const jsf     = require('json-schema-faker');
const chalk   = require('chalk');
const {testPort} = require('../helpers/test-env');

jsf.option({
  alwaysFakeOptionals: true
});

const url = `http://127.0.0.1:${testPort(9527)}`;

describe('test12: invoke specify input validation', function() {
  this.timeout(0);
  const req = { serviceID: 'urn:countinghouse-com:serviceID:echoService', actionName: 'echo', input: {foo: 111} };

  it('invoke without specifying input', (done) => {
    request(url).post(`/devices/${deviceIDForName('echo-device')}/invoke-action`)
    .set('X-CH-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(400, (err, res) => {
      if (err) return done(err);

      if (res.body.code !== 'INPUT_DATA_VALIDATION_FAIL'
        || res.body.fault.info.dataPath == null
        || res.body.fault.info.schemaPath == null
        || res.body.fault.info.validatorMessage == null
      ) {
        console.error(chalk.white.bgRed.bold(`Request:${JSON.stringify(req)}`));
        console.error(chalk.white.bgRed.bold(`Response: ${JSON.stringify(res.body)}`));
        return done(new Error('test5 invoke specify input validation fail'));
      }
      return done();
    });
  });
});
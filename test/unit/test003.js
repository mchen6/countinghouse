const request = require('supertest');
const {deviceIDForName} = require('../../lib/call-address');
const jsf     = require('json-schema-faker');
const chalk   = require('chalk');
const {testPort} = require('../helpers/test-env');

jsf.option({
  alwaysFakeOptionals: true
});

const url = `http://127.0.0.1:${testPort(9527)}`;



describe('test3: invoke without specifying serviceID', function() {
  this.timeout(0);
  const req = { actionName: 'pseudo', input: {} };

  it('invoke without specifying serviceID', (done) => {
    request(url).post(`/devices/${deviceIDForName('echo-device')}/invoke-action`)
    .set('X-CH-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(400, (err, res) => {
      if (err) return done(err);
      if (res.body.code !== 'SERVICEID_NOT_AVAILABLE') {
        console.error(chalk.white.bgRed.bold(`Request:${JSON.stringify(req)}`));
        console.error(chalk.white.bgRed.bold(`Response: ${JSON.stringify(res.body)}`));
        return done(new Error('test invoke without specifying serviceID fail'));
      }
      return done();
    });
  });
});




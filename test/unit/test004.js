const request = require('supertest');
const {deviceIDForName} = require('../../lib/call-address');
const jsf     = require('json-schema-faker');
const chalk   = require('chalk');
const {testPort} = require('../helpers/test-env');

jsf.option({
  alwaysFakeOptionals: true
});

const url = `http://127.0.0.1:${testPort(9527)}`;

describe('test4: invoke with unknown serviceID', function() {
  this.timeout(0);
  const req = { serviceID: 'pseudo', actionName: 'pseudo', input: {} };

  it('invoke with unknown serviceID', (done) => {
    request(url).post(`/devices/${deviceIDForName('echo-device')}/invoke-action`)
    .set('X-CH-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(404, (err, res) => {
      if (err) return done(err);
      if (res.body.code !== 'ACTION_NOT_FOUND') {  // (a missing service answers as a missing action: post-rel caller 400)
        console.error(chalk.white.bgRed.bold(`Request:${JSON.stringify(req)}`));
        console.error(chalk.white.bgRed.bold(`Response: ${JSON.stringify(res.body)}`));
        return done(new Error('test invoke with unknown serviceID fail'));
      }
      return done();
    });
  });
});

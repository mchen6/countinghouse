const request = require('supertest');
const jsf     = require('json-schema-faker');
const chalk   = require('chalk');
const {testPort} = require('../helpers/test-env');

jsf.option({
  alwaysFakeOptionals: true
});

const url = `http://127.0.0.1:${testPort(9527)}`;

describe('test2: unknown deviceID', function() {
  this.timeout(0);
  const req = { serviceID: 'pseudo', actionName: 'pseudo', input: {} };

  it('invoke unknown deviceID', (done) => {
    request(url).post('/devices/b752c14b-27ec-5374-f2c1-123456789abc/invoke-action')
    .set('X-CH-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    // (post-rel caller 400: REST's one answer for a device the caller can't
    // use, whatever the reason, 404)
    .expect(404, (err, res) => {
      if (err) return done(err);
      if (res.body.code !== 'MODULE_NOT_LISTED') {
        console.error(chalk.white.bgRed.bold(`Request:${JSON.stringify(req)}`));
        console.error(chalk.white.bgRed.bold(`Response: ${JSON.stringify(res.body)}`));
        return done(new Error('test unknown deviceID fail'));
      }
      return done();
    });
  });
});

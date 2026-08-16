const request = require('supertest');
const jsf     = require('json-schema-faker');
const chalk   = require('chalk');

jsf.option({
  alwaysFakeOptionals: true
});

const url = 'http://127.0.0.1:9527';

describe('test2: unknown deviceID', function() {
  this.timeout(0);
  const req = { serviceID: 'pseudo', actionName: 'pseudo', input: {} };

  it('invoke unknown deviceID', (done) => {
    request(url).post('/devices/b752c14b-27ec-5374-f2c1-123456789abc/invoke-action')
    .set('X-CH-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, (err, res) => {
      if (err) return done(err);
      if (res.body.code !== 'DEVICE_NOT_FOUND') {
        console.error(chalk.white.bgRed.bold(`Request:${JSON.stringify(req)}`));
        console.error(chalk.white.bgRed.bold(`Response: ${JSON.stringify(res.body)}`));
        return done(new Error('test unknown deviceID fail'));
      }
      return done();
    });
  });
});

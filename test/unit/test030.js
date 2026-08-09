var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://127.0.0.1:9527';

describe('test30: invoke async action which throws inside a never-settling Promise', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:countinghouse-com:serviceID:errorInfoTestService', actionName: 'testAsyncThrowInAsync', input: {} };

  // testAsyncThrowInAsync's Promise executor throws inside a setTimeout and
  // never calls resolve/reject, so `await action.invoke(args)` in
  // Service.prototype.doActionCall's async branch (lib/service.js) never
  // settles either -- the exception happens fully detached, same as
  // test029's callback-style case, and try/catch cannot catch it (see the
  // comment above doActionCall). The request times out instead of getting
  // a fast structured error.
  it('never settles, so the request times out as DEVICE_NOT_RESPONDING', function(done) {
    request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
    .set('X-CH-Key', 'aabbcc')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);

      if (res.body.topic !== 'device error' ||
          res.body.code !== 'DEVICE_NOT_RESPONDING'
      ) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test30 fail'));
      }
      return done();
    });
  });
});
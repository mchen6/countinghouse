const request = require('supertest');
const jsf     = require('json-schema-faker');
const chalk   = require('chalk');
const BSON    = require('bson');
const redis   = require('redis');
redisClient = redis.createClient();

jsf.option({
  alwaysFakeOptionals: true
});

const url = 'http://127.0.0.1:9527';

const LOG_KEY           = 'list:aabbcc#c5284c70-ae5f-591c-b2f1-cf0b4ebd0767#urn:countinghouse-com:serviceID:echoService#echo';
const SETTLE_POLL_MS    = 200;
const SETTLE_STABLE     = 3;    // identical consecutive reads that count as quiesced
const SETTLE_TIMEOUT_MS = 15000;

// The API log entry is written to redis outside the request/response cycle,
// so the invoke's 200 can land before the LPUSH has. Reading llen straight
// out of the .expect(200) callback races that write and intermittently sees
// the pre-invoke length.
//
// Polling until the length simply reaches beforeLen+1 would weaken the test:
// it asserts *exactly* one new entry, so stopping the moment +1 appears
// would hide a duplicate log write arriving just after. Wait for the length
// to stop changing instead, then assert the exact value -- the same approach
// test/direct-peer-channels/06-no-double-billing.js uses for balance reads.
function settledLen(cb) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last     = null;
  let stable   = 0;

  (function poll() {
    redisClient.llen(LOG_KEY, (err, len) => {
      if (err) return cb(err);

      stable = (last !== null && len === last) ? stable + 1 : 1;
      last   = len;

      if (stable >= SETTLE_STABLE) return cb(null, len);
      if (Date.now() >= deadline) {
        return cb(new Error(`API log length never settled within ${SETTLE_TIMEOUT_MS}ms (last read ${len})`));
      }
      setTimeout(poll, SETTLE_POLL_MS);
    });
  })();
}

describe('test25: test API log feature', function() {
  this.timeout(0);
  const req = { serviceID: 'urn:countinghouse-com:serviceID:echoService', actionName: 'echo', input: { foo: [], bar: 'vv'} };

  it('invoke should write API log to redis', (done) => {
    settledLen((err, beforeLen) => {
      if (err) return done(err);

      request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
      .set('X-CH-Key', 'aabbcc')
      .send(req)
      .expect('Content-Type', /[json | text]/)
      .expect(200, (err, res) => {
        if (err) return done(err);
        settledLen((err, afterLen) => {
          redisClient.end(true);
          if (err) return done(err);
          if ((beforeLen + 1) !== afterLen) {
            return done(new Error(`API log length mismatch: expected ${beforeLen + 1} (one new entry), got ${afterLen}`));
          }
          return done();
        });
      });
    });
  });
});

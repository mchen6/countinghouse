'use strict';

// job-control.js's initJobProcess with a redisUrl url.parse refuses: the
// parse error is logged and returned, never a ReferenceError from the catch
// (it once read `err` there, inside catch (e)). It returns before any queue
// is built, so nothing connects to a Redis.

const assert = require('assert');

describe('jobs-local 02: a redisUrl url.parse refuses is logged, not thrown', () => {
  const options = require('../../lib/cli-options');
  const LOG = require('../../lib/logger');
  let redisUrl;
  let logE;
  let logged;
  before(() => {
    redisUrl = options.redisUrl;
    logE = LOG.E;
    options.redisUrl = undefined;
    logged = [];
    LOG.E = (e) => { logged.push(e); return e; };
  });
  after(() => {
    options.redisUrl = redisUrl;
    LOG.E = logE;
  });

  it('initJobProcess logs "redis URL parse fail" with the parse error\'s message, and returns it', () => {
    const jobControl = require('../../lib/job-control');
    let out;
    assert.doesNotThrow(() => { out = jobControl.initJobProcess({}); });
    assert.strictEqual(logged.length, 1);
    assert.match(logged[0].message, /^redis URL parse fail, check redisUrl option: /);
    assert.match(logged[0].message, /"url" argument must be of type string/);
    assert.strictEqual(out, logged[0]);
    assert.strictEqual(jobControl.jobQueue == null, true, 'no queue was built');
  });
});

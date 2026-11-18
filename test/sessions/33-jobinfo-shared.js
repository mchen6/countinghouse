'use strict';
// F1-5 (the Fable pass over asks and tasks): a task's history record
// (jobinfo:<tool>, saveJobInfo) holds its input and output, with no session
// and no expiry, and its one reader is the HTTP get-job-history route. In the
// single-identity profile (--stdio or --sessionSocket: ch-local's), which
// serves no HTTP, it is not written at all; elsewhere it is, as before.
// Server-free: the store's client stood in.
const assert = require('assert');
require('../../lib/logger').createLogger();

describe('sessions 33: a task\'s history record where nothing reads it (F1-5)', () => {
  const common = require('../../lib/job-control-common');
  const redisAPI = require('../../lib/redis-api');
  const options = require('../../lib/cli-options');
  let saved;
  let savedSingle;
  let pushed;
  beforeEach(() => {
    saved = redisAPI.client;
    savedSingle = options.singleIdentity;
    pushed = [];
    redisAPI.client = {lpush: (k, v) => pushed.push([k, v]), ltrim: () => {}};
  });
  afterEach(() => {
    redisAPI.client = saved;
    options.singleIdentity = savedSingle;
  });
  // (no owner key: the record is made with no owner tag, so no identity is needed)
  const job = () => ({id: '1', name: 'report', data: {input: {secret: 'the input'}}, opts: {}, progress: 0, returnvalue: {output: 'the output'}});

  it('in the single-identity profile (--stdio or --sessionSocket), nothing is written', () => {
    options.singleIdentity = true;
    common.saveJobInfo(job(), 'completed');
    assert.deepStrictEqual(pushed, []);
  });

  it('where HTTP is served, the record is written as before', () => {
    options.singleIdentity = false;
    common.saveJobInfo(job(), 'completed');
    assert.strictEqual(pushed.length, 1);
    assert.strictEqual(pushed[0][0], 'jobinfo:report');
  });
});

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
  // (the history's key is this server's: B-j1)
  require('../helpers/server-id').useServerId();
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

  it('where HTTP is served, the record is written as before, in this server\'s own list: jobinfo:{chj-<server id>}:<name> (B-j1)', () => {
    options.singleIdentity = false;
    common.saveJobInfo(job(), 'completed');
    assert.deepStrictEqual(pushed.map((p) => p[0]), [`jobinfo:{chj-${require('../../lib/server-id').get()}}:report`]);
  });

  it('with no server id there is no key: the record is not written, under the unscoped key of before or any, and the refusal is logged (B-j1)', () => {
    // (a process of its own: this one's id is never taken away under it)
    const path = require('path');
    const lib = (m) => JSON.stringify(path.join(__dirname, '..', '..', 'lib', m));
    const r = require('child_process').spawnSync(process.execPath, ['-e', `
      const LOG = require(${lib('logger')});
      LOG.createLogger();
      let logged = null;
      LOG.E = (e) => { logged = e.message; };
      const pushed = [];
      require(${lib('redis-api')}).client = {lpush: (k) => pushed.push(k), ltrim: () => {}};
      require(${lib('job-control-common')}).saveJobInfo({id: '1', name: 'report', data: {}, opts: {}, progress: 0}, 'completed');
      process.stdout.write(JSON.stringify({logged, pushed}));`], {encoding: 'utf8', timeout: 20000});
    assert.deepStrictEqual(JSON.parse(r.stdout), {logged: 'server-id: not initialized', pushed: []}, r.stderr);
  });
});

'use strict';
// M8, server free: a successful call is said where it is recorded
// (CdifInterface.recordCall emits 'callrecorded', which the listen hub turns
// into resources/updated), with the call's session from each recording site:
// here the local job runner (a job's run) and the peer broker (a direct
// peer invoke's bill). A call with no key is not recorded, nor said.
const assert = require('assert');
const events = require('events');
const CdifInterface = require('../../lib/countinghouse-interface');
const {createRunner} = require('../../lib/job-control-local');
const {INTERNAL} = require('../../lib/job-control-common');
const jobSessions = require('../../lib/job-sessions');
const options = require('../../lib/cli-options');
const PeerChannelBroker = require('../../lib/peer-channel-broker');
const CHUtil = require('../../lib/countinghouse-util');

const S = 'a'.repeat(32);
async function until(check, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise((r) => setTimeout(r, 10)); }
  return false;
}

describe('mcp-contract 33: a call recorded is a call said, with its session (M8)', function() {
  this.timeout(20000);
  // (its jobs' owner known to the identity index, as a server's: B-meter-keys (2))
  require('../helpers/identity-scope').useIdentity(['k']);

  it('recordCall says each recorded call with its session, before metering answers; a call with no key is neither', () => {
    const ci = Object.create(CdifInterface.prototype);
    events.EventEmitter.call(ci);
    const metered = [];
    ci.meteringProvider = {recordCall: (k, t, c, cb) => { metered.push(k); cb(null, {}); }};
    const said = [];
    ci.on('callrecorded', (c) => said.push(c));
    ci.recordCall('k', 'dev::svc::act', 0, () => {}, {session: S});
    ci.recordCall('k', 'dev::svc::act', 0, () => {});
    ci.recordCall(null, 'dev::svc::act', 0, () => {}, {session: S});
    assert.deepStrictEqual(said, [{apiKey: 'k', tool: 'dev::svc::act', session: S}, {apiKey: 'k', tool: 'dev::svc::act', session: null}]);
    assert.strictEqual(metered.length, 3, 'metering is asked as before');
  });

  describe('the local job runner', () => {
    let saved;
    beforeEach(() => {
      jobSessions.resetForTests();
      saved = {workerThread: options.workerThread};
      options.workerThread = true;
    });
    afterEach(() => Object.assign(options, saved));

    it('a job\'s run records its call with the session the job was made in', async () => {
      const recorded = [];
      const ci = {recordCall: (k, t, c, cb, opts) => { recorded.push({k, t, opts}); if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback) => setImmediate(callback, null, {ok: 1})};
      const runner = createRunner({jobTimeoutMs: 0});
      runner.authorizeRun = require('../helpers/identity-scope').authorizedRun;
      runner.initJobProcess(ci);
      const added = await new Promise((resolve) => runner.addJob({appKey: 'k', session: S}, {name: 'n'}, 'dev', 'svc', 'act', {}, (err, r) => resolve({err, r})));
      assert.ifError(added.err);
      const state = () => new Promise((resolve) => runner.getJob(INTERNAL, added.r.id, (err, r) => resolve(r != null ? r.state : null)));
      assert.ok(await until(async () => (await state()) === 'completed'));
      assert.ok(await until(() => recorded.length === 1), JSON.stringify(recorded));
      assert.deepStrictEqual(recorded[0].opts, {session: S});
      runner.close();
    });
  });

  describe('the peer broker', () => {
    let savedCi;
    beforeEach(() => { savedCi = CHUtil.ci; });
    afterEach(() => { CHUtil.ci = savedCi; });

    it('a peer invoke\'s bill records its call with the session its announcement carried', async () => {
      const recorded = [];
      CHUtil.ci = {recordCall: (k, t, c, cb, opts) => { recorded.push({k, t, opts}); cb(null, {charged: 0}); }};
      const replies = [];
      const wm = {sendPeerMeteringReplyToChild: (m) => replies.push(m)};
      const due = {billingKey: 'k', tool: 'dev::svc::act', session: S, progress: null};
      PeerChannelBroker.prototype.billChecked.call({}, due, 1, wm, new ArrayBuffer(1), () => {});
      assert.ok(await until(() => replies.length === 1));
      assert.deepStrictEqual(recorded.map((r) => [r.k, r.t, r.opts]), [['k', 'dev::svc::act', {session: S}]]);
    });
  });
});

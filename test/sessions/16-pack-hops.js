'use strict';
// Shared runtime B3, Task 3b (its first cases): a peer-channel deny that
// depends on the requesting call fails that call only.
//
// On master a channel request carries the first queued call's token, and a
// deny fails every call queued for the device (flushPendingPeerInvokes),
// except CALL_TOKEN_INVALID, which fails the head and asks again with the
// next call's token. The queue holds calls of several sessions, and once a
// deny can depend on the token's session (Task 4) B's deny would fail A's
// call. So a deny that depends on the call is marked headOnly: the worker
// fails the head call and asks again with the next one's token. headOnly is
// on every DEVICE_NOT_FOUND deny, for a device never hosted too, so the
// message is the same bytes whether the callee is hidden or absent; it
// names no session. Server-free: the worker's peer methods on a stand-in,
// and the broker with stand-in workers.
const assert = require('assert');
const {methods} = require('../../lib/peer-worker');
const callTokens = require('../../lib/call-tokens');

describe('sessions 16: a peer-channel deny fails only the call it is about (shared runtime B3, Task 3b)', () => {
  // a caller worker's peer state with calls queued for one device, and what it asks again
  const worker = (tokens) => {
    const failed = [];
    const asked = [];
    const w = {pendingPeerInvokes: {dev: tokens.map((token) => ({serviceID: 's', actionName: 'a', args: {token, input: {}}, callback: (err) => failed.push([token, err != null ? err.code : null])}))},
      peerChannels: {}};
    for (const name of Object.keys(methods)) w[name] = (...a) => methods[name].apply(w, a);
    // the next request is the test's to see, not sent
    w.requestPeerChannel = (m) => asked.push(m.token);
    return {w, failed, asked};
  };
  const deny = (code, extra = {}) => Object.assign({targetDeviceID: 'dev', errMsg: `${code} message`, errCode: code}, extra);

  describe('the worker', () => {
    it('a headOnly deny fails the head call only, and asks again with the next call\'s token', () => {
      const {w, failed, asked} = worker(['t1', 't2', 't3']);
      w.onPeerChannelDeny(deny('DEVICE_NOT_FOUND', {headOnly: true}));
      assert.deepStrictEqual(failed, [['t1', 'DEVICE_NOT_FOUND']]);
      assert.deepStrictEqual(asked, ['t2']);
      assert.deepStrictEqual(w.pendingPeerInvokes.dev.map((q) => q.args.token), ['t2', 't3']);
    });

    it('the last queued call denied headOnly leaves no queue, and asks nothing more', () => {
      const {w, failed, asked} = worker(['t1']);
      w.onPeerChannelDeny(deny('DEVICE_NOT_FOUND', {headOnly: true}));
      assert.deepStrictEqual([failed, asked, w.pendingPeerInvokes.dev], [[['t1', 'DEVICE_NOT_FOUND']], [], undefined]);
    });

    it('three calls queued for a device never hosted: three denies, each for its own call', () => {
      const {w, failed, asked} = worker(['t1', 't2', 't3']);
      for (let i = 0; i < 3; i++) w.onPeerChannelDeny(deny('DEVICE_NOT_FOUND', {headOnly: true}));
      assert.deepStrictEqual(failed, [['t1', 'DEVICE_NOT_FOUND'], ['t2', 'DEVICE_NOT_FOUND'], ['t3', 'DEVICE_NOT_FOUND']]);
      assert.deepStrictEqual(asked, ['t2', 't3']);
    });

    it('CALL_TOKEN_INVALID behaves as on master; any other deny fails every queued call', () => {
      const a = worker(['t1', 't2']);
      a.w.onPeerChannelDeny(deny('CALL_TOKEN_INVALID'));
      assert.deepStrictEqual([a.failed, a.asked], [[['t1', 'CALL_TOKEN_INVALID']], ['t2']]);
      const b = worker(['t1', 't2']);
      b.w.onPeerChannelDeny(deny('ACCESS_DENIED'));
      assert.deepStrictEqual(b.failed, [['t1', 'ACCESS_DENIED'], ['t2', 'ACCESS_DENIED']]);
      assert.deepStrictEqual(b.asked, []);
    });
  });

  describe('the broker', () => {
    const PeerChannelBroker = require('../../lib/peer-channel-broker');
    const issued = [];
    afterEach(() => { for (const t of issued.splice(0)) callTokens.drop(t); });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    it('every DEVICE_NOT_FOUND deny is headOnly, and names no session', async () => {
      const denied = [];
      const requester = {workerId: 41, sendPeerChannelDenyToChild: (m) => denied.push(m),
        bindings: {'d-caller': {identity: null, module: 'caller', targets: new Set(['d-never|svc|act'])}}};
      const b = new PeerChannelBroker({deviceMap: {}, missingDeviceErrorForHop: () => new (require('../../lib/countinghouse-error').CountinghouseError)('DEVICE_NOT_FOUND')});
      const token = callTokens.issue({billingKey: 'k', workerId: 41, deviceID: 'd-caller', session: 'a'.repeat(32)});
      issued.push(token);
      const savedDebug = require('../../lib/cli-options').debug;
      require('../../lib/cli-options').debug = true;   // the access check passes: what is looked at is the missing device
      try {
        b.handleRequest({targetDeviceID: 'd-never', token}, requester);
        await sleep(30);
      } finally {
        require('../../lib/cli-options').debug = savedDebug;
      }
      assert.strictEqual(denied.length, 1, JSON.stringify(denied));
      assert.deepStrictEqual([denied[0].errCode, denied[0].headOnly], ['DEVICE_NOT_FOUND', true]);
      assert.ok(!JSON.stringify(denied[0]).includes('a'.repeat(32)), 'no session in it');
    });
  });
});

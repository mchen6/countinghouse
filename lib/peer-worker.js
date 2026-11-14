// The worker side of direct peer channels (docs/direct-peer-channels-design.md),
// moved from lib/device-manager.js unchanged (lean worker step 3, Task 3a).
// Each function runs with `this` the worker's peer state:
// {peerChannels, peerDeviceWorkerMap, pendingPeerInvokes, workerMessage,
// flushPendingPeerInvokes}. DeviceManager takes them as its own methods for
// now; the lean worker binds them to a plain state object.
const workerThreads = require('worker_threads');
const LOG         = require('./logger');
const options     = require('../lib/cli-options');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const CHUtil      = require('./countinghouse-util');
const PeerChannel = require('./peer-channel');

const methods = {};

// --- direct peer channels (docs/direct-peer-channels-design.md), worker-side, caller role ---
// This is what lib/service-client.js calls instead of
// sendActionInvokeMessageToParent above when --directPeerChannels is on.
// Runs inside a worker thread only.
methods.invokeActionViaPeerChannel = function(appKey, billingKey, deviceID, serviceID, actionName, args, callback) {
  const workerId = this.peerDeviceWorkerMap[deviceID];
  const channel  = (workerId != null) ? this.peerChannels[workerId] : null;

  if (channel != null && channel.closed !== true) {
    // fast path: a live, already-authorized port for this device's worker
    // exists -- invoke directly, zero main-thread involvement (D1/D2),
    // except the one-way announcement of the invoke (R2-1 Task 3).
    return channel.invoke(deviceID, serviceID, actionName, args.input, options.requestTimeoutMs, (err, data, platformMetering) => {
      if (err != null) return callback(CountinghouseError.fromReply(err), data);
      return callback(null, data, platformMetering);
    }, billingKey, args.token);
  }

  // No live channel yet -- either this is the first call ever for this
  // device, or a previous channel to it was invalidated (D4) and this is
  // the call that triggers re-brokering. Queue behind a single in-flight
  // peer-channel-request per deviceID (D1's "A 在等待 grant 期间的后续调用进队列") --
  // only the first caller waiting on a given deviceID actually sends one.
  if (this.pendingPeerInvokes[deviceID] == null) {
    this.pendingPeerInvokes[deviceID] = [];
    // with the call's token (R2-1 Task 4): the broker opens a channel only to
    // a device the calling module declared calls on
    this.workerMessage.sendPeerChannelRequestToParent({targetDeviceID: deviceID, appKey: appKey, token: args.token});
  }
  this.pendingPeerInvokes[deviceID].push({serviceID: serviceID, actionName: actionName, args: args,
                                          callback: callback, billingKey: billingKey, appKey: appKey});
};

// D1: main thread granted (or re-confirmed, for a device sharing an
// already-open worker pair) a channel for `msg.targetDeviceID`.
methods.onPeerChannelGrant = function(msg) {
  const targetDeviceID = msg.targetDeviceID;
  const targetWorkerId = msg.targetWorkerId;

  this.peerDeviceWorkerMap[targetDeviceID] = targetWorkerId;

  if (msg.port != null && (this.peerChannels[targetWorkerId] == null || this.peerChannels[targetWorkerId].closed === true)) {
    const _this = this;
    this.peerChannels[targetWorkerId] = new PeerChannel(msg.port, {
      workerId: targetWorkerId,
      // R2-1 Task 3 (spec 10b): each invoke is announced to the main thread
      // with the call's token, on the broker's pair key for this channel.
      announce: (invokeId, token) => _this.workerMessage.sendPeerAnnounceToParent(
        {channel: `${workerThreads.threadId}:${targetWorkerId}`, invokeId: invokeId, token: token}),
      // Backpressure (docs/direct-peer-channels.md) -- caller-side cap on
      // outgoing invoke() calls, see lib/peer-channel.js's constructor
      // comment for why this needs to apply on both ends, not just the
      // callee's dispatch.
      maxConcurrentInvokes: options.directPeerChannelsMaxConcurrency,
      onClose: function() {
        // D4/port 'close': nothing to actively clean up in
        // peerDeviceWorkerMap -- invokeActionViaPeerChannel already checks
        // channel.closed before trusting a cached deviceID->workerId
        // mapping, so the next call to any device on this worker naturally
        // re-triggers brokering (D1's "对调用方模块代码完全透明").
        if (_this.peerChannels[targetWorkerId] === this) delete _this.peerChannels[targetWorkerId];
      }
    });
  }

  this.flushPendingPeerInvokes(targetDeviceID, targetWorkerId, null);
};

// D3: main thread denied brokering (unknown device, self-target, or the
// grant-time userAuth check failed).
// msg carries the denial's rendered text and its code (errMsg, errCode),
// decoded as every other reply is (fromReplyFields): the text once, not
// rendered again around itself (high review of #37).
// The main thread refused this worker's announcement of a peer invoke
// (--moduleMessageRate; the review of #138, 6): the invoke fails at once
// with the refusal, instead of waiting out the callee's refusal a second
// later. {channel, invokeId, errMsg, errCode}; the channel key's second
// half is the callee worker, which is how this side keys its channels.
methods.onPeerAnnounceRefused = function(msg) {
  if (msg == null || typeof(msg.channel) !== 'string') return;
  const targetWorkerId = Number(msg.channel.split(':')[1]);
  const channel = this.peerChannels[targetWorkerId];
  if (channel == null) return;
  channel.fail(msg.invokeId, CountinghouseError.fromReplyFields({errMsg: msg.errMsg, errCode: msg.errCode != null ? msg.errCode : 'RATE_LIMITED'}));
};

methods.onPeerChannelDeny = function(msg) {
  const err = CountinghouseError.fromReplyFields({errMsg: msg.errMsg, errCode: msg.errCode != null ? msg.errCode : 'PEER_CHANNEL_DENIED'});
  // The request carried the first queued call's token. That token refused
  // (its call over), only that call fails; the next queued call asks again
  // with its own.
  const queued = (this.pendingPeerInvokes != null) ? this.pendingPeerInvokes[msg.targetDeviceID] : null;
  if (err.code === 'CALL_TOKEN_INVALID' && queued != null && queued.length > 1) {
    const head = queued.shift();
    head.callback(err);
    return this.workerMessage.sendPeerChannelRequestToParent({targetDeviceID: msg.targetDeviceID, appKey: queued[0].appKey, token: queued[0].args.token});
  }
  this.flushPendingPeerInvokes(msg.targetDeviceID, null, err);
};

methods.flushPendingPeerInvokes = function(deviceID, workerId, err) {
  const queued = this.pendingPeerInvokes[deviceID];
  delete this.pendingPeerInvokes[deviceID];
  if (queued == null) return;

  const channel = (workerId != null) ? this.peerChannels[workerId] : null;

  queued.forEach((item) => {
    if (err != null || channel == null) {
      return item.callback(err != null ? err : new CountinghouseError('PEER_GONE'));
    }
    channel.invoke(deviceID, item.serviceID, item.actionName, item.args.input, options.requestTimeoutMs, (cErr, data, platformMetering) => {
      if (cErr != null) return item.callback(CountinghouseError.fromReply(cErr), data);
      return item.callback(null, data, platformMetering);
    }, item.billingKey, item.args.token);
  });
};

// --- direct peer channels, worker-side, callee role ---
// D1: main thread is handing this worker a brand new port to register as
// callee for `callerWorkerId`. D5's metering hook lives here too: every
// incoming peer-invoke on this channel is metered via a synchronous
// request/reply to the main thread's PeerChannelBroker.handleMeteringRequest
// (the platform's sole billing authority -- see that method's own comment,
// and docs/composite-tools.md's "billing authority" principle) before the
// reply goes back to the caller, so the caller can see the real
// {charged, balance} result via reply's 3rd callback arg instead of
// metering itself redundantly (this is what used to cause double-billing).
//
// The metering result is passed as reply's 3rd argument, never merged into
// `data` -- `data` is the callee action's own, already-schema-validated
// return value, and some caller-side modules pass it straight through as
// *their own* action's output (e.g. echo-device-client-module's
// 服务名称-API名称.js). Merging an extra field into it broke that
// pass-through's own output validation (Service.prototype.validateActionCall
// throws on an unrecognized key), which silently hung the call until the
// session's 30s timeout -- see lib/peer-channel.js's _dispatchInvoke for
// the same note.
methods.onPeerChannelOpen = function(msg) {
  const _this = this;
  const callerWorkerId = msg.callerWorkerId;
  // The devices the broker granted on this channel, each with the actions
  // the calling module declared on it (R2-1 Task 4): the one it opened for,
  // and each later grant (onPeerChannelAllow). Module code can post on its
  // own end of a channel, so an invoke for any other device this worker
  // hosts is refused (review R2-2), and one for an undeclared action is
  // refused here, with no main round trip per invoke.
  const allowed = new Map([[msg.targetDeviceID, grantedActions(msg)]]);

  const channel = new PeerChannel(msg.port, {
    workerId: callerWorkerId,
    callerModule: null,   // no key crosses to the callee (R2-1 Task 4's review)
    // Backpressure (docs/direct-peer-channels.md's benchmark finding) --
    // see lib/peer-channel.js's maxConcurrentInvokes comment.
    maxConcurrentInvokes: options.directPeerChannelsMaxConcurrency,
    onInvoke: function(request, reply) {
      if (!allowed.has(request.deviceID)) {
        return reply(new CountinghouseError('PEER_NOT_GRANTED', String(request.deviceID).slice(0, 64)), null);
      }
      if (!allowed.get(request.deviceID).has(`${request.serviceID}|${request.actionName}`)) {
        return reply(new CountinghouseError('CTX_CALL_UNDECLARED', `${request.serviceID}/${request.actionName}`), null);
      }
      // The callee's work bills by its own token for this invoke (below), so
      // no key is handed to it (R2-1 Task 5, #130's interim args.ctx
      // removed). The key the caller states rides to the metering request,
      // which the main thread ignores for the token's.
      const billingKey = request.billingKey;
      // R2-1 Task 3: the peer path authorizes BEFORE it serves and bills on
      // success (spec 3 and 10b, as amended). The main thread matches this
      // request to the caller worker's announcement of the invoke; one it
      // cannot match runs no handler. The reply carries this worker's own
      // token for the invoke, which the handler's ctx runs under; after the
      // handler succeeds, the bill request cites it and the hop is billed
      // to the announced call's caller, as the routed path bills: a failed
      // hop costs nothing on either path. callerModule rides beside the
      // token until Task 5; the main thread ignores it.
      _this.workerMessage.sendPeerMeteringRequestToParent({
        channel:      `${callerWorkerId}:${workerThreads.threadId}`,
        invokeId:     request.id,
        callerModule: billingKey,
        deviceID:     request.deviceID,
        serviceID:    request.serviceID,
        actionName:   request.actionName
      }, (matchErr, unused, token) => {
        if (matchErr != null) return reply(matchErr, null, null);
        // CdifInterface.prototype.invokeDeviceAction, same call the existing
        // main-thread-routed 'invoke-action' case in lib/lean-worker.js makes --
        // reached via CHUtil.ci (set by CdifInterface's own constructor)
        // rather than a direct reference, since DeviceManager doesn't
        // otherwise keep a back-pointer to the CdifInterface that owns it.
        const callArgs = Object.assign({input: request.input}, (typeof(token) === 'string') ? {token: token} : {});
        CHUtil.ci.invokeDeviceAction(request.deviceID, request.serviceID, request.actionName, callArgs, (err, data) => {
          if (err != null) {
            // not served: the main thread drops the invoke's token, bills nothing
            if (typeof(token) === 'string') _this.workerMessage.sendPeerBillRequestToParent({token: token, served: false}, () => {});
            return reply(err, data);
          }
          _this.workerMessage.sendPeerBillRequestToParent({token: token}, (meteringErr, meteringResult) => {
            if (meteringErr != null) LOG.E(meteringErr);
            return PeerChannel.finishMeteredHop(meteringErr, data, meteringResult, reply);
          });
        });
      });
    },
    onClose: function() {
      if (_this.peerChannels[callerWorkerId] === this) delete _this.peerChannels[callerWorkerId];
    }
  });

  channel.allowedDevices = allowed;
  this.peerChannels[callerWorkerId] = channel;
};

// The declared actions a grant carries, as a Set. A grant without its list
// (no sender in this tree omits it) grants no action, fail closed, and says
// so in the log rather than leaving every invoke to fail unexplained.
function grantedActions(msg) {
  if (Array.isArray(msg.actions)) return new Set(msg.actions);
  LOG.E(new Error(`peer channel grant for ${String(msg.targetDeviceID || msg.deviceID).slice(0, 64)} came with no declared actions: every invoke on it will be refused CTX_CALL_UNDECLARED`));
  return new Set();
}

// Callee side: one more device granted on the channel from callerWorkerId.
methods.onPeerChannelAllow = function(msg) {
  const channel = this.peerChannels[msg.callerWorkerId];
  if (channel != null && channel.allowedDevices != null) channel.allowedDevices.set(msg.deviceID, grantedActions(msg));
};

// D4: main thread (or this worker's own PeerChannel 'close' listener, as a
// second, main-thread-independent safety net) says the channel to
// `msg.workerId` is no longer valid. Invalidating a PeerChannel that's
// already closed is a no-op (see PeerChannel.prototype.invalidate).
methods.onPeerInvalidate = function(msg) {
  const channel = this.peerChannels[msg.workerId];
  if (channel != null) channel.invalidate();
};

module.exports = {methods, grantedActions};

'use strict';
// The worker side of direct peer channels (docs/direct-peer-channels-design.md),
// moved from lib/device-manager.js unchanged (lean worker step 3, Task 3a).
// Each function runs with `this` the worker's peer state:
// {peerChannels, peerDeviceWorkerMap, pendingPeerInvokes, workerMessage,
// flushPendingPeerInvokes}. DeviceManager takes them as its own methods for
// now; the lean worker binds them to a plain state object.
// lib/thread-info.js (its threadId), not worker_threads: loaded on first use
// in a lean worker, after the lockdown
const workerThreads = require('./thread-info');
// the logger only on an error line (in a worker, the worker's: lib/logger.js)
const log         = require('./lazy-require').lazy('./logger');
const options     = require('../lib/cli-options');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const PeerChannel = require('./peer-channel');
// (port-scope's, taken at the worker's boot: this file loads on first use)
const {ownField} = require('./port-scope');
const {serialize, serializeOutput, NotJson, notJsonError, toArrayBuffer, decode} = require('./serialized-result');

const methods = {};

// --- direct peer channels (docs/direct-peer-channels-design.md), worker-side, caller role ---
// This is what lib/service-client.js calls instead of
// sendActionInvokeMessageToParent above when --directPeerChannels is on.
// Runs inside a worker thread only.
methods.invokeActionViaPeerChannel = function(deviceID, serviceID, actionName, args, callback) {
  const workerId = this.peerDeviceWorkerMap[deviceID];
  const channel  = (workerId != null) ? this.peerChannels[workerId] : null;

  if (channel != null && channel.closed !== true) {
    // fast path: a live, already-authorized port for this device's worker
    // exists -- invoke directly, zero main-thread involvement (D1/D2),
    // except the one-way announcement of the invoke (R2-1 Task 3).
    // the calling call's own timeout (lib/call-limits.js, by its token)
    return channel.invoke(deviceID, serviceID, actionName, args.input, require('./call-limits').forToken(args.token).requestTimeout, (err, data, platformMetering) => {
      if (err != null) return callback(CountinghouseError.fromReply(err), data);
      return callback(null, data, platformMetering);
    }, args.token);
  }

  // No live channel yet -- either this is the first call ever for this
  // device, or a previous channel to it was invalidated (D4) and this is
  // the call that triggers re-brokering. Queue behind a single in-flight
  // peer-channel-request per deviceID (D1's "A 在等待 grant 期间的后续调用进队列") --
  // only the first caller waiting on a given deviceID actually sends one.
  const first = this.pendingPeerInvokes[deviceID] == null;
  if (first) this.pendingPeerInvokes[deviceID] = [];
  this.pendingPeerInvokes[deviceID].push({serviceID: serviceID, actionName: actionName, args: args, callback: callback});
  // with the call's token (R2-1 Task 4): the broker opens a channel only to
  // a device the calling module declared calls on
  if (first) this.requestPeerChannel({targetDeviceID: deviceID, token: args.token});
};

// A peer-channel-request over the message cap (#170: a device ID is the
// module's) is never posted: the calls queued for it fail with that, at once.
methods.requestPeerChannel = function(data) {
  try {
    this.workerMessage.sendPeerChannelRequestToParent(data);
  } catch (e) {
    process.nextTick(() => this.flushPendingPeerInvokes(data.targetDeviceID, null, e));
  }
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
      // An announcement that cannot be posted (#170: over the cap) fails its
      // invoke, which the callee would otherwise refuse only at its deadline.
      // With it, the invoke's target and input bytes (lean worker step 4, the
      // review of #202): the caller's statement, held by the main thread.
      announce: function(invokeId, token, target, inputBytes, timeLeftMs) {
        try {
          _this.workerMessage.sendPeerAnnounceToParent({channel: `${workerThreads.threadId}:${targetWorkerId}`, invokeId: invokeId, token: token,
            deviceID: target.deviceID, serviceID: target.serviceID, actionName: target.actionName, epoch: target.epoch, inputBytes: inputBytes,
            timeLeftMs: timeLeftMs}, [inputBytes]);
        } catch (e) {
          process.nextTick(() => this.fail(invokeId, e));
        }
      },
      // Backpressure (docs/direct-peer-channels.md) -- caller-side cap on
      // outgoing invoke() calls, see lib/peer-channel.js's constructor
      // comment for why this needs to apply on both ends, not just the
      // callee's dispatch.
      maxConcurrentInvokes: options.directPeerChannelsMaxConcurrency,
      // a result the callee posted on the port, around the main thread's
      // check (lean worker step 4): dropped (lib/peer-channel.js), and said
      onForgedReply: function(invokeId) {
        _this.workerMessage.sendSandboxViolationToParent('peer-forged-reply', `worker ${targetWorkerId} answered invoke ${String(invokeId).slice(0, 32)} on the port`);
      },
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
// later. Lean worker step 4: also a target or input the main thread will not
// hold (the review of #202). {channel, invokeId, epoch, errMsg, errCode};
// the channel key's second half is the callee worker, which is how this side
// keys its channels, and the epoch its grant: a refusal for an earlier
// grant's invoke, whose ids restart at 0, is not this one's.
methods.onPeerAnnounceRefused = function(msg) {
  if (msg == null || typeof(msg.channel) !== 'string') return;
  const targetWorkerId = Number(msg.channel.split(':')[1]);
  const channel = this.peerChannels[targetWorkerId];
  if (channel == null || msg.epoch !== channel.epoch) return;
  channel.fail(msg.invokeId, CountinghouseError.fromReplyFields({errMsg: msg.errMsg, errCode: msg.errCode != null ? msg.errCode : 'RATE_LIMITED'}));
};

// Lean worker step 4: the main thread's answer to an invoke this worker
// announced, {channel, invokeId, dataBuffer?, errorBuffer?, errMsg?,
// errCode?, platformMetering?}: the callee's result checked against its
// output schema, the callee's error, or the main thread's refusal. Only
// bytes a validator passed are decoded here as a result.
methods.onPeerResult = function(msg) {
  if (msg == null || typeof(msg.channel) !== 'string') return;
  const targetWorkerId = Number(msg.channel.split(':')[1]);
  const channel = this.peerChannels[targetWorkerId];
  // an answer for an earlier grant of the channel, whose ids restart at 0
  if (channel == null || msg.epoch !== channel.epoch) return;
  if (msg.dataBuffer instanceof ArrayBuffer) {
    let data;
    try { data = decode(msg.dataBuffer); } catch (e) { return channel.deliver(msg.invokeId, e, null); }
    return channel.deliver(msg.invokeId, null, data, msg.platformMetering);
  }
  if (msg.errorBuffer instanceof ArrayBuffer) {
    let payload;
    try { payload = decode(msg.errorBuffer); } catch (e) { return channel.deliver(msg.invokeId, e, null); }
    const fields = (payload != null && typeof(payload.fields) === 'object') ? payload.fields : null;
    // the callee's own fields: read in a try, as anything it made
    let err;
    try { err = (fields != null) ? CountinghouseError.fromReplyFields(fields) : null; } catch (e) { err = null; }
    if (err == null) err = new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a module\'s error could not be read');
    return channel.deliver(msg.invokeId, err, (payload != null) ? payload.data : null);
  }
  return channel.deliver(msg.invokeId, CountinghouseError.fromReplyFields({errMsg: msg.errMsg, errCode: msg.errCode != null ? msg.errCode : 'DEVICE_INVOKE_EXCEPTION'}), null);
};

methods.onPeerChannelDeny = function(msg) {
  const err = CountinghouseError.fromReplyFields({errMsg: msg.errMsg, errCode: msg.errCode != null ? msg.errCode : 'PEER_CHANNEL_DENIED'});
  // The request carried the first queued call's token. A deny about that
  // call alone (its token refused, its call over; or one the main thread
  // marks headOnly: a device its session doesn't list, or one never hosted,
  // B3 Task 3b) fails only that call; the next queued call asks again with
  // its own, so each is judged by its own token.
  const queued = (this.pendingPeerInvokes != null) ? this.pendingPeerInvokes[msg.targetDeviceID] : null;
  // (the message's own field: never a getter module code put on Object.prototype)
  if ((err.code === 'CALL_TOKEN_INVALID' || ownField(msg, 'headOnly') === true) && queued != null && queued.length > 0) {
    const head = queued.shift();
    if (queued.length === 0) delete this.pendingPeerInvokes[msg.targetDeviceID];
    head.callback(err);
    if (queued.length > 0) return this.requestPeerChannel({targetDeviceID: msg.targetDeviceID, token: queued[0].args.token});
    return;
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
    channel.invoke(deviceID, item.serviceID, item.actionName, item.args.input, require('./call-limits').forToken(item.args.token).requestTimeout, (cErr, data, platformMetering) => {
      if (cErr != null) return item.callback(CountinghouseError.fromReply(cErr), data);
      return item.callback(null, data, platformMetering);
    }, item.args.token);
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
      // Lean worker step 4 (the review of #202): the port carries the
      // invoke's id alone. The caller announced the target and the input
      // bytes to the main thread, which holds them. The main thread matches
      // this request to that announcement (R2-1 Task 3: authorize before
      // serve), checks that the target is a device this worker hosts and the
      // caller declared, caps the bytes and checks them in a validator. It
      // then answers with this worker's token, the target, and the checked
      // bytes: the handler runs exactly that. After it, the result or error
      // goes back as bytes with the bill request, and the main thread
      // delivers it to the caller. Nothing but a refusal goes on the port.
      _this.workerMessage.sendPeerMeteringRequestToParent({
        channel:  `${callerWorkerId}:${workerThreads.threadId}`,
        invokeId: request.id
      }, (matchErr, unused, token, caller, checkedInput, target) => {
        if (matchErr != null) return reply(matchErr);
        const unbill = () => { if (typeof(token) === 'string') _this.workerMessage.sendPeerBillRequestToParent({token: token, channel: `${callerWorkerId}:${workerThreads.threadId}`, invokeId: request.id, served: false}, () => {}); };
        // the main thread's target, checked against this worker's grants too
        if (target == null || typeof(target.deviceID) !== 'string' || !allowed.has(target.deviceID) ||
            !allowed.get(target.deviceID).has(`${target.serviceID}|${target.actionName}`)) {
          unbill();
          return reply(new CountinghouseError('PEER_NOT_GRANTED', String(target != null ? target.deviceID : '').slice(0, 64)));
        }
        let input;
        try {
          input = decode(checkedInput).input;
        } catch (e) {
          unbill();
          return reply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a hop\'s input could not be read'));
        }
        request = {id: request.id, deviceID: target.deviceID, serviceID: target.serviceID, actionName: target.actionName};
        // The invoke is served by the peer state's own invokeDeviceAction (a
        // lean worker's, lib/lean-worker.js), or else by the main thread's
        // CdifInterface (CHUtil.ci; a test's DeviceManager): CHUtil.ci reads as
        // undefined in a worker.
        const serve = (typeof(_this.invokeDeviceAction) === 'function') ? _this : require('./countinghouse-util').ci;
        // the hop's caller as a module sees it, {id, isAdmin}, built on the
        // main thread with the match (R2-1 Task 5)
        const callArgs = Object.assign({input: input}, (typeof(token) === 'string') ? {token: token} : {},
          (caller != null && typeof(caller) === 'object') ? {ctx: {id: caller.id != null ? String(caller.id) : null, isAdmin: caller.isAdmin === true}} : {});
        serve.invokeDeviceAction(request.deviceID, request.serviceID, request.actionName, callArgs, (err, data) => {
          // the answer as bytes, as a routed hop's (lib/lean-worker.js): the
          // result, or the error and its payload; one that cannot cross is
          // answered as a crash
          let bytes = null;
          let field = (err != null) ? 'errorBytes' : 'outputBytes';
          try {
            bytes = toArrayBuffer((err != null) ? serialize({fields: CountinghouseError.replyFields(err), data: (data === undefined) ? null : data}) : serializeOutput(data));
          } catch (e) {
            field = 'errorBytes';
            const why = (e instanceof NotJson)
              ? notJsonError(e, data, (typeof(_this.moduleName) === 'function') ? _this.moduleName() : 'module', request.actionName)
              : new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the result could not be sent between threads');
            bytes = toArrayBuffer(serialize({fields: CountinghouseError.replyFields(why), data: null}));
          }
          const report = Object.assign({token: token, channel: `${callerWorkerId}:${workerThreads.threadId}`, invokeId: request.id},
            (field === 'errorBytes') ? {served: false} : {}, {[field]: bytes});
          _this.workerMessage.sendPeerBillRequestToParent(report, (meteringErr) => {
            // the main thread has answered the caller, whatever it says here
            if (meteringErr != null && meteringErr.code !== 'PEER_CHANNEL_TIMEOUT') log().E(meteringErr);
            return reply();
          }, [bytes]);
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
  log().E(new Error(`peer channel grant for ${String(msg.targetDeviceID || msg.deviceID).slice(0, 64)} came with no declared actions: every invoke on it will be refused CTX_CALL_UNDECLARED`));
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

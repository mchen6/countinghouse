// Main-thread-only broker for direct worker-to-worker peer channels (see
// docs/direct-peer-channels-design.md). Owns the control plane only:
// resolving which worker hosts a target device, the one-time D3
// authorization check, creating/handing out MessageChannel port pairs, and
// invalidating them on reload/unload/crash (D4) or when the grant they were
// opened under is gone (recheckGrants below). Once a channel is granted, no
// call over it comes back here for authorization -- that is the entire point
// of this feature -- so revocation has to be noticed from this side.
//
// D1: port topology is lazy and pairwise, keyed by "callerWorkerId:calleeWorkerId"
// (channelRegistry below), not pre-wired at worker creation and not keyed
// by deviceID (a worker can host multiple devices; one port pair serves
// all of them once a caller has been granted access to that worker).
//
// Deliberately directional: this registry key is NOT the same as its
// reverse ("calleeWorkerId:callerWorkerId"). If the callee's own module
// code later wants to call back into the original caller's devices, that
// is a separate request, authorized and (if needed) ported independently.
// See lib/peer-channel.js's header comment for why the reverse direction
// isn't reused automatically.
const MessageChannel = require('worker_threads').MessageChannel;
const userAuth        = require('./user-auth');
const options          = require('./cli-options');
const LOG              = require('./logger');
const keyFingerprint   = require('./key-fingerprint').keyFingerprint;
const CHUtil           = require('./countinghouse-util');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const encodeLegacyTool = require('./metering/provider').encodeLegacyTool;

function PeerChannelBroker(deviceManager) {
  this.dm = deviceManager;
  // pairKey -> {callerWM, calleeWM, grants}; grants is every (appKey,
  // deviceID) the D3 check has passed for on this pair, keyed by grantKey().
  this.channelRegistry = {};
  this.recheckInFlight = 0;

  // An AuthProvider can change while the server runs (sqlite and CouchDB;
  // not the file provider, which is read once), and nothing tells the server
  // when it does -- the sqlite CLI writes the db file from another process.
  // So the only way to honour a revocation on a channel that is already open
  // is to ask again. Asked on a timer rather than per call: per call would
  // put an AuthProvider lookup back on every hop, which is the cost this
  // path exists to avoid. unref() so the timer never keeps a server alive.
  const seconds = options.peerChannelAuthRecheckSeconds;
  if (seconds > 0) {
    setInterval(() => { this.recheckGrants(); }, seconds * 1000).unref();
  }
}

function grantKey(appKey, deviceID) {
  return `${appKey}\u0000${deviceID}`;
}

// wired from DeviceManager.prototype.onWorkerLoaded, mirroring how every
// other per-worker event (invokeforeignaction, devicelog, ...) is attached.
PeerChannelBroker.prototype.attachToWorker = function(workerMessage) {
  const _this = this;

  workerMessage.on('peer-channel-request', (message, callerWM) => {
    _this.handleRequest(message.data, callerWM);
  });

  workerMessage.on('peer-metering-request', (message, wm) => {
    _this.handleMeteringRequest(message.data, message.id, wm);
  });

  // D4: a worker purged its own devices locally (typically a same-worker
  // in-place reload -- see WorkerMessage.prototype.sendPeerSelfInvalidateToParent
  // for why this can't be detected any other way) and is telling us to
  // invalidate any channel involving it, exactly as if we had noticed the
  // purge ourselves via onPurgeDevice's main-thread branch.
  workerMessage.on('peer-self-invalidate', (message, wm) => {
    _this.invalidateWorker(wm);
  });
};

PeerChannelBroker.prototype.handleRequest = function(data, callerWM) {
  const targetDeviceID = data != null ? data.targetDeviceID : null;
  const appKey          = data != null ? data.appKey : null;

  if (typeof(targetDeviceID) !== 'string') return;

  if (this.dm.deviceMap[targetDeviceID] === callerWM) {
    // Target device is hosted by the requesting worker itself -- a peer
    // channel to your own worker isn't a meaningful concept here (the
    // existing local-invoke path already handles same-worker calls without
    // ever going through isRemoteThread routing in the first place). Not a
    // scenario docs/direct-peer-channels-design.md's D1-D5 describe;
    // rejected explicitly rather than silently mishandled.
    const selfTargetErr = new CountinghouseError('PEER_SELF_TARGET');
    return callerWM.sendPeerChannelDenyToChild({targetDeviceID: targetDeviceID, errMsg: selfTargetErr.message, errCode: selfTargetErr.code});
  }

  // D3: the exact same userAuth device-ownership check every other entry
  // path uses (see lib/device-manager.js's sendInvokeActionMessageToWorker
  // for the main-thread-routed equivalent this exists alongside), but run
  // once per (callerWorkerId, targetDeviceID) here at brokering time
  // instead of once per invoke. localCB is a no-op -- this check only ever
  // decides grant-or-deny, it never itself invokes anything.
  userAuth(null, null, targetDeviceID, appKey, null, null, () => {}, (err) => {
    if (err != null) {
      // userAuth's own errors are always a CountinghouseError, which
      // always sets `.code` (see lib/countinghouse-error.js) -- no
      // made-up fallback code needed here.
      return callerWM.sendPeerChannelDenyToChild({targetDeviceID: targetDeviceID, errMsg: err.message, errCode: err.code});
    }
    // The check is asynchronous, so the workers are looked at again now. A
    // caller that ended meanwhile gets nothing (a port sent its way would
    // leave the callee holding a channel to no one).
    if (!isLive(callerWM)) return;
    // Nor does a callee that is going: a port transferred to a worker that
    // has already exited is dropped without an error, and its other end
    // never closes, so the caller would keep a dead channel and every call
    // over it would wait out the peer timeout. A callee replaced meanwhile
    // (a reload) gets the channel on its new worker: the grant is for the
    // device, not the worker.
    const calleeWM = this.dm.deviceMap[targetDeviceID];
    if (!isLive(calleeWM)) {
      // Why the device is missing (MODULE_RELOADING, MODULE_RESTARTING,
      // MODULE_SUSPENDED, MODULE_UNLOADED, or DEVICE_NOT_FOUND for one never
      // hosted) is answered only after userAuth: a caller without access gets
      // the access error whatever the reason, so it cannot tell a device once
      // hosted here from one never hosted.
      const answer = this.dm.missingDeviceErrorForHop(targetDeviceID);
      return callerWM.sendPeerChannelDenyToChild({targetDeviceID: targetDeviceID, errMsg: answer.message, errCode: answer.code});
    }
    if (calleeWM === callerWM) {
      const selfTargetErr = new CountinghouseError('PEER_SELF_TARGET');
      return callerWM.sendPeerChannelDenyToChild({targetDeviceID: targetDeviceID, errMsg: selfTargetErr.message, errCode: selfTargetErr.code});
    }
    return this.grant(targetDeviceID, appKey, callerWM, calleeWM);
  });
};

// A worker that has neither ended nor begun its unload.
function isLive(wm) {
  return wm != null && wm.ended == null && wm.unloading !== true;
}

PeerChannelBroker.prototype.grant = function(targetDeviceID, appKey, callerWM, calleeWM) {
  const pairKey = `${callerWM.workerId}:${calleeWM.workerId}`;

  if (this.channelRegistry[pairKey] != null) {
    this.channelRegistry[pairKey].grants[grantKey(appKey, targetDeviceID)] = {appKey: appKey, deviceID: targetDeviceID};

    // A live port already connects these two workers (from an earlier
    // request for a different device on the same target worker) -- no new
    // MessageChannel needed. The callee serves only devices granted on the
    // channel, so it learns this one first, and A is told which workerId's
    // cached port to use only once it has (review R2-2).
    return calleeWM.sendPeerChannelAllowToChild({callerWorkerId: callerWM.workerId, deviceID: targetDeviceID}, (err) => {
      if (err != null) return callerWM.sendPeerChannelDenyToChild({targetDeviceID: targetDeviceID, errMsg: err.message, errCode: err.code});
      return callerWM.sendPeerChannelGrantToChild({targetDeviceID: targetDeviceID, targetWorkerId: calleeWM.workerId});
    });
  }

  const channel = new MessageChannel();
  this.channelRegistry[pairKey] = {callerWM: callerWM, calleeWM: calleeWM, grants: {}};
  this.channelRegistry[pairKey].grants[grantKey(appKey, targetDeviceID)] = {appKey: appKey, deviceID: targetDeviceID};

  calleeWM.sendPeerChannelOpenToChild({callerWorkerId: callerWM.workerId, appKey: appKey, targetDeviceID: targetDeviceID}, channel.port2);
  callerWM.sendPeerChannelGrantToChild({targetDeviceID: targetDeviceID, targetWorkerId: calleeWM.workerId, port: channel.port1}, channel.port1);
};

// D5 (docs/composite-tools.md's "billing authority" principle: platform
// automatic metering is the *only* thing that deducts balance for a
// cross-worker call, on either path -- see
// DeviceManager.prototype.sendInvokeActionMessageToWorker for the
// main-thread-routed path's equivalent). Request/reply, not
// fire-and-forget: the callee worker waits for the real {charged,
// balance} result before replying to whichever module made the call (see
// DeviceManager.prototype.onPeerChannelOpen), so that result can be
// threaded back to the calling module instead of it having to guess or
// separately (and redundantly) meter itself.
//
// Calls CHUtil.ci.recordCall directly -- the raw CdifInterface instance,
// not the module-facing CHUtil.recordUsage (lib/countinghouse-util.js),
// which is deliberately *not* wired to MeteringProvider at all anymore
// (see that method's own comment for why). Only platform-internal code
// like this is allowed to touch real billing.
//
// Cost model: reuses options.mcpToolCallCost (the same single
// CLI-configurable cost already applied to MCP-originated recordCall
// calls and to the main-thread-routed path below) rather than inventing a
// second cost knob -- there is no per-module declared pricing yet
// anywhere in the platform (see docs/composite-tools.md's "known
// simplifications").
PeerChannelBroker.prototype.handleMeteringRequest = function(data, msgID, wm) {
  if (data == null || CHUtil.ci == null) {
    return wm.sendPeerMeteringReplyToChild({msgID: msgID, errMsg: 'metering unavailable', meteringResult: null});
  }

  const tool = encodeLegacyTool(data.deviceID, data.serviceID, data.actionName);

  CHUtil.ci.recordCall(data.callerModule, tool, options.mcpToolCallCost, (err, result) => {
    if (err) {
      LOG.E(err);
      return wm.sendPeerMeteringReplyToChild({msgID: msgID, errMsg: err.message, meteringResult: null});
    }
    return wm.sendPeerMeteringReplyToChild({msgID: msgID, errMsg: null, meteringResult: result});
  });
};

// Re-runs the D3 check for every grant behind every open channel and closes
// a channel as soon as one of its grants no longer passes. Closing means
// telling BOTH workers to drop their end and forgetting the pair here, so the
// caller's next call has to be brokered again and is refused by the same
// check, with the same error it would have got had it never held a channel.
//
// Any error counts as a denial, including an AuthProvider that could not be
// reached: a channel whose authorization cannot be confirmed is closed, and
// reopens by itself on the next call once the provider answers again.
//
// A pass that is still waiting on the AuthProvider when the next tick fires
// is not started again on top of itself.
//
// Bound: a revoked grant stops working within one interval plus one lookup.
// Calls already in flight on the channel when it closes fail with PEER_GONE.
PeerChannelBroker.prototype.recheckGrants = function() {
  if (this.recheckInFlight > 0) return;

  for (const pairKey in this.channelRegistry) {
    const entry = this.channelRegistry[pairKey];

    for (const key in entry.grants) {
      const grant = entry.grants[key];

      this.recheckInFlight++;
      userAuth(null, null, grant.deviceID, grant.appKey, null, null, () => {}, (err) => {
        this.recheckInFlight--;
        if (err != null) this.closeRevoked(pairKey, entry, grant, err);
      });
    }
  }
};

PeerChannelBroker.prototype.closeRevoked = function(pairKey, entry, grant, err) {
  // a second failing grant on the same pair, or a worker reload in between,
  // has already taken this channel down
  if (this.channelRegistry[pairKey] !== entry) return;

  delete this.channelRegistry[pairKey];

  // The grant holds only the key; the line names the tenant by fingerprint.
  LOG.I(`peer channel ${pairKey} closed: ${keyFingerprint(grant.appKey)} is no longer authorized for device ${
    grant.deviceID} (${err.code != null ? err.code : err.message})`);

  entry.callerWM.sendPeerInvalidateToChild({workerId: entry.calleeWM.workerId});
  entry.calleeWM.sendPeerInvalidateToChild({workerId: entry.callerWM.workerId});
};

// D4: called from DeviceManager.prototype.onPurgeDevice's main-thread
// branch on reload/unload/crash (all three funnel through 'purgedevice' --
// see that method's comment for how). Finds every channel involving `wm`
// and tells the *other* party to drop its cached port immediately, rather
// than waiting for a call to time out or for the port's own 'close' event
// (which only fires on an actual worker exit, not a same-thread reload).
PeerChannelBroker.prototype.invalidateWorker = function(wm) {
  if (wm == null || wm.workerId == null) return;

  const toRemove = [];

  for (const pairKey in this.channelRegistry) {
    const entry = this.channelRegistry[pairKey];
    if (entry.callerWM !== wm && entry.calleeWM !== wm) continue;

    toRemove.push(pairKey);

    const otherWM = (entry.callerWM === wm) ? entry.calleeWM : entry.callerWM;
    if (otherWM != null && otherWM !== wm) {
      otherWM.sendPeerInvalidateToChild({workerId: wm.workerId});
    }
  }

  toRemove.forEach((pairKey) => { delete this.channelRegistry[pairKey]; });
};

module.exports = PeerChannelBroker;

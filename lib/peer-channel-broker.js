// Main-thread-only broker for direct worker-to-worker peer channels (see
// docs/direct-peer-channels-design.md). Owns the control plane only:
// resolving which worker hosts a target device, the one-time D3
// authorization check, creating/handing out MessageChannel port pairs, and
// invalidating them on reload/unload/crash (D4). Once a channel is granted,
// no call over it touches this broker (or the main thread at all) again --
// that is the entire point of this feature.
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
const CHUtil           = require('./countinghouse-util');
const DeviceError      = require('./countinghouse-error').DeviceError;
const encodeLegacyTool = require('./metering/redis-provider').encodeLegacyTool;

function PeerChannelBroker(deviceManager) {
  this.dm = deviceManager;
  this.channelRegistry = {}; // pairKey -> {callerWM, calleeWM}
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

  const calleeWM = this.dm.deviceMap[targetDeviceID];

  if (calleeWM == null) {
    const notFoundErr = new DeviceError('DEVICE_NOT_FOUND');
    return callerWM.sendPeerChannelDenyToChild({targetDeviceID: targetDeviceID, errMsg: notFoundErr.message, errCode: notFoundErr.code});
  }

  if (calleeWM === callerWM) {
    // Target device is hosted by the requesting worker itself -- a peer
    // channel to your own worker isn't a meaningful concept here (the
    // existing local-invoke path already handles same-worker calls without
    // ever going through isRemoteThread routing in the first place). Not a
    // scenario docs/direct-peer-channels-design.md's D1-D5 describe;
    // rejected explicitly rather than silently mishandled.
    const selfTargetErr = new DeviceError('PEER_SELF_TARGET');
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
      // userAuth's own errors are always a CHError/DeviceError, which
      // always sets `.code` (see lib/countinghouse-error.js) -- no
      // made-up fallback code needed here.
      return callerWM.sendPeerChannelDenyToChild({targetDeviceID: targetDeviceID, errMsg: err.message, errCode: err.code});
    }
    return this.grant(targetDeviceID, appKey, callerWM, calleeWM);
  });
};

PeerChannelBroker.prototype.grant = function(targetDeviceID, appKey, callerWM, calleeWM) {
  const pairKey = `${callerWM.workerId}:${calleeWM.workerId}`;

  if (this.channelRegistry[pairKey] != null) {
    // A live port already connects these two workers (from an earlier
    // request for a different device on the same target worker) -- no new
    // MessageChannel needed, just confirm the deviceID is authorized and
    // tell A which workerId's cached port to use.
    return callerWM.sendPeerChannelGrantToChild({targetDeviceID: targetDeviceID, targetWorkerId: calleeWM.workerId});
  }

  const channel = new MessageChannel();
  this.channelRegistry[pairKey] = {callerWM: callerWM, calleeWM: calleeWM};

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

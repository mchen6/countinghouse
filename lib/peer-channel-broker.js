'use strict';
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
const {meterId}        = require('./key-fingerprint');
const CHUtil           = require('./countinghouse-util');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const {readGuarded} = require('./countinghouse-error');
const meteringProviderLib = require('./metering/provider');
const encodeLegacyTool = meteringProviderLib.encodeLegacyTool;
// required on first use, then kept (lib/require-once.js): device-manager
// requires this file, so it stays lazy; no require() on the hop path
const deviceManagerLib = require('./require-once')(() => require('./device-manager'));
const settingsGate = require('./settings-gate');
const serializedResultLib = require('./require-once')(() => require('./serialized-result'));
const callTokens       = require('./call-tokens');
const identity         = require('./identity');
const moduleSpec       = require('./module-spec');
const hopInput         = require('./hop-input');
const requireOnce      = require('./require-once');
// Whether the device is listed (#413 section 5.5; M5a: no session has a
// view of its own): a device whose module is going on or off is listed to
// no one, and answered as one never hosted, after the access check, at
// every hop (lib/module-visibility.js, main thread only)
const visibilityLib = requireOnce(() => require('./module-visibility'));
const listsDevice = (deviceID) => visibilityLib().listsDevice(deviceID);
const notListed = () => new CountinghouseError('DEVICE_NOT_FOUND');

// R2-1 Task 3 (spec 3, 10b, as amended by the reviewer, 2026-11-13): the
// peer path authorizes before it serves and bills on success. Before the
// handler runs, the callee's metering request is matched to the caller
// worker's announcement of the invoke ({channel, invokeId, token}) and
// answered with a token of the callee's own; an unmatched request runs no
// handler (fail closed). After the handler succeeds, the callee's bill
// request cites that token, and the hop is billed to the announced call's
// caller, once, as the routed path bills: a failed hop costs nothing on
// either path. Main holds a metering request that has no announcement yet
// for up to PEER_ANNOUNCE_WAIT_MS (the two arrive on different ports,
// unordered), then refuses it; at most PEER_HELD_MAX are held per channel,
// more are refused at once; at most UNBILLED_PER_CHANNEL_MAX matched
// invokes await their bill per channel, and one beyond that is refused
// (fail closed, nothing evicted). The balance deduction is waited for up
// to METER_PENDING_MS; past that the hop is answered with its billing
// pending (never "unbilled": the deduction may still charge, and its
// outcome is logged when it comes), so a stalled Redis does not hold the
// callee's dispatch slots (the review of #138, 7, and the medium review of
// the fix). The bill is for the matched invoke, whatever became of the
// callee's token meanwhile (#138, 2a). Past the announcement plus the
// caller's per-invoke timeout (#138, 8; #141, N1) the match is refused and
// a bill is refused, both PEER_CHANNEL_TIMEOUT: nothing is charged and the
// result is not delivered (the handler may have run, for an invoke sent
// just before the deadline). The caller has failed the hop by then, and a
// failed hop costs 0. The caller worker is told nothing and asked nothing
// about it.
const PEER_ANNOUNCE_WAIT_MS = 1000;
const PEER_HELD_MAX = 64;
const ANNOUNCED_MAX = 4096;
// Each caller worker's share of that count: a sixteenth, so one caller's
// live hops, however small, never refuse another caller's, and it takes
// sixteen workers at their share to fill the count (the reviewer's
// follow-up to #288). An honest caller holds at most
// --directPeerChannelsMaxConcurrency (16) a channel: sixteen channels' worth.
const ANNOUNCED_PER_WORKER_MAX = ANNOUNCED_MAX / 16;
// how often, at most, one caller has a full total release every caller's ended hops
const RELEASE_ALL_MIN_MS = 100;
// a target's strings, and the epoch, are at most this long
const TARGET_FIELD_MAX = 256;
// The input bytes announcements may hold, awaiting their match (the review
// of #202, round 3): each share its own, two hops at its cap and at least
// 16 MiB, so one share's unmatched announcements never refuse another's;
// and in all, eight hops at the largest active cap and at least 128 MiB.
// A share (B3 Task 7) is the announcing call's session's in a shared
// runtime, across caller workers (one worker serves every session there),
// at that session's own cap; elsewhere, and for a call of no session, the
// caller worker's, at --maxOutputBytes. Its key: the worker's id, or
// 's:<session>'. The floors are the constructor's options (a test's own).
const capBytes = () => (Number.isInteger(options.maxOutputBytes) ? options.maxOutputBytes : 16 * 1024 * 1024);
const SHARE_FLOOR_BYTES = 16 * 1024 * 1024;
const TOTAL_FLOOR_BYTES = 128 * 1024 * 1024;
const sessionsLib = require('./require-once')(() => require('./sessions'));
const sessionSettingsLib = require('./require-once')(() => require('./session-settings'));
const sessionOfShare = (tokenEntry) => ((sessionsLib().shared() === true && tokenEntry != null && typeof(tokenEntry.session) === 'string') ? tokenEntry.session : null);
const shareKeyOf = (tokenEntry, workerId) => { const s = sessionOfShare(tokenEntry); return s != null ? `s:${s}` : workerId; };
// an invoke's id: the caller's counter, an integer in this range
const INVOKE_ID_MAX = 2 ** 31 - 1;
const invokeIdOk = (id) => Number.isInteger(id) && id >= 0 && id <= INVOKE_ID_MAX;
const UNBILLED_PER_CHANNEL_MAX = 4096;
// (one bound for every hop path: lib/metering/charge-bound.js, B-hopcharge)
const {boundedCharge, chargeLost} = require('./metering/charge-bound');
const CATALOGUE = require('./error-catalogue').CODES;
const SWEEP_MS = 60 * 1000;
// The announcing call's own cap and timeout (lib/call-limits.js): its token
// entry's, which the caller's per-invoke timer is from too (the worker holds
// the call's values by its token). In milliseconds.
const callLimits = require('./call-limits');
const tokenTtlMs = (holder) => callLimits.of(holder).requestTimeout + 60000;
const callerTimeoutMs = (holder) => callLimits.of(holder).requestTimeout;
// An announced or due entry's deadline now: never later than the one it was
// given, nor than its announcement plus its timeout as it is now (a
// tightening's, the session's included: #271's review, 4).
const deadlineNow = (holder) => {
  const now = Number.isFinite(holder.at) ? holder.at + callerTimeoutMs(holder) : Infinity;
  return Number.isFinite(holder.deadline) ? Math.min(holder.deadline, now) : now;
};

function PeerChannelBroker(deviceManager, {shareFloorBytes = SHARE_FLOOR_BYTES, totalFloorBytes = TOTAL_FLOOR_BYTES, countShare = ANNOUNCED_PER_WORKER_MAX} = {}) {
  this.dm = deviceManager;
  // the re-check's timers (a test sets its own: setClockForTests)
  // (unref'd: a re-check never holds the process's shutdown)
  this.clock = {setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (typeof(t.unref) === 'function') t.unref(); return t; }, clearTimeout: (t) => clearTimeout(t)};
  this.floors = {share: shareFloorBytes, total: totalFloorBytes, count: countShare};
  // pairKey -> {callerWM, calleeWM, grants}; grants is every (appKey,
  // deviceID) the D3 check has passed for on this pair, keyed by addGrant's
  // id and device.
  this.channelRegistry = {};
  this.recheckInFlight = 0;
  // `${channel}/${invokeId}` -> {token, workerId, channel}: announced peer
  // invokes not yet matched by their metering request; channel ->
  // [{data, msgID, wm, timer}]: metering requests waiting for theirs
  this.announced = new Map();
  this.announcedBytes = 0;
  // caller worker id -> when it last had every caller's ended hops released
  // for a full total (mayReleaseAll); on a monotonic clock (a test's own)
  this.releasedAllBy = new Map();
  this.monotonicMs = () => performance.now();
  this.announcedByWorker = new Map();   // share key (a caller workerId, or 's:<session>') -> bytes held
  this.announcedCountByWorker = new Map();   // share key -> hops held
  // caller worker id -> when a walk of its own hops, at its count share,
  // last released nothing (mayReleaseOwn); on the same clock
  this.idleOwnWalk = new Map();
  // callee wm -> matches whose input is being checked: neither announced
  // (taken at the match) nor unbilled yet, and owed all the same
  this.checkingFor = new Map();
  this.held = new Map();
  // the callee's token -> {billingKey, tool, wm, workerId, channel,
  // deadline}: matched invokes not yet billed (or reported not served);
  // deadline is the announcement's time plus the caller's per-invoke
  // timeout; channel the pair key, which the per-channel count is by,
  // carried across grants on the pair (the review of #141, N3)
  this.unbilled = new Map();
  this.unbilledPerChannel = new Map();   // pair key -> count
  // An announcement whose invoke never meters (refused at the callee, a
  // port closed, a timeout) and an unbilled entry whose callee never
  // reports are dropped once their token has gone or their call's time is
  // up; the size caps stay as the last resort.
  this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
  this.sweeper.unref();

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

// Keyed by the caller's opaque id (R2-1 Task 4) and the device; the record
// names the caller by that id, and each key it was granted under by its
// meterId -- never a key (CLAUDE.md, C-meter-keys-3): {deviceID, id,
// meters: Set}. The re-check finds the id's key in the identity index
// (identity.lookup) and asks for it; an id the index no longer lists, or a
// key granted under that is no longer the id's (rotated), is no longer
// authorized: the channel closes (fails closed). The id, before the
// identity service has one for the key: its meterId, which the index never
// lists.
function callerIdOf(appKey) {
  const id = identity.idForKey(appKey);
  return (id != null) ? id : meterId(appKey);
}
function addGrant(grants, appKey, deviceID) {
  const id = callerIdOf(appKey);
  const key = `${id}\u0000${deviceID}`;
  if (grants[key] == null) grants[key] = {deviceID: deviceID, id: id, meters: new Set()};
  grants[key].meters.add(meterId(appKey));
}
// The identity index's provider (lib/auth identitySource): null under
// --debug outside the single-identity profile. A throw is not "no
// provider": it goes to the caller, which refuses (knownCaller rejects,
// recheckTarget closes as not confirmed)
function identityProvider() {
  return require('./auth').identitySource(options);
}
// Whether the key is in the identity index now (know() answers at once)
function indexedNow(appKey) {
  try {
    const found = identity.lookup(identity.idForKey(appKey));
    return found != null && found.apiKey === String(appKey);
  } catch (e) {
    return false;
  }
}
// -> Promise, once the key is in the identity index (identity.know; under
// --debug, which accepts every key, one the provider doesn't list is
// remembered, as a job's owner is)
function knownCaller(appKey) {
  return Promise.resolve().then(() => identity.know(appKey, identityProvider, {rememberUnlisted: options.debug === true}));
}
// A re-check that couldn't be made (the provider down or slow): closed, as
// fail-closed asks, but retryably -- the caller's next request re-grants
// through know(), which asks the provider again
const UNCONFIRMED = 'the caller could not be confirmed now; its next request asks again';
// What identity's answer to a re-check's miss can take: a refill running
// (its read's deadline, 10 s), the throttle after it (5 s), its own read
// (10 s), with room to spare
const RECHECK_INDEX_BOUND_MS = 30000;
// The re-check of one grant record, in one place (1.1's key-hash index
// changes it alone): cb({appKey}) -> the key to ask the provider for, or
// cb({why}) -> the channel closes, with a reason that never holds the key.
// The key is the one the identity index lists for the record's id; a miss
// asks the provider (identity.resolve: freshRefill's, never a miss answered
// without it asked). Closed as removed only when the provider was asked and
// doesn't list it -- or, with no provider, the key is one this process no
// longer remembers (identity's OWNER_LOST_WITHOUT_PROVIDER); a key granted
// under that is no longer the id's (rotated) is closed too; a refill that
// failed closes retryably (UNCONFIRMED).
function recheckTarget(record, cb) {
  const meters = (record.meters instanceof Set) ? [...record.meters] : [];
  let provider = null;
  try {
    provider = identityProvider();
  } catch (e) {
    try { LOG.E(e); } catch (logErr) { /* logged where it can be */ }
    return cb({why: Object.assign(new CountinghouseError('SYSTEM_ERROR_USERDB_NA'), {closeReason: UNCONFIRMED})});
  }
  // (a provider that lists its users, asked: a miss is a removal. Under
  // --debug a key it doesn't list may have been remembered instead
  // (rememberUnlisted); with no provider, or one without entries(), a miss
  // is a key this process no longer remembers)
  const listing = provider != null && typeof(provider.entries) === 'function';
  const close = (code, reason) => cb({why: Object.assign(new CountinghouseError(code), {closeReason: reason})});
  const missed = () => {
    if (!listing) return identity.OWNER_LOST_WITHOUT_PROVIDER;
    return (options.debug === true) ? 'its id is no longer listed, nor remembered' : 'its id is no longer listed';
  };
  const judge = (found) => {
    const appKey = (found != null && found.apiKey != null) ? String(found.apiKey) : null;
    if (appKey == null) return close('SYSTEM_ERROR_UNKNOWN_USER', missed());
    if (meters.length === 0 || meters.some((m) => m !== meterId(appKey))) return close('SYSTEM_ERROR_UNKNOWN_USER', 'a key it was granted under is no longer its key');
    return cb({appKey});
  };
  // (a throw, the lookup's or the code's after it, is logged and closes
  // the channel as not confirmed; cb's done() answers once, whichever
  // comes first)
  const unconfirmed = (e) => {
    try { LOG.E(e); } catch (logErr) { /* logged where it can be */ }
    return close('SYSTEM_ERROR_USERDB_NA', UNCONFIRMED);
  };
  const answer = (err, found) => {
    try {
      return (err != null) ? close('SYSTEM_ERROR_USERDB_NA', UNCONFIRMED) : judge(found);
    } catch (e) {
      return unconfirmed(e);
    }
  };
  try {
    identity.resolve(record.id, provider, answer);
  } catch (e) {
    unconfirmed(e);
  }
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

  workerMessage.on('peer-announce', (message, wm) => {
    _this.handleAnnouncement(message.data, wm);
  });

  workerMessage.on('peer-bill-request', (message, wm) => {
    _this.handleBillRequest(message.data, message.id, wm);
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
  let appKey            = null;

  if (typeof(targetDeviceID) !== 'string') return;

  // R2-1 Task 4: a channel opens only to a device the calling module
  // declared calls on. The module is the one the requesting worker hosts
  // (its token's device); the actions declared on the device go to the
  // callee with the grant, which checks each invoke against them.
  const tokenEntry = callTokens.resolve(data.token, {workerId: callerWM.workerId});
  if (tokenEntry == null) {
    const e = new CountinghouseError('CALL_TOKEN_INVALID', 'peer channel');
    return callerWM.sendPeerChannelDenyToChild({targetDeviceID: targetDeviceID, errMsg: e.message, errCode: e.code});
  }
  // the identity the channel is granted to: the token's (R2-1 Task 5),
  // never a key the worker states
  appKey = callTokens.identityOf(tokenEntry);

  // A target not listed (its module going on or off, #413 section 5.5) is
  // not hosted, for every check below: not self, and after
  // the access check DEVICE_NOT_FOUND, for that call only.
  const listed = listsDevice(targetDeviceID);
  if (listed && this.dm.deviceMap[targetDeviceID] === callerWM) {
    // Target device is hosted by the requesting worker itself -- a peer
    // channel to your own worker isn't a meaningful concept here (the
    // existing local-invoke path already handles same-worker calls without
    // ever going through isRemoteThread routing in the first place). Not a
    // scenario docs/direct-peer-channels-design.md's D1-D5 describe;
    // rejected explicitly rather than silently mishandled. Answered before
    // the declarations, so the diagnostic is the one that applies.
    const selfTargetErr = new CountinghouseError('PEER_SELF_TARGET');
    return callerWM.sendPeerChannelDenyToChild({targetDeviceID: targetDeviceID, errMsg: selfTargetErr.message, errCode: selfTargetErr.code});
  }

  const declared = declaredNow(callerWM, tokenEntry, targetDeviceID);
  if (declared.refused != null) return callerWM.sendPeerChannelDenyToChild({targetDeviceID: targetDeviceID, errMsg: declared.refused.message, errCode: declared.refused.code});

  // D3: the exact same userAuth device-ownership check every other entry
  // path uses (see lib/device-manager.js's sendInvokeActionMessageToWorker
  // for the main-thread-routed equivalent this exists alongside), but run
  // once per (callerWorkerId, targetDeviceID) here at brokering time
  // instead of once per invoke. localCB is a no-op -- this check only ever
  // decides grant-or-deny, it never itself invokes anything.
  // What the request gets now, once the access check has passed: {deny}
  // (the answer to send), {none} (the caller ended: nothing), or {calleeWM,
  // actions} (a grant may be made). Asked right after the access check --
  // a device missing, restarting, replaced or not declared is answered then,
  // in that turn, as the routed path answers it, and know() is asked only
  // for a grant that would be made -- and again after know()'s wait, before
  // the grant.
  const deny = (fields) => ({deny: fields});
  const ready = () => {
    // The check is asynchronous, so the workers are looked at again now. A
    // caller that ended meanwhile gets nothing (a port sent its way would
    // leave the callee holding a channel to no one).
    if (!isLive(callerWM)) return {none: true};
    // know() can wait on a provider read (its throttle and deadline): the
    // token and the calling module's declarations are asked again too, and
    // the grant carries the actions declared now
    if (callTokens.resolve(data.token, {workerId: callerWM.workerId}) == null) {
      const e = new CountinghouseError('CALL_TOKEN_INVALID', 'peer channel');
      return deny({targetDeviceID: targetDeviceID, errMsg: e.message, errCode: e.code});
    }
    const declaredAfter = declaredNow(callerWM, tokenEntry, targetDeviceID);
    if (declaredAfter.refused != null) return deny({targetDeviceID: targetDeviceID, errMsg: declaredAfter.refused.message, errCode: declaredAfter.refused.code});
    // Nor does a callee that is going: a port transferred to a worker that
    // has already exited is dropped without an error, and its other end
    // never closes, so the caller would keep a dead channel and every call
    // over it would wait out the peer timeout. A callee replaced meanwhile
    // (a reload) gets the channel on its new worker: the grant is for the
    // device, not the worker.
    // and whether it is listed, asked again: its module going on or off, a
    // device never hosted (#413 section 5.5). R1 Task 5: a listed per-session module never gets
    // a direct channel. A caller's channels are keyed by device alone, so
    // one opened under one session's call would carry another session's hop
    // into the first one's worker. The caller is told to route the device
    // through the main thread, where each hop reaches the worker its own
    // token's session names (DeviceManager workerFor). After the access
    // check, as every answer here.
    const listedNow = listsDevice(targetDeviceID);
    const entry = this.dm.deviceMap[targetDeviceID];
    if (listedNow && require('./session-module-record').isRecord(entry)) {
      return deny({targetDeviceID: targetDeviceID, route: 'main',
        errMsg: 'this module is reached through the main thread', errCode: 'PEER_CHANNEL_DENIED'});
    }
    const calleeWM = listedNow ? entry : null;
    if (!isLive(calleeWM)) {
      // Why the device is missing (MODULE_RELOADING, MODULE_RESTARTING,
      // MODULE_SUSPENDED, MODULE_UNLOADED, or DEVICE_NOT_FOUND for one never
      // hosted) is answered only after userAuth: a caller without access gets
      // the access error whatever the reason, so it cannot tell a device once
      // hosted here from one never hosted.
      const missing = listedNow ? this.dm.missingDeviceErrorForHop(targetDeviceID) : notListed();
      // a device not found is a deny about this call only (B3 Task 3b):
      // headOnly on every one, so a device the call's session doesn't list
      // (Task 4) is the same bytes as one never hosted.
      return deny(Object.assign({targetDeviceID: targetDeviceID, errMsg: missing.message, errCode: missing.code},
        missing.code === 'DEVICE_NOT_FOUND' ? {headOnly: true} : {}));
    }
    if (calleeWM === callerWM) {
      const selfTargetErr = new CountinghouseError('PEER_SELF_TARGET');
      return deny({targetDeviceID: targetDeviceID, errMsg: selfTargetErr.message, errCode: selfTargetErr.code});
    }
    // A worker being replaced in place (lib/modules-in-place.js marks the
    // OLD worker `replacing`) takes no new channel: its open ones finish, up
    // to --requestTimeout, and the caller's hop goes through the main
    // thread, which holds it until the new version is up (#205's review).
    // Asked here, of the worker the device map holds NOW, and only here
    // (the back-sweep, 11-18, and the Reviewer's high review of #441, 5 and
    // 8): before userAuth, a replace that began during the check got a
    // grant to the old worker, and a caller without access learnt the
    // device is hosted; and the new worker, once registered, is never
    // replacing, so its channels are granted though the reload has not
    // finished.
    if (calleeWM.replacing === true) {
      const e = new CountinghouseError('MODULE_RELOADING', calleeWM.hostModuleName);
      return deny({targetDeviceID: targetDeviceID, errMsg: e.message, errCode: e.code});
    }
    return {calleeWM: calleeWM, actions: declaredAfter.actions};
  };
  const answer = (r) => ((r.deny != null) ? callerWM.sendPeerChannelDenyToChild(r.deny) : undefined);
  const granted = () => {
    const r = ready();
    if (r.deny != null || r.none === true) return answer(r);
    return this.grant(targetDeviceID, appKey, callerWM, r.calleeWM, r.actions);
  };

  // Whether the key was in the index BEFORE userAuth: its door (A2) reads a
  // key in, so asked after it, an unindexed key reads as indexed and the
  // access re-check below was skipped (#526's high, M1)
  const indexedBefore = indexedNow(appKey);
  userAuth(null, null, targetDeviceID, appKey, null, null, () => {}, (err) => {
    if (err != null) {
      // userAuth's own errors are always a CountinghouseError, which
      // always sets `.code` (see lib/countinghouse-error.js) -- no
      // made-up fallback code needed here.
      return callerWM.sendPeerChannelDenyToChild({targetDeviceID: targetDeviceID, errMsg: err.message, errCode: err.code});
    }
    // The caller's key made known to the identity index before a grant
    // record names it by id (B-meter-keys (2)'s rule, C-meter-keys-3), so
    // the re-check finds the key again by that id: a provider-backed key the
    // index doesn't hold yet is refilled with its stable id. One that can't
    // be made known is refused, retryably, and nothing is recorded. From
    // here to the record nothing waits, so no re-check runs in between.
    // (a caller that ended meanwhile is sent nothing, as granted() does; a
    // throw in granted() is logged, never an unhandled rejection)
    const first = ready();
    if (first.deny != null || first.none === true) return answer(first);
    // When know() had to wait (the key not in the index yet: a provider
    // read), the access check is asked again after it, as the token and
    // declarations are: a grant revoked meanwhile gets no channel.
    const refuse = (err) => (isLive(callerWM) ? callerWM.sendPeerChannelDenyToChild(Object.assign({targetDeviceID: targetDeviceID}, CountinghouseError.replyFields(err))) : undefined);
    // (missing before userAuth, or gone from the index by its answer: either
    // way knownCaller may wait on a refill -- the medium on the round, 2)
    const waited = !indexedBefore || !indexedNow(appKey);
    return knownCaller(appKey).then(() => {
      if (!waited) return granted();
      return new Promise((resolve) => userAuth(null, null, targetDeviceID, appKey, null, null, () => {}, (againErr) => {
        if (againErr != null) return resolve(refuse(againErr));
        return resolve(Promise.resolve().then(() => granted()));
      }));
    }, () => refuse(new CountinghouseError('SYSTEM_ERROR_USERDB_NA'))).catch((e) => {
      try { LOG.E(e); } catch (logErr) { /* logged where it can be */ }
      // (the caller answered, once: whatever threw sent it nothing; a
      // catalogued, retryable refusal)
      try { refuse(new CountinghouseError('SYSTEM_ERROR_USERDB_NA')); } catch (sendErr) { /* the caller is gone */ }
    });
  });
};

// The calling module's declarations, as they are now: {actions} on the
// target device, or {refused}: its composition verdict not in yet
// (CTX_CALL_NOT_READY, retryable) or no action declared there
// (CTX_CALL_UNDECLARED). Asked before the access check and again after
// know()'s wait.
function declaredNow(callerWM, tokenEntry, targetDeviceID) {
  if (!callTokens.hasVerdict(callerWM, tokenEntry.deviceID)) return {refused: new CountinghouseError('CTX_CALL_NOT_READY', String(targetDeviceID).slice(0, 64))};
  const actions = callTokens.declaredActionsOn(callTokens.bindingOf(callerWM, tokenEntry.deviceID), targetDeviceID);
  if (actions.length === 0) return {refused: new CountinghouseError('CTX_CALL_UNDECLARED', String(targetDeviceID).slice(0, 64))};
  return {actions};
}

// A worker that has neither ended nor begun its unload.
function isLive(wm) {
  return wm != null && wm.ended == null && wm.unloading !== true;
}

PeerChannelBroker.prototype.grant = function(targetDeviceID, appKey, callerWM, calleeWM, actions) {
  const pairKey = `${callerWM.workerId}:${calleeWM.workerId}`;

  if (this.channelRegistry[pairKey] != null) {
    addGrant(this.channelRegistry[pairKey].grants, appKey, targetDeviceID);

    // A live port already connects these two workers (from an earlier
    // request for a different device on the same target worker) -- no new
    // MessageChannel needed. The callee serves only devices granted on the
    // channel, so it learns this one first, and A is told which workerId's
    // cached port to use only once it has (review R2-2).
    return calleeWM.sendPeerChannelAllowToChild({callerWorkerId: callerWM.workerId, deviceID: targetDeviceID, actions: actions}, (err) => {
      if (err != null) return callerWM.sendPeerChannelDenyToChild({targetDeviceID: targetDeviceID, errMsg: err.message, errCode: err.code});
      return callerWM.sendPeerChannelGrantToChild({targetDeviceID: targetDeviceID, targetWorkerId: calleeWM.workerId});
    });
  }

  const channel = new MessageChannel();
  this.channelRegistry[pairKey] = {callerWM: callerWM, calleeWM: calleeWM, grants: {}};
  addGrant(this.channelRegistry[pairKey].grants, appKey, targetDeviceID);

  // No key to the callee worker (R2-1 Task 4's review): the hop is billed by
  // the announced token, and the callee needs none.
  // (a channel this grant began and couldn't finish is undone, record and
  // all, so the caller's next request starts afresh; its port closed, so a
  // callee that got the other end drops it)
  try {
    calleeWM.sendPeerChannelOpenToChild({callerWorkerId: callerWM.workerId, targetDeviceID: targetDeviceID, actions: actions}, channel.port2);
    callerWM.sendPeerChannelGrantToChild({targetDeviceID: targetDeviceID, targetWorkerId: calleeWM.workerId, port: channel.port1}, channel.port1);
  } catch (e) {
    if (this.channelRegistry[pairKey] != null && this.channelRegistry[pairKey].calleeWM === calleeWM) {
      delete this.channelRegistry[pairKey];
      try { this.forgetPair(pairKey); } catch (forgetErr) { /* logged with e */ }
    }
    try { channel.port1.close(); } catch (closeErr) { /* closed */ }
    throw e;
  }
};

const bindingOf = callTokens.bindingOf;

const refusal = (msgID) => Object.assign({msgID: msgID, meteringResult: null},
  CountinghouseError.replyFields(new CountinghouseError('CALL_TOKEN_INVALID', 'peer invoke')));

// The caller worker's announcement of one peer invoke. Accepted only from
// the channel's own caller worker, for a token issued to that worker
// (reviewer, 2026-11-09: who may announce); anything else is refused and
// logged, and a metering request citing it stays unmatched.
// Lean worker step 4 (the review of #202): the announcement is the caller's
// statement of the invoke, its target (deviceID, serviceID, actionName) and
// its input as bytes, held here until the callee's match; the callee never
// restates either. Each is checked now: strings within bounds, the target a
// device the channel's callee worker hosts and the caller declared, the
// bytes under the cap. A refusal is answered to the caller at once
// (peer-announce-refused). The bytes held wait for a match only briefly,
// and their total is bounded (ANNOUNCED_BYTES_MAX): past it an announcement
// is refused RATE_LIMITED.
PeerChannelBroker.prototype.handleAnnouncement = function(data, fromWM) {
  if (data == null || typeof(data.channel) !== 'string' || !invokeIdOk(data.invokeId)) return;
  const entry = this.channelRegistry[data.channel];
  if (entry == null || entry.callerWM !== fromWM) {
    return LOG.I(`peer announce refused: worker ${fromWM != null ? fromWM.workerId : '?'} is not the caller of channel ${data.channel}`);
  }
  const refuse = (err) => {
    LOG.I(`peer announce refused: channel ${data.channel} invoke ${String(data.invokeId).slice(0, 32)}: ${err.code}`);
    if (typeof(fromWM.sendPeerAnnounceRefusedToChild) === 'function') {
      fromWM.sendPeerAnnounceRefusedToChild(Object.assign({channel: data.channel, invokeId: data.invokeId,
        epoch: (typeof(data.epoch) === 'string') ? data.epoch.slice(0, TARGET_FIELD_MAX) : null}, CountinghouseError.replyFields(err)));
    }
  };
  const tokenEntry = callTokens.resolve(data.token, {workerId: fromWM.workerId});
  if (tokenEntry == null) return refuse(new CountinghouseError('CALL_TOKEN_INVALID', 'a peer invoke'));
  const text = (v) => typeof(v) === 'string' && v.length > 0 && v.length <= TARGET_FIELD_MAX;
  if (!text(data.deviceID) || !text(data.serviceID) || !text(data.actionName) || !(typeof(data.epoch) === 'string' && data.epoch.length <= TARGET_FIELD_MAX)) {
    return refuse(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a peer invoke names its target in strings'));
  }
  // the caller's declarations first, as on the routed path; then the device:
  // one the channel's callee worker hosts
  if (!callTokens.declaredTarget(bindingOf(entry.callerWM, tokenEntry.deviceID), data.deviceID, data.serviceID, data.actionName)) {
    return refuse(new CountinghouseError('CTX_CALL_UNDECLARED', `${data.serviceID}/${data.actionName}`));
  }
  // A channel open is shared by every session: the invoke is what is
  // checked. A target not listed (its module going on or off) is refused as
  // not found, with no ID, and nothing is held.
  if (!listsDevice(data.deviceID)) return refuse(notListed());
  // R1 Task 5, a backstop: no channel to a session's worker is ever
  // granted; were one to exist, a hop on it must be of that same session
  if (entry.calleeWM != null && typeof(entry.calleeWM.hostSession) === 'string' && tokenEntry.session !== entry.calleeWM.hostSession) {
    return refuse(new CountinghouseError('PEER_NOT_GRANTED', data.deviceID.slice(0, 64)));
  }
  const calleeWM = (this.dm != null && this.dm.deviceMap != null) ? this.dm.deviceMap[data.deviceID] : null;
  if (calleeWM == null || calleeWM !== entry.calleeWM) return refuse(new CountinghouseError('PEER_NOT_GRANTED', data.deviceID.slice(0, 64)));
  const inputBytes = hopInput.bytesOf(data);
  if (inputBytes == null) return refuse(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a hop\'s input must cross as bytes'));
  const tooLarge = hopInput.sizeRefusal(inputBytes, {module: (typeof(calleeWM.moduleName) === 'string') ? calleeWM.moduleName : 'module',
    action: data.actionName, max: callLimits.of(tokenEntry).maxOutputBytes});
  if (tooLarge != null) return refuse(tooLarge);
  // The caller's own share first, of the bytes and of the count. Its
  // announcements whose call has ended (the token gone) are released now,
  // not only at the sweep; then a newcomer over its share, the total or the
  // count is refused, and nothing another caller holds is evicted.
  const key = `${data.channel}/${data.invokeId}`;
  if (this.announced.has(key)) this.forgetAnnounced(key);
  const bytes = inputBytes.byteLength;
  // Over the total, or the count: what ANY caller holds for a call that has
  // ended or passed its deadline is released first. The total is only a few
  // callers' shares (four, at a 16 MiB cap), and left to the 60 s sweep,
  // other callers' dead hops refused everyone's direct hops meanwhile (the
  // reviewer's finding after #283). Nothing live is released. That walk is
  // over every held hop, so a caller refused over and over buys at most one
  // in RELEASE_ALL_MIN_MS; the bound is each caller's own, so one caller's
  // attempts never make another wait for hops that ended meanwhile.
  // Otherwise, over its own share only, its own are released (one walk
  // either way: the first covers the second).
  // A caller parked at its count share (256 small live hops are enough) would otherwise buy a walk of every held hop with each further
  // announcement, at its message rate: a walk of its own that released
  // nothing is not repeated for it within RELEASE_ALL_MIN_MS. One that
  // released something is never held off, and a caller over its bytes
  // alone is walked for as before (it holds few hops, and its next one
  // must find the room an ended one left).
  const share = shareKeyOf(tokenEntry, fromWM.workerId);
  const shareBytes = this.shareBytesOf(tokenEntry);
  const totalBytes = this.totalBytes();
  const atCount = () => (this.announcedCountByWorker.get(share) || 0) >= this.floors.count;
  const overOwn = () => (this.announcedByWorker.get(share) || 0) + bytes > shareBytes || atCount();
  const overAll = this.announcedBytes + bytes > totalBytes || this.announced.size >= ANNOUNCED_MAX;
  // a walk of every share releases every session's ended hops: bounded per
  // caller worker, as on master, so N sessions on one worker don't buy N
  // walks a window (#341's review, 7)
  if (overAll && this.mayReleaseAll(fromWM.workerId)) this.releaseEnded(null);
  else if (overOwn() && (!atCount() || this.mayReleaseOwn(share))) {
    const counted = atCount();
    if (this.releaseEnded(share) === 0 && counted) this.idleOwnWalk.set(share, this.monotonicMs());
  }
  if (overOwn() || this.announcedBytes + bytes > totalBytes || this.announced.size >= ANNOUNCED_MAX) {
    return refuse(new CountinghouseError('RATE_LIMITED'));
  }
  // The caller's deadline: its timer started when it invoked, and it says
  // how much was left when it sent (timeLeftMs). Main's deadline is never
  // later than that, nor than the caller's timeout from now.
  const now = Date.now();
  const left = (typeof(data.timeLeftMs) === 'number' && Number.isFinite(data.timeLeftMs) && data.timeLeftMs >= 0) ? data.timeLeftMs : Infinity;
  // the announcing call's override, or null (the global values, read at each
  // check); its deadline takes the timeout now
  this.announced.set(key, {token: data.token, workerId: fromWM.workerId, share: share, channel: data.channel, at: now, deadline: now + Math.min(left, callLimits.of(tokenEntry).requestTimeout),
    epoch: data.epoch, invokeId: data.invokeId, bytes: bytes, limits: tokenEntry.limits || null,
    // its call's session (main-side): every check also takes the session's
    // values now (B2 Task 2)
    session: typeof(tokenEntry.session) === 'string' ? tokenEntry.session : null,
    target: {deviceID: data.deviceID, serviceID: data.serviceID, actionName: data.actionName}, inputBytes: inputBytes});
  this.announcedBytes += bytes;
  this.announcedByWorker.set(share, (this.announcedByWorker.get(share) || 0) + bytes);
  this.announcedCountByWorker.set(share, (this.announcedCountByWorker.get(share) || 0) + 1);
  const waiting = this.takeHeld(data.channel, data.invokeId);
  if (waiting != null) this.serveMatched(waiting.data, waiting.msgID, waiting.wm, key);
};

// An announcement taken or dropped: its bytes leave the held total, and it
// leaves its caller's count.
PeerChannelBroker.prototype.forgetAnnounced = function(key) {
  const a = this.announced.get(key);
  if (a == null) return null;
  this.announced.delete(key);
  const bytes = Number.isInteger(a.bytes) ? a.bytes : 0;
  this.announcedBytes = Math.max(0, this.announcedBytes - bytes);
  const share = a.share !== undefined ? a.share : a.workerId;
  const left = (this.announcedByWorker.get(share) || 0) - bytes;
  if (left > 0) this.announcedByWorker.set(share, left); else this.announcedByWorker.delete(share);
  const count = (this.announcedCountByWorker.get(share) || 0) - 1;
  if (count > 0) this.announcedCountByWorker.set(share, count); else this.announcedCountByWorker.delete(share);
  return a;
};

// Whether this caller may have every caller's ended hops released now: at
// most once in RELEASE_ALL_MIN_MS a caller, by a clock that never steps
// back.
PeerChannelBroker.prototype.mayReleaseAll = function(share) {
  const at = this.monotonicMs();
  // (the few callers whose window has passed are forgotten as it goes)
  for (const [id, was] of this.releasedAllBy) if (at - was >= RELEASE_ALL_MIN_MS) this.releasedAllBy.delete(id);
  if (this.releasedAllBy.has(share)) return false;
  this.releasedAllBy.set(share, at);
  return true;
};

// Whether a caller at its count share may have its own hops walked now: not
// within RELEASE_ALL_MIN_MS of a walk of its own that released nothing.
PeerChannelBroker.prototype.mayReleaseOwn = function(share) {
  const at = this.monotonicMs();
  // (the few callers whose window has passed are forgotten as it goes)
  for (const [id, was] of this.idleOwnWalk) if (at - was >= RELEASE_ALL_MIN_MS) this.idleOwnWalk.delete(id);
  return !this.idleOwnWalk.has(share);
};

// A share's announcements whose call has ended (its token gone) or whose
// deadline has passed (no match may serve it now): released, so they never
// hold the share until the sweep. share null: every share's (the total).

// A share's bytes: two hops at its cap, at least the floor. A session's
// share is at that session's own cap (its call's values now).
PeerChannelBroker.prototype.shareBytesOf = function(tokenEntry) {
  const cap = sessionOfShare(tokenEntry) != null ? callLimits.of(tokenEntry).maxOutputBytes : capBytes();
  return Math.max(this.floors.share, 2 * cap);
};
// The total: eight hops at the largest active cap, at least the floor. In a
// shared runtime that is the greater of the default and the largest
// session's own (lib/session-settings.js largest, kept on every change).
PeerChannelBroker.prototype.totalBytes = function() {
  let cap = capBytes();
  if (sessionsLib().shared() === true) {
    const largest = sessionSettingsLib().largest('maxOutputBytes');
    if (Number.isInteger(largest) && largest > cap) cap = largest;
  }
  return Math.max(this.floors.total, 8 * cap);
};
PeerChannelBroker.prototype.releaseEnded = function(share) {
  const now = Date.now();
  let released = 0;
  for (const [key, a] of this.announced) {
    if (share != null && (a.share !== undefined ? a.share : a.workerId) !== share) continue;
    if (callTokens.resolve(a.token, {workerId: a.workerId}) == null || (Number.isFinite(a.deadline) && now >= a.deadline)) {
      this.forgetAnnounced(key);
      released += 1;
    }
  }
  return released;
};

// The direct peer invokes a callee worker still owes: matched and not yet
// billed, matched with their input still being checked, or announced on one
// of its channels and not yet matched (their held input bytes, lean worker
// step 4). A reload in place drains these too (lib/modules-in-place.js;
// #205's review).
PeerChannelBroker.prototype.openInvokesTo = function(wm) {
  let n = this.checkingFor.get(wm) || 0;
  for (const due of this.unbilled.values()) if (due.wm === wm) n++;
  for (const a of this.announced.values()) {
    const entry = this.channelRegistry[a.channel];
    if (entry != null && entry.calleeWM === wm) n++;
  }
  return n;
};

PeerChannelBroker.prototype.takeHeld = function(channel, invokeId) {
  const q = this.held.get(channel);
  if (q == null) return null;
  const i = q.findIndex((item) => item.data.invokeId === invokeId);
  if (i < 0) return null;
  const [item] = q.splice(i, 1);
  if (q.length === 0) this.held.delete(channel);
  clearTimeout(item.timer);
  return item;
};

// D5 (docs/composite-tools.md's "billing authority" principle: platform
// automatic metering is the *only* thing that deducts balance for a
// cross-worker call, on either path -- see
// DeviceManager.prototype.sendInvokeActionMessageToWorker for the
// main-thread-routed path's equivalent). Request/reply: the callee worker
// sends this BEFORE it runs the handler (R2-1 Task 3: authorize before
// serve) and serves only on an answer that is not a refusal; the bill
// request after the handler threads the real {charged, balance} result
// back to the calling module.
//
// data: {channel, invokeId, deviceID, serviceID, actionName}, from the
// channel's callee worker only. Matched to the caller's announcement, the
// callee gets a token of its own for the invoke (so a part it runs can hop
// and call remotes, billed to the same caller), and the hop is billed to
// the announced token's caller when the callee's bill request cites that
// token (handleBillRequest).
//
// Cost model: reuses options.mcpToolCallCost (the same single
// CLI-configurable cost already applied to MCP-originated recordCall
// calls and to the main-thread-routed path below) rather than inventing a
// second cost knob -- there is no per-module declared pricing yet
// anywhere in the platform (see docs/composite-tools.md's "known
// simplifications").
PeerChannelBroker.prototype.handleMeteringRequest = function(data, msgID, wm) {
  if (data == null || !invokeIdOk(data.invokeId)) return wm.sendPeerMeteringReplyToChild(refusal(msgID));
  const entry = (typeof(data.channel) === 'string') ? this.channelRegistry[data.channel] : null;
  if (entry == null || entry.calleeWM !== wm) {
    return wm.sendPeerMeteringReplyToChild(refusal(msgID));
  }
  const key = `${data.channel}/${data.invokeId}`;
  if (this.announced.has(key)) return this.serveMatched(data, msgID, wm, key);

  const q = this.held.get(data.channel) || [];
  if (q.length >= PEER_HELD_MAX) return wm.sendPeerMeteringReplyToChild(refusal(msgID));
  const item = {data: data, msgID: msgID, wm: wm, timer: null};
  item.timer = setTimeout(() => {
    const now = this.held.get(data.channel);
    if (now != null) {
      const i = now.indexOf(item);
      if (i >= 0) now.splice(i, 1);
      if (now.length === 0) this.held.delete(data.channel);
    }
    wm.sendPeerMeteringReplyToChild(refusal(msgID));
  }, PEER_ANNOUNCE_WAIT_MS);
  q.push(item);
  this.held.set(data.channel, q);
};

PeerChannelBroker.prototype.serveMatched = function(data, msgID, wm, key) {
  const announced = this.forgetAnnounced(key);
  const entry = this.channelRegistry[data.channel];
  const tokenEntry = (announced != null && entry != null) ? callTokens.resolve(announced.token, {workerId: announced.workerId}) : null;
  // the call answered or its worker ended since the announcement
  if (tokenEntry == null) return wm.sendPeerMeteringReplyToChild(refusal(msgID));

  // The announcement's time starts the caller's clock, and a module can
  // post an announcement itself, early (the review of #141, N1): past the
  // deadline the match is refused too, so no handler runs for it. An honest
  // caller has timed out by then and loses nothing.
  const deadline = deadlineNow(announced);
  if (Date.now() >= deadline) {
    LOG.I(`peer channel ${data.channel} invoke ${String(data.invokeId).slice(0, 32)}: announced more than ${callerTimeoutMs(announced)} ms ago, refused (PEER_CHANNEL_TIMEOUT)`);
    return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null},
      CountinghouseError.replyFields(new CountinghouseError('PEER_CHANNEL_TIMEOUT'))));
  }
  // The invoke's target is the caller's announcement, never the callee's
  // request (the review of #202). It is checked again here, as the binding
  // or the device may have changed since: a device this callee hosts, and an
  // action the caller declared (Task 4's review: a binding cleared by a
  // failed re-verification stops the hops on channels already open).
  const target = announced.target;
  if (this.dm == null || this.dm.deviceMap == null || this.dm.deviceMap[target.deviceID] !== wm || entry.calleeWM !== wm) {
    return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null},
      CountinghouseError.replyFields(new CountinghouseError('PEER_NOT_GRANTED', target.deviceID.slice(0, 64)))));
  }
  if (!callTokens.declaredTarget(bindingOf(entry.callerWM, tokenEntry.deviceID), target.deviceID, target.serviceID, target.actionName)) {
    return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null},
      CountinghouseError.replyFields(new CountinghouseError('CTX_CALL_UNDECLARED', `${target.serviceID}/${target.actionName}`))));
  }
  // whether it is listed, asked again: a module that began to go on or off
  // since the announcement gets no handler run
  if (!listsDevice(target.deviceID)) {
    return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null}, CountinghouseError.replyFields(notListed())));
  }
  // a required setting of this module unset (module settings, section 4.6):
  // no handler runs, as on the routed path (lib/device-manager.js sendCounted)
  // The state is read once, here, and is exactly what the match carries
  // (issueMatched, after the input's validation): never read again later.
  const calleeSettings = settingsGate.stateOf(this.dm, wm);
  const settingsRefused = settingsGate.requiredRefusal(this.dm, target.deviceID, false, calleeSettings);
  if (settingsRefused != null) {
    return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null}, CountinghouseError.replyFields(settingsRefused)));
  }
  // past the per-channel cap on matched invokes awaiting their bill: refused,
  // nothing evicted (an evicted entry would be a hop served for free)
  const count = this.unbilledPerChannel.get(data.channel) || 0;
  if (count >= UNBILLED_PER_CHANNEL_MAX) {
    LOG.I(`peer channel ${data.channel}: ${count} matched invokes await their bill; one more is refused`);
    return wm.sendPeerMeteringReplyToChild(refusal(msgID));
  }
  // Lean worker step 4: the caller's input bytes, capped at its
  // announcement, are checked against the callee's input schema in a
  // validator, as a routed hop's (#185). The caller for the per-caller rules
  // is the calling module, whose bytes they are. A callee whose spec the main
  // thread does not hold is refused: nothing is passed unchecked.
  const inputBytes = announced.inputBytes;
  const checked = moduleSpec.checkInput(wm.moduleSpec, target.deviceID, target.serviceID, target.actionName, {inputBytes: inputBytes});
  if (checked == null) {
    return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null},
      CountinghouseError.replyFields(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the called module\'s spec is not held'))));
  }
  if (checked.refused != null) {
    return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null}, replyOf(checked.refused)));
  }
  // (the validators' per-caller key: in a shared runtime, the calling module
  // and the hop's session, as a routed hop's: lib/sessions.js
  // validationCallerOf, B-valsess)
  const caller = sessionsLib().validationCallerOf(deviceManagerLib().hopCallerOf(entry.callerWM, tokenEntry.billingKey), tokenEntry.session);
  const validated = moduleSpec.validateSerialized(checked, 'input', inputBytes, caller);
  this.checkingFor.set(wm, (this.checkingFor.get(wm) || 0) + 1);
  const checkedOne = () => {
    const left = (this.checkingFor.get(wm) || 1) - 1;
    if (left > 0) this.checkingFor.set(wm, left); else this.checkingFor.delete(wm);
  };
  return validated.then((answer) => ({answer}), (error) => ({error})).then(({answer, error}) => process.nextTick(() => {
    checkedOne();
    if (error != null || answer == null || (answer.refused == null && !(answer.buffer instanceof ArrayBuffer))) {
      if (error != null) LOG.E(error);
      return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null},
        CountinghouseError.replyFields(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a hop\'s input could not be checked'))));
    }
    if (answer.refused != null) {
      return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null}, replyOf(answer.refused)));
    }
    // billed to its call's key: it runs only while that charge can be
    // recorded (the owner's decision, 11-27); issueMatched checks the call,
    // the workers and the deadline again after this answers
    const issue = () => this.issueMatched(data, msgID, wm, {announced, tokenEntry, entry, deadline, checked, caller, checkedInput: answer.buffer, calleeSettings});
    const ci = CHUtil.ci;
    if (tokenEntry.billingKey == null || ci == null || typeof(ci.chargeable) !== 'function') return issue();
    return ci.chargeable(tokenEntry.billingKey, (refusal) => (refusal != null
      ? wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null}, CountinghouseError.replyFields(refusal)))
      : issue()));
  }));
};

// The match's second half, once the input passed: the callee's token, its
// entry awaiting the bill, and the reply with the checked input's bytes.
PeerChannelBroker.prototype.issueMatched = function(data, msgID, wm, m) {
  const {announced, tokenEntry, deadline, checked, checkedInput} = m;
  // While the input was checked: the call may have answered, its worker or
  // the callee's ended, the channel been revoked, or the deadline passed.
  // Each is checked again before any handler runs (the review of #202).
  if (callTokens.resolve(announced.token, {workerId: announced.workerId}) == null || this.channelRegistry[data.channel] !== m.entry ||
      !isLive(wm) || !isLive(m.entry.callerWM)) {
    return wm.sendPeerMeteringReplyToChild(refusal(msgID));
  }
  if (Date.now() >= Math.min(deadline, deadlineNow(announced))) {
    return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null},
      CountinghouseError.replyFields(new CountinghouseError('PEER_CHANNEL_TIMEOUT'))));
  }
  // the callee's settings as the check read them (serveMatched), carried as
  // checked; one a reread put while the input was validated is checked
  // again here, before any token is issued and carried instead (never a superseded value, never an
  // unchecked one)
  let calleeSettings = m.calleeSettings;
  const nowSettings = settingsGate.stateOf(this.dm, wm);
  if (nowSettings !== calleeSettings) {
    const again = settingsGate.requiredRefusal(this.dm, announced.target.deviceID, false, nowSettings);
    if (again != null) return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null}, CountinghouseError.replyFields(again)));
    calleeSettings = nowSettings;
  }
  const count = this.unbilledPerChannel.get(data.channel) || 0;
  if (count >= UNBILLED_PER_CHANNEL_MAX) return wm.sendPeerMeteringReplyToChild(refusal(msgID));
  const binding = bindingOf(wm, announced.target.deviceID);
  // the callee's token: chained to the announced one, so it ends with it;
  // a chain already at its depth limit refuses the hop
  let token;
  try {
    token = callTokens.issue({billingKey: tokenEntry.billingKey, identityKey: binding.identity, module: binding.module,
      workerId: wm.workerId, deviceID: announced.target.deviceID, parent: announced.token, ttlMs: tokenTtlMs(announced), limits: announced.limits,
      // the action this invoke is of, as the main thread matched it to the
      // caller's announcement: what the callee may ask of the outer call's
      // user (ctx.ask over composition, lib/module-ask.js; M14)
      serviceID: announced.target.serviceID, actionName: announced.target.actionName});
  } catch (e) {
    return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null}, CountinghouseError.replyFields(e)));
  }
  this.unbilled.set(token, {billingKey: tokenEntry.billingKey, progress: callTokens.progressOf(token), tool: encodeLegacyTool(announced.target.deviceID, announced.target.serviceID, announced.target.actionName),
    wm: wm, workerId: wm.workerId, channel: data.channel, deadline: deadline, at: announced.at,
    // where the result goes, and what checks it (lean worker step 4)
    invokeId: announced.invokeId, epoch: announced.epoch, callerWM: m.entry.callerWM, checked: checked, caller: m.caller,
    calleeName: (typeof(wm.moduleName) === 'string') ? wm.moduleName : 'module', actionName: announced.target.actionName, limits: announced.limits,
    session: announced.session,
    // the callee's settings as the match carried them, for its claim
    // (lib/settings-gate.js claimAnswer)
    deviceID: announced.target.deviceID, settingsState: calleeSettings});
  this.unbilledPerChannel.set(data.channel, count + 1);
  // the bill request citing this token is exempt from the worker's message
  // rate (lib/worker-message.js) while the match is held, and only then
  if (!(wm.unbilledTokens instanceof Set)) wm.unbilledTokens = new Set();
  wm.unbilledTokens.add(token);
  // with the hop's caller as the callee's ctx shows it: the identity the
  // hop authorized as, {id, isAdmin}, never a key (R2-1 Task 5)
  // and this module's settings, as a routed call carries them (section 4.5),
  // noted as the worker's once posted
  const settings = settingsGate.toCarry(wm, calleeSettings);
  const posted = wm.sendPeerMeteringReplyToChild({msgID: msgID, errMsg: null, meteringResult: null, token: token,
    caller: identity.callerOf(callTokens.identityOf(tokenEntry)), inputBytes: checkedInput, target: announced.target, settings}, [checkedInput]);
  settingsGate.sent(wm, settings);
  return posted;
};

// A peer hop's error bytes holding a SETTING_REQUIRED or SETTING_NOT_READY
// claim -> its answer for the caller, checked exactly as a routed hop's
// (lib/settings-gate.js claimAnswer, outer false: the claim as it was, or a
// module fault); null for any other error, delivered as the callee's own.
function settingClaimIn(errorBytes, dm, due) {
  let payload = null;
  try { payload = serializedResultLib().decode(errorBytes); } catch (e) { return null; }
  const fields = (payload != null && typeof(payload.fields) === 'object') ? payload.fields : null;
  if (fields == null || (fields.errCode !== 'SETTING_REQUIRED' && fields.errCode !== 'SETTING_NOT_READY')) return null;
  let err = null;
  try { err = CountinghouseError.fromReplyFields(fields); } catch (e) { return new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a module\'s error could not be read'); }
  return settingsGate.claimAnswer(err, dm, due.deviceID, due.settingsState, false);
}

// [error, data] (a refusal, as the validators and module-spec give it) -> a
// reply's fields
function replyOf(refused) {
  return CountinghouseError.replyFields(refused[0]);
}

// Forgets a matched invoke: its entry, its count, its token, and its place
// in the worker's rate-exempt set (the review of #141, N4 and the narrow
// pass after it).
PeerChannelBroker.prototype.forgetUnbilled = function(token) {
  const due = this.unbilled.get(token);
  if (due == null) return null;
  this.unbilled.delete(token);
  const left = (this.unbilledPerChannel.get(due.channel) || 1) - 1;
  if (left > 0) this.unbilledPerChannel.set(due.channel, left); else this.unbilledPerChannel.delete(due.channel);
  if (due.wm != null && due.wm.unbilledTokens instanceof Set) due.wm.unbilledTokens.delete(token);
  callTokens.drop(token);
  return due;
};

// The callee's report once its handler ended: {token}, the token its
// metering reply carried, billable once, or {token, served: false} for a
// handler that failed, which bills nothing. The bill is for the matched
// invoke, found by that token among the matches of this worker: the token
// itself may have gone meanwhile (its chain answered: a caller that did not
// await its hop), and the handler still ran. Either way the invoke is over:
// its entry and token go, as the routed path drops the callee's when the
// hop answers. A report after the announcement plus the caller's timeout is
// refused PEER_CHANNEL_TIMEOUT: nothing is charged, the callee does not
// deliver the result, and the log says why. Answered as the metering reply
// used to be: {meteringResult}, or the deduction's error by its code, with the
// catalogue's own words or "metering unavailable", never its message (the
// callee does not deliver on RATE_LIMITED, PEER_CHANNEL_TIMEOUT or
// CALL_TOKEN_INVALID, and delivers on any other: a deduction that failed,
// Redis down, fails open as before); with no metering provider at all, the
// result is delivered and the reply says metering was unavailable. The
// deduction is waited for up to METER_PENDING_MS, then the hop is answered
// with its billing pending.
PeerChannelBroker.prototype.handleBillRequest = function(data, msgID, wm) {
  if (data == null) return wm.sendPeerMeteringReplyToChild(refusal(msgID));
  const match = (typeof(data.token) === 'string') ? this.unbilled.get(data.token) : null;
  // A bill the broker cannot match answers the callee only (the review of
  // #202, round 3): which of the caller's grants it was for is not known
  // without its entry, so the caller is not told; its own timer frees the
  // invoke's slot (lib/peer-channel.js).
  if (match == null || match.workerId !== wm.workerId) return wm.sendPeerMeteringReplyToChild(refusal(msgID));
  const due = this.forgetUnbilled(data.token);
  // Lean worker step 4: the main thread answers the caller (peer-result);
  // the callee no longer does. Only bytes a validator passed reach it as a
  // result.
  const deliver = (fields, transfer) => {
    try {
      due.callerWM.sendPeerResultToChild(Object.assign({channel: due.channel, invokeId: due.invokeId, epoch: due.epoch}, fields), transfer);
    } catch (e) {
      LOG.E(e);
    }
  };
  const refuse = (err) => deliver(Object.assign({}, CountinghouseError.replyFields(err)));
  // the announcing call's own cap (lib/call-limits.js)
  const cap = callLimits.of(due).maxOutputBytes;
  const tooLarge = (bytes) => CountinghouseError.withFields('OUTPUT_TOO_LARGE', {module: due.calleeName, action: due.actionName, bytes: bytes.byteLength, max: cap,
    raise: callLimits.raiseHint(bytes.byteLength)});
  const overCap = (bytes) => Number.isInteger(cap) && bytes.byteLength > cap;

  if (data.served === false) {
    // the handler's error, as bytes: capped, then delivered as it is (the
    // callee's own error, as on a routed hop); nothing billed
    const errorBytes = (data.errorBytes instanceof ArrayBuffer) ? data.errorBytes : null;
    if (errorBytes == null) refuse(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the hop could not be served'));
    else if (overCap(errorBytes)) refuse(tooLarge(errorBytes));
    else {
      // A settings claim (SETTING_REQUIRED, SETTING_NOT_READY) is checked
      // here, as on a routed hop (lib/device-manager.js sendCounted): a
      // declared setting unset goes on to the caller as the claim; any other
      // is a module fault. Decoded here for every error, never by a flag the
      // callee's own worker sets (a callee could leave it off).
      const claimed = settingClaimIn(errorBytes, this.dm, due);
      if (claimed != null) refuse(claimed);
      else deliver({errorBuffer: errorBytes}, [errorBytes]);
    }
    return wm.sendPeerMeteringReplyToChild({msgID: msgID, errMsg: null, meteringResult: null});
  }
  if (Date.now() > deadlineNow(due)) {
    // a coded refusal: the callee does not deliver the result on it (the
    // review of #141, N1), so a late hop is not billed and its result not
    // delivered
    LOG.I(`peer hop ${due.tool} refused: it answered after the caller's timeout (${callerTimeoutMs(due)} ms), so the caller had failed it`);
    refuse(new CountinghouseError('PEER_CHANNEL_TIMEOUT'));
    return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null},
      CountinghouseError.replyFields(new CountinghouseError('PEER_CHANNEL_TIMEOUT'))));
  }
  // the result, as bytes: capped by its length, then checked against the
  // callee's output schema in a validator (a stall there is a strike
  // against the callee, as on a routed hop)
  const outputBytes = (data.outputBytes instanceof ArrayBuffer) ? data.outputBytes : null;
  if (outputBytes == null || overCap(outputBytes)) {
    refuse(outputBytes == null ? new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a hop\'s result must cross as bytes') : tooLarge(outputBytes));
    return wm.sendPeerMeteringReplyToChild({msgID: msgID, errMsg: null, meteringResult: null});
  }
  // the caller passed, as on the routed path; a match always holds a spec
  // (an input whose spec is not held is refused at the match)
  const validated = moduleSpec.validateSerialized(due.checked, 'output', outputBytes, due.caller);
  return validated.then((answer) => ({answer}), (error) => ({error})).then(({answer, error}) => process.nextTick(() => {
    if (error != null || answer == null || (answer.refused == null && !(answer.buffer instanceof ArrayBuffer))) {
      if (error != null) LOG.E(error);
      refuse(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a hop\'s result could not be checked'));
      return wm.sendPeerMeteringReplyToChild({msgID: msgID, errMsg: null, meteringResult: null});
    }
    if (answer.refused != null) {
      // a result the callee's own schema refuses: the caller gets the
      // refusal, and nothing is billed (it is the callee's fault)
      refuse(answer.refused[0]);
      return wm.sendPeerMeteringReplyToChild({msgID: msgID, errMsg: null, meteringResult: null});
    }
    // the caller's timer may have fired while the result was checked
    if (Date.now() > due.deadline) {
      refuse(new CountinghouseError('PEER_CHANNEL_TIMEOUT'));
      return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null},
        CountinghouseError.replyFields(new CountinghouseError('PEER_CHANNEL_TIMEOUT'))));
    }
    return this.billChecked(due, msgID, wm, answer.buffer, deliver);
  }));
};

// A checked result is billed, then delivered, as before: on RATE_LIMITED,
// PEER_CHANNEL_TIMEOUT or CALL_TOKEN_INVALID the caller gets the refusal and
// not the result; on any other failure of the deduction (Redis down) the
// result is delivered (fails open, as before); with no metering provider it
// is delivered and the callee told metering was unavailable. The deduction
// is waited for up to METER_PENDING_MS, then the result is delivered with
// its billing pending.
PeerChannelBroker.prototype.billChecked = function(due, msgID, wm, bytes, deliver) {
  const withResult = (platformMetering) => deliver({dataBuffer: bytes, platformMetering: platformMetering}, [bytes]);
  if (CHUtil.ci == null) {
    withResult(undefined);
    return wm.sendPeerMeteringReplyToChild({msgID: msgID, errMsg: 'metering unavailable', meteringResult: null});
  }
  // (one rule for every hop path, lib/metering/charge-bound.js: the charge
  // issued once, waited for at most METER_PENDING_MS unless this caller
  // already has its allowance of charges pending, its late outcome logged)
  return boundedCharge(CHUtil.ci, due.billingKey, due.tool, options.mcpToolCallCost, (err, result, pending) => {
    if (pending) {
      withResult({billingPending: true});
      return wm.sendPeerMeteringReplyToChild({msgID: msgID, errMsg: null, meteringResult: null, billingPending: true});
    }
    if (err) {
      // (its code kept; the key, should the store's message repeat it, by its meterId)
      LOG.E(chargeLost(due.tool, due.billingKey, options.mcpToolCallCost, err));
      if (err.code === 'RATE_LIMITED' || err.code === 'PEER_CHANNEL_TIMEOUT' || err.code === 'CALL_TOKEN_INVALID') {
        // (to the caller worker: as the callee is told, never the store's message)
        deliver(meteringReplyOf(err));
      } else {
        withResult(undefined);
      }
      // (to the callee worker, which logs it: the code and the catalogue's words only, never the store's message)
      return wm.sendPeerMeteringReplyToChild(Object.assign({msgID: msgID, meteringResult: null}, meteringReplyOf(err)));
    }
    // the outer call's progress (M9): this hop is a tick once billed
    if (due.progress != null) due.progress.tick();
    // the charge as a module may see it: no key (the review of #163)
    const forModule = meteringProviderLib.forModule(result);
    withResult(forModule);
    return wm.sendPeerMeteringReplyToChild({msgID: msgID, errMsg: null, meteringResult: forModule});
  // (the caller's deadline as it is when read)
  }, {what: 'peer hop', opts: {session: due.session}, deadline: () => deadlineNow(due)});
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
// A record whose re-check is still waiting (the identity index, the
// AuthProvider) when the next tick fires is not asked again on top of
// itself; every other record is: one slow record never delays another's
// revocation.
//
// Bound: a revoked grant stops working within one interval plus its own
// re-check (the provider's lookup, after the index's answer on a miss --
// at most RECHECK_INDEX_BOUND_MS plus --peerChannelAuthLookupTimeoutMs).
// Calls already in flight on the channel when it closes fail with PEER_GONE.
// Tests only: the re-check's timers on a clock of the test's,
// {setTimeout(fn, ms), clearTimeout(t)}, as identity's setClock
PeerChannelBroker.prototype.setClockForTests = function(clock) {
  this.clock = clock;
};

PeerChannelBroker.prototype.recheckGrants = function() {
  for (const pairKey in this.channelRegistry) {
    const entry = this.channelRegistry[pairKey];

    for (const key in entry.grants) {
      // (a pair already closed by one of its records: the rest ask nothing)
      if (this.channelRegistry[pairKey] !== entry) break;
      const record = entry.grants[key];
      // (one still being checked: not again on top of itself)
      if (record.checking === true) continue;
      const grant = {id: record.id, deviceID: record.deviceID};

      // The index's answer is bounded by its own refill (identity's
      // freshRefill: its throttle and its read's deadline); the provider's
      // authorization has a deadline (R2-1 Task 3, the reviewer's M13): one
      // that accepts it and never answers closes the channel as
      // unconfirmed, and never leaves this pass in flight. An answer after
      // the deadline changes nothing.
      this.recheckInFlight++;
      record.checking = true;
      let settled = false;
      let timer = null;
      const done = (err) => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        this.clock.clearTimeout(watchdog);
        this.recheckInFlight--;
        record.checking = false;
        if (err != null) this.closeRevoked(pairKey, entry, grant, err);
      };
      // (and the whole re-check a bound of its own, from the start: the
      // index's answer within RECHECK_INDEX_BOUND_MS, then the provider's
      // deadline -- never a pass left in flight, every later one skipped)
      const watchdog = this.clock.setTimeout(() => done(Object.assign(new CountinghouseError('SYSTEM_ERROR_USERDB_NA',
        'the re-check did not finish'), {closeReason: UNCONFIRMED})), RECHECK_INDEX_BOUND_MS + options.peerChannelAuthLookupTimeoutMs);
      recheckTarget(record, (target) => {
        if (settled) return undefined;
        if (target.why != null) return done(target.why);
        if (this.channelRegistry[pairKey] !== entry) return done(null);
        timer = this.clock.setTimeout(() => done(Object.assign(new CountinghouseError('SYSTEM_ERROR_USERDB_NA',
          `the authorization lookup did not answer within ${options.peerChannelAuthLookupTimeoutMs} ms`), {closeReason: UNCONFIRMED})), options.peerChannelAuthLookupTimeoutMs);
        return userAuth(null, null, grant.deviceID, target.appKey, null, null, () => {}, (err) => done(err));
      });
    }
  }
};

PeerChannelBroker.prototype.closeRevoked = function(pairKey, entry, grant, err) {
  // a second failing grant on the same pair, or a worker reload in between,
  // has already taken this channel down
  if (this.channelRegistry[pairKey] !== entry) return;

  delete this.channelRegistry[pairKey];

  // Both workers told first, each on its own: what follows may throw (a
  // held request's refusal to a worker exiting, the log), and a channel the
  // broker no longer tracks must never stay open in them. Nothing here
  // throws out of a re-check's pass.
  // (each its own role on this pair: the caller's channel to the callee, the
  // callee's from the caller; the pair the other way, if there is one, is
  // its own grant and keeps serving -- #526's high, M2)
  try { entry.callerWM.sendPeerInvalidateToChild({workerId: entry.calleeWM.workerId, role: 'caller'}); } catch (e) { /* the worker is gone */ }
  try { entry.calleeWM.sendPeerInvalidateToChild({workerId: entry.callerWM.workerId, role: 'callee'}); } catch (e) { /* the worker is gone */ }
  try { this.forgetPair(pairKey); } catch (e) { try { LOG.E(e); } catch (logErr) { /* logged where it can be */ } }

  // The grant names the caller by its opaque id, never a key.
  try {
    LOG.I(`peer channel ${pairKey} closed: caller ${grant.id} is no longer authorized for device ${
      grant.deviceID} (${err.code != null ? err.code : err.message}${typeof(err.closeReason) === 'string' ? `: ${err.closeReason}` : ''})`);
  } catch (e) { /* the log is out of reach */ }
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

  toRemove.forEach((pairKey) => {
    delete this.channelRegistry[pairKey];
    this.forgetPair(pairKey);
  });
  // the worker's matched invokes, billed or not, end with it
  for (const [t, u] of this.unbilled) if (u.workerId === wm.workerId) this.forgetUnbilled(t);
};

// A channel is gone: its announcements go with it (a channel granted again
// on the same pair starts its invoke ids over), and its held metering
// requests are refused.
PeerChannelBroker.prototype.forgetPair = function(pairKey) {
  for (const [key, a] of this.announced) if (a.channel === pairKey) this.forgetAnnounced(key);
  // its matched invokes too (the review of #141, N5): the caller saw
  // PEER_GONE for them, so their bills are refused and nothing is charged
  for (const [t, u] of this.unbilled) if (u.channel === pairKey) this.forgetUnbilled(t);
  const q = this.held.get(pairKey);
  if (q != null) {
    this.held.delete(pairKey);
    q.forEach((item) => { clearTimeout(item.timer); item.wm.sendPeerMeteringReplyToChild(refusal(item.msgID)); });
  }
};

PeerChannelBroker.prototype.sweep = function() {
  const now = Date.now();
  for (const [key, a] of this.announced) {
    if (now - a.at > tokenTtlMs(a) || callTokens.resolve(a.token, {workerId: a.workerId}) == null) this.forgetAnnounced(key);
  }
  // a matched invoke whose bill would be refused now (past the caller's
  // timeout) is forgotten, with its token and credit
  for (const [t, u] of this.unbilled) if (now > u.deadline) this.forgetUnbilled(t);
  // an announcement older than the caller's timeout matches nothing now
  for (const [key, a] of this.announced) if (now >= (Number.isFinite(a.deadline) ? a.deadline : a.at + callerTimeoutMs(a))) this.forgetAnnounced(key);
};

PeerChannelBroker.UNBILLED_PER_CHANNEL_MAX = UNBILLED_PER_CHANNEL_MAX;

// an entry's deadline now, for sessions 07
PeerChannelBroker.deadlineNow = deadlineNow;
PeerChannelBroker.RECHECK_INDEX_BOUND_MS = RECHECK_INDEX_BOUND_MS;
// A charge's failure as the callee worker is told it (a worker logs it, so
// module code can reach it): a catalogue code with the catalogue's own words,
// or "metering unavailable" for anything else; never the store's message,
// which on the local store names the ledger's path.
const CODE_FORM = /^[A-Z][A-Z0-9_]{1,63}$/;
function meteringReplyOf(err) {
  // (read guarded, as replyFields reads it: a getter can't decide it, nor throw here)
  const raw = (err != null && typeof(err) === 'object') ? readGuarded(err, 'code') : null;
  const code = (typeof(raw) === 'string') ? raw : null;
  if (code != null && Object.prototype.hasOwnProperty.call(CATALOGUE, code)) {
    // (a catalogue text with {placeholders} needs its fields, which this path has not got)
    const text = new CountinghouseError(code).message;
    return /[{}]/.test(text) ? {errMsg: 'metering unavailable', errCode: code} : {errMsg: text, errCode: code};
  }
  // (another code, such as a store's ECONNREFUSED, kept when it has a code's form: its message never)
  return (code != null && CODE_FORM.test(code)) ? {errMsg: 'metering unavailable', errCode: code} : {errMsg: 'metering unavailable'};
}

module.exports = PeerChannelBroker;
module.exports.meteringReplyOf = meteringReplyOf;

//TODO: consider replace bson with bson-ext native addon to increase message passing performance
const Worker         = require('worker_threads').Worker;
const isMainThread   = require('worker_threads').isMainThread;
const parentPort     = require('worker_threads').parentPort;

const events         = require('events');
const util           = require('util');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const {SerializedResult} = require('./serialized-result');


function WorkerMessage(worker) {
  this.msgQueue = {};
  this.msgID = 0;
  this.worker = worker;
  this.deviceList = {};    // deviceID as key, store specs for each device object hosted by the worker thread
  this.moduleName   = null;
  this.packageInfo  = null;
  this.modulePath   = null;
  // Set once the worker has ended: {code, name, reason} (see endWith).
  this.ended        = null;
  // The ids of requests sent with serializedReply (a hop, lean worker step
  // 2): only their replies may, and must, carry bytes.
  this.bytesExpected = new Set();
  // Module sandbox message rate (main side): a token bucket per worker,
  // refilled continuously. null = unlimited (--moduleSandbox off).
  this.messageRate  = null;
  this.rateTokens   = 0;
  this.rateRefillAt = Date.now();
  // child thread will have null worker field
  if (this.worker != null) this.worker.on('message', this.onWorkerMessage.bind(this));
}

util.inherits(WorkerMessage, events.EventEmitter);

// Not counted against the message rate, and bounded here on the main thread
// instead: module code can reach this worker's WorkerMessage and send any
// command itself, so no bound the worker applies counts. sandbox-violation
// is capped per worker (MAX_VIOLATION_REPORTS); peer-self-invalidate is
// idempotent and handled at most once per event-loop turn. Either, refused
// outright, would be lost: they have no callback for rate-limited-reply.
// peer-bill-request is exempt only when it cites a token the broker holds
// as a matched, unbilled invoke of this worker (wm.unbilledTokens, kept by
// lib/peer-channel-broker.js; the review of #138, 6, and of #141): refused,
// the handler would have run and its bill been lost. Any other bill request
// (a module posting its own, a late one for a forgotten invoke) is counted
// like any message, and cannot use up an exemption a live invoke needs.
const RATE_EXEMPT = new Set(['sandbox-violation', 'peer-self-invalidate']);
const MAX_VIOLATION_REPORTS = 100;

// invoke from main thread
WorkerMessage.prototype.sendLoadModuleMessage = function(message, callback) {
  message.command = 'load-module';
  this.sendMessageToWorker(message, callback);
};

// invoke from main thread: a discarded load that only runs the validator
// (countinghouse_validate_module; review R1-4).
WorkerMessage.prototype.sendValidateModuleMessage = function(message, callback) {
  message.command = 'validate-module';
  this.sendMessageToWorker(message, callback);
};

WorkerMessage.prototype.sendUnloadModuleMessage = function(message, callback) {
  message.command = 'unload-module';
  this.sendMessageToWorker(message, callback);
};

// invoke from main thread
WorkerMessage.prototype.sendSetOptionsMessage = function(message, callback) {
  message.command = 'set-options';
  this.sendMessageToWorker(message, callback);
};

// invoke from main thread: the blocked-loop heartbeat (lib/worker-limits.js).
WorkerMessage.prototype.sendSandboxPingMessage = function(callback) {
  this.sendMessageToWorker({command: 'sandbox-ping'}, callback);
};

// invoke from main thread only, after DeviceManager.prototype.
// verifyComposition resolves {identity, allowed} for a device hosted by
// this worker. The real CHDevice buildCtx/ctx.call read _composition off of
// lives inside the worker, not on this WorkerMessage proxy -- this is what
// gets that result there. message: {deviceID, identity, allowed}.
WorkerMessage.prototype.sendSetCompositionMessage = function(message, callback) {
  message.command = 'set-composition';
  this.sendMessageToWorker(message, callback);
};

// invoke in main thread
WorkerMessage.prototype.sendInvokeActionMessage = function(message, callback) {
  message.command = 'invoke-action';
  this.sendMessageToWorker(message, callback);
};

WorkerMessage.prototype.sendGetSpecMessage = function(message, callback) {
  message.command = 'get-spec';
  this.sendMessageToWorker(message, callback);
};

WorkerMessage.prototype.sendGetDeviceSchemaMessage = function(message, callback) {
  message.command = 'get-schema';
  this.sendMessageToWorker(message, callback);
};

//the callback is invoked after stop discover is done
WorkerMessage.prototype.sendDiscoverMessage = function(message, callback) {
  message.command = 'discover-device';
  this.sendMessageToWorker(message, callback);
};

// message contains: {msgID: msgID, errMsg: errMsg, spec: spec}
WorkerMessage.prototype.sendDeviceQueryReplyToChild = function(message) {
  message.command = 'query-device-reply';
  this.sendMessageToWorker(message, null);
};

// message contains: {msgID: msgID, errMsg: errMsg}
WorkerMessage.prototype.sendDeviceLogReplyToChild = function(message) {
  message.command = 'device-log-reply';
  this.sendMessageToWorker(message, null);
};

WorkerMessage.prototype.sendRedisCommandReplyToChild = function(message) {
  message.command = 'redis-command-reply';
  this.sendMessageToWorker(message, null);
}

WorkerMessage.prototype.sendGetJobInfoReplyToChild = function(message) {
  message.command = 'get-job-info-reply';
  this.sendMessageToWorker(message, null);
}

// RC1-min, main -> child: {msgID, result} or the error's reply fields
// (CountinghouseError.replyFields), so the code survives the hop.
WorkerMessage.prototype.sendRemoteCallReplyToChild = function(message) {
  message.command = 'remote-call-reply';
  CountinghouseError.postReply((m) => this.sendMessageToWorker(m, null), message);
};

// message contains: {msgID: msgID, errMsg: errMsg, meteringResult: meteringResult}
// -- reply to sendPeerMeteringRequestToParent, same shape/pattern as
// sendGetJobInfoReplyToChild above.
WorkerMessage.prototype.sendPeerMeteringReplyToChild = function(message) {
  message.command = 'peer-metering-reply';
  this.sendMessageToWorker(message, null);
}

// --- direct peer channels (docs/direct-peer-channels-design.md), main -> child ---

// D1: told to the *caller* worker A -- either a fresh port (new pair, `port`
// present, transferred) or a bare ack that a previously-granted port for
// this worker pair should now also be used for `targetDeviceID` (no new
// MessageChannel, `port` omitted). See lib/peer-channel-broker.js#grant.
WorkerMessage.prototype.sendPeerChannelGrantToChild = function(message, port) {
  message.command = 'peer-channel-grant';
  if (this.worker == null) return;
  if (port != null) return this.worker.postMessage(message, [port]);
  return this.worker.postMessage(message);
};

// D3: told to the caller worker A when brokering was denied (unknown
// device, self-target, or the userAuth check failed).
WorkerMessage.prototype.sendPeerChannelDenyToChild = function(message) {
  message.command = 'peer-channel-deny';
  if (this.worker != null) this.worker.postMessage(message);
};

// D1: told to the *callee* worker B -- always carries a fresh port (B only
// ever learns about a peer channel when a brand new one is created for it;
// see lib/peer-channel-broker.js#grant's "already connected" branch, which
// only re-notifies A, not B, since B's existing handler already accepts
// peer-invoke for any deviceID it hosts).
// The broker granted one more device on an existing channel: the callee
// learns it, and answers, before the caller is told (review R2-2).
WorkerMessage.prototype.sendPeerChannelAllowToChild = function(message, callback) {
  message.command = 'peer-channel-allow';
  this.sendMessageToWorker(message, callback);
};

WorkerMessage.prototype.sendPeerChannelOpenToChild = function(message, port) {
  message.command = 'peer-channel-open';
  message.port     = port; // must be on the message itself, not just in the transferList, or the receiving side has nothing to read msg.port from
  if (this.worker != null) this.worker.postMessage(message, [port]);
};

// D4: told to whichever worker did NOT trigger the reload/unload/exit, so
// it can drop its now-stale cached port for the affected workerId.
WorkerMessage.prototype.sendPeerInvalidateToChild = function(message) {
  message.command = 'peer-invalidate';
  if (this.worker != null) this.worker.postMessage(message);
};

// message contains: {msgID: msgID, errMsg: errMsg, errCode: errCode, data: data}
// errCode is optional (absent/null when the caller had no `.code`, e.g. a
// bare Error) and rides as a sibling of errMsg, never merged into `data` --
// see the comment at its device-manager.js call sites for why. Mirrors
// lib/peer-channel.js's peer-reply message, which already carries errCode
// for the --directPeerChannels path.
// The envelope is built by its caller (CountinghouseError.replyFields); a
// body that cannot be cloned is answered as a crash (postReply).
WorkerMessage.prototype.sendActionInvokeReplyToChild = function(message) {
  message.command = 'invoke-action-reply';
  // A hop's result as bytes (lean worker step 2): relayed as dataBuffer, its
  // ArrayBuffer transferred, never read here.
  if (message.data instanceof SerializedResult) {
    const buffer = message.data.buffer;
    message.data = null;
    message.dataBuffer = buffer;
    // transferred on the first post only: postReply's fallback (an error in
    // its place) carries no bytes
    let first = true;
    return CountinghouseError.postReply((m) => {
      if (first) {
        first = false;
        return this.sendMessageToWorker(m, null, [buffer]);
      }
      delete m.dataBuffer;
      return this.sendMessageToWorker(m, null);
    }, message);
  }
  CountinghouseError.postReply((m) => this.sendMessageToWorker(m, null), message);
};

// invoke in main thread. Called once the worker has ended (module-manager.js,
// on its 'exit'), whatever ended it: every request still waiting for a reply
// -- calls, jobs, the unload's own acknowledgement -- is answered now with
// the code that says why, instead of never, and so is any request sent from
// here on (posting to an ended worker drops the message silently).
WorkerMessage.prototype.endWith = function(code, name, reason) {
  if (this.ended != null) return;
  this.ended = {code: code, name: name, reason: reason};
  const pending = this.msgQueue;
  this.msgQueue = {};
  this.bytesExpected.clear();
  Object.keys(pending).forEach((id) => {
    if (typeof(pending[id]) === 'function') pending[id](new CountinghouseError(code, name, reason), null);
  });
};

// invoke in main thread, message handler defined in app-sandbox
// transfer: ArrayBuffers in message to move to the worker, not copy (a
// hop's result, lean worker step 2); only for a message with no reply.
WorkerMessage.prototype.sendMessageToWorker = function(message, callback, transfer) {
  if (this.ended != null) {
    if (typeof(callback) === 'function') callback(new CountinghouseError(this.ended.code, this.ended.name, this.ended.reason), null);
    return;
  }
  if (this.worker != null) {
    //callback null indicates this message doesn't need reply
    //usually this is a reply to child initiated message
    if (callback == null) return (transfer != null) ? this.worker.postMessage(message, transfer) : this.worker.postMessage(message);

    const id = this.msgID;
    message.id = id;
    this.msgQueue[id] = callback;
    this.msgID++;
    if (message.serializedReply === true) this.bytesExpected.add(id);

  // https://nolanlawson.com/2016/02/29/high-performance-web-worker-messages/ said sending full stringifyied message is faster than sending raw objects
  // we need to review this in the future
    this.worker.postMessage(message);
  }
};

// a message sending from child to parent has following fields:
// {id:       message id,
//  category: "child" or "reply", indicates child created message or reply message
//  command:  null for reply category, string name of the command for child message
//  errMsg:   null for child created message, contains error information for reply message
//  data:     contains the data sending to parent
// }

// invoke in main thread
WorkerMessage.prototype.onWorkerMessage = function(msg) {
  const id = msg.id;

  if (id == null) return;

  //deviceonline and jobprogress msg are origined from childs and doesn't have associated parent created callbacks
  if (id === 'deviceonline') return this.emit('deviceonline', msg, this);
  if (id === 'jobprogress')  return this.emit('jobprogress', msg, this);

  if (msg.category === 'reply') {
    if (this.msgQueue[id] != null) {
      const callback = this.msgQueue[id];
      if (callback == null || typeof(callback) !== 'function') return;

      // A hop's result crosses as bytes (lean worker step 2), held here and
      // never read; only a request that asked for bytes gets them, and it
      // gets nothing else: a plain value there would skip the length cap,
      // and bytes anywhere else would reach a client unread.
      const expectsBytes = this.bytesExpected.delete(id);
      if (msg.errMsg != null) {
        callback(CountinghouseError.fromReplyFields(msg), msg.data);
      } else if (expectsBytes) {
        if (msg.dataBuffer instanceof ArrayBuffer) callback(null, new SerializedResult(msg.dataBuffer));
        else callback(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a module\'s result did not cross as bytes'), null);
      } else if (msg.dataBuffer != null) {
        callback(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a reply carried bytes it was not asked for'), null);
      } else {
        callback(null, msg.data);
      }
      delete this.msgQueue[id];
    }
  } else if (msg.category === 'child') {
    const billOfAMatch = msg.command === 'peer-bill-request' && this.unbilledTokens instanceof Set && msg.data != null &&
      typeof(msg.data.token) === 'string' && this.unbilledTokens.has(msg.data.token);
    if (this.messageRate != null && !RATE_EXEMPT.has(msg.command) && !billOfAMatch) {
      const now = Date.now();
      this.rateTokens = Math.min(this.messageRate, this.rateTokens + (now - this.rateRefillAt) * this.messageRate / 1000);
      this.rateRefillAt = now;
      if (this.rateTokens < 1) {
        if (this.worker == null) return;
        // Fire-and-forget, so answered with a deny: the worker then fails
        // the calls queued on that device and asks again on the next one.
        if (msg.command === 'peer-channel-request') {
          return this.sendPeerChannelDenyToChild({targetDeviceID: (msg.data != null) ? msg.data.targetDeviceID : null,
            errMsg: 'too many messages to the main thread (--moduleMessageRate)', errCode: 'RATE_LIMITED'});
        }
        // Also fire-and-forget: answered at once, so the invoke fails now
        // with RATE_LIMITED, not a second later as CALL_TOKEN_INVALID when
        // the callee's unmatched metering request is refused.
        if (msg.command === 'peer-announce') {
          return this.worker.postMessage({command: 'peer-announce-refused', channel: (msg.data != null) ? msg.data.channel : null,
            invokeId: (msg.data != null) ? msg.data.invokeId : null, errMsg: 'too many messages to the main thread (--moduleMessageRate)', errCode: 'RATE_LIMITED'});
        }
        this.worker.postMessage({command: 'rate-limited-reply', msgID: id});
        return;
      }
      this.rateTokens -= 1;
    }

    if (msg.command == null) return;

    switch(msg.command) {
      case 'querydevice': {
        // a bare deviceID, or {deviceID, token, appKey} (R2-1 Task 3): the
        // call's token and, side by side, the identity the module names
        const data = msg.data;
        const claim = (data != null && typeof(data) === 'object') ? data : {deviceID: data};
        this.emit('querydevice', {deviceID: claim.deviceID, token: claim.token, appKey: claim.appKey, id: id}, this);
        break;
      }
      case 'invokeforeignaction': {
        this.emit('invokeforeignaction', {data: msg.data, id: id}, this);
        break;
      }
      case 'devicelog': {
        this.emit('devicelog', {data: msg.data, id: id}, this);
        break;
      }
      case 'rediscommand': {
        this.emit('rediscommand', {data: msg.data, id: id}, this);
        break;
      }
      case 'getjobinfo': {
        this.emit('getjobinfo', {data: msg.data, id: id}, this);
        break;
      }
      // direct peer channels (docs/direct-peer-channels-design.md), child -> main
      case 'peer-channel-request': {
        this.emit('peer-channel-request', {data: msg.data, id: id}, this);
        break;
      }
      case 'peer-metering-request': {
        this.emit('peer-metering-request', {data: msg.data, id: id}, this);
        break;
      }
      // R2-1 Task 3 (spec 10b): the caller worker's announcement of one peer
      // invoke, {channel, invokeId, token}; fire-and-forget.
      case 'peer-announce': {
        this.emit('peer-announce', {data: msg.data, id: id}, this);
        break;
      }
      // R2-1 Task 3: the callee's bill request for a served peer invoke,
      // {token}; answered like the metering request (peer-metering-reply).
      case 'peer-bill-request': {
        this.emit('peer-bill-request', {data: msg.data, id: id}, this);
        break;
      }
      case 'peer-self-invalidate': {
        if (this.selfInvalidateThisTurn === true) break;
        this.selfInvalidateThisTurn = true;
        setImmediate(() => { this.selfInvalidateThisTurn = false; });
        this.emit('peer-self-invalidate', {id: id}, this);
        break;
      }
      // RC1-min: ctx.call('remote:...') from module code; the parent's
      // listener (lib/module-manager.js) answers for the worker's own module.
      case 'remote-call': {
        this.emit('remote-call', {data: msg.data, id: id}, this);
        break;
      }
      case 'sandbox-violation': {
        this.violationReports = (this.violationReports || 0) + 1;
        if (this.violationReports > MAX_VIOLATION_REPORTS + 1) break;
        this.emit('sandbox-violation', this.violationReports > MAX_VIOLATION_REPORTS ? {rule: 'suppressed', target: ''} : msg.data, this);
        break;
      }
    }
  }
  //or else discard this message
};

// invoke from worker to send an independent device online message, not as a reply
// to previous msg from parent, in this case we set special msg id to deviceonline
WorkerMessage.prototype.sendDeviceOnlineMessageToParent = function(msg) {
  return this.sendMessageToParent('deviceonline', null, msg);
};

// invoke in child thread only
WorkerMessage.prototype.sendJobProgressMessageToParent = function(msg) {
  return this.sendMessageToParent('jobprogress', null, msg);
};

//invoke from worker to reply a message to parent, or a message initiated in worker and doesn't expect reply (applies to deviceonline, jobprgress, heapstats etc events only)
//
// A module's error (origin 'module', logger-design §5.1) crosses whole: its
// code and rendered message as for any error, plus errOrigin and its details
// (errDetails), as siblings on the envelope, never inside `data`. The main
// thread rebuilds it (CountinghouseError.fromReplyFields), so worker mode
// answers it exactly as single-thread mode does.
// A reply whose data cannot be cloned is still a reply: a crash, with no
// data (CountinghouseError.postReply).
// invoke in child thread only: a hop's result as v8.serialize bytes (lean
// worker step 2), their ArrayBuffer transferred, not copied. The main thread
// holds them as a SerializedResult (lib/serialized-result.js).
WorkerMessage.prototype.sendSerializedReplyToParent = function(id, buffer) {
  return parentPort.postMessage({command: null, id: id, category: 'reply', errMsg: null, data: null, dataBuffer: buffer}, [buffer]);
};

WorkerMessage.prototype.sendMessageToParent = function(id, err, data) {
  //reply category indicates a child reply message
  return CountinghouseError.postReply((m) => parentPort.postMessage(m),
    Object.assign({command: null, id: id, category: 'reply'}, CountinghouseError.replyFields(err), {data: data}));
};

// below calls are invoked from child worker threads only, and expect callbacks to child worker threads
// claim (R2-1 Task 3): {token, appKey}, the call's token and, side by side
// until Task 5, the identity the module names; with it the main thread
// answers a missing device with its reason to an identity granted the
// device. Without it, the bare deviceID as before.
WorkerMessage.prototype.sendDeviceQueryMessageToParent = function(deviceID, callback, claim) {
  const message = {};
  message.command = 'querydevice';
  message.data = (claim != null && claim.token != null) ? {deviceID: deviceID, token: claim.token, appKey: claim.appKey} : deviceID;

  return this.sendActiveMessageToParent(message, callback);
};

// invoke in child thread only
WorkerMessage.prototype.sendDeviceLogMessageToParent = function(deviceID, data, timestamp, callback) {
  const message = {};
  message.command = 'devicelog';
  message.data = {deviceID: deviceID, data: data, timestamp: timestamp};

  return this.sendActiveMessageToParent(message, callback);
};

// invoke in child thread only
WorkerMessage.prototype.sendGetJobInfoMessageToParent = function(jobID, callback) {
  const message = {};
  message.command = 'getjobinfo';
  message.data = {jobID: jobID};

  return this.sendActiveMessageToParent(message, callback);
}

// invoke in child thread only
WorkerMessage.prototype.sendRedisCommandToParent = function(commandData, callback) {
  const message = {};
  message.command = 'rediscommand';
  message.data = commandData;  // command data contains op and data field
  return this.sendActiveMessageToParent(message, callback);
};

// invoke in child thread only
// billingKey rides alongside appKey rather than replacing it: they are two
// different questions. appKey answers "may this call happen" (userAuth,
// device ownership); billingKey answers "who pays for it". A composing module
// keeps its own identity for the first and passes the outer caller's for the
// second -- see docs/composite-tools.md. Added to the request payload, never
// to a reply's `data`, which must stay exactly the callee's own output.
WorkerMessage.prototype.sendActionInvokeMessageToParent = function(appKey, billingKey, deviceID, serviceID, actionName, args, callback) {
  const message = {};
  message.command = 'invokeforeignaction'; // invoke goes to another thread
  // token (R2-1 Task 3): the call's token, by which the main thread bills
  // the hop; appKey and billingKey ride beside it until Task 5 removes them.
  message.data = {appKey: appKey, billingKey: billingKey, deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: args,
    token: (args != null && typeof(args.token) === 'string') ? args.token : undefined};

  return this.sendActiveMessageToParent(message, callback);
};

// --- direct peer channels (docs/direct-peer-channels-design.md), child -> main ---
// Fire-and-forget (no reply expected, so unlike sendActiveMessageToParent
// below it never touches msgQueue) -- peer-channel-request's eventual
// grant/deny is matched by targetDeviceID (see lib/device-manager.js's
// onPeerChannelGrant/onPeerChannelDeny). `id` still has to be non-null:
// onWorkerMessage (above) drops any message where it's missing, this
// being a generic requirement of every message a worker sends.
WorkerMessage.prototype.sendPeerChannelRequestToParent = function(data) {
  const id = this.msgID;
  this.msgID++;
  parentPort.postMessage({id: id, category: 'child', command: 'peer-channel-request', errMsg: null, data: data});
};

// R2-1 Task 3 (spec 10b): the caller worker announces each peer invoke to
// the main thread, {channel, invokeId, token}, so the callee's metering
// request for it can be matched to the call's token. Fire-and-forget, like
// peer-channel-request.
WorkerMessage.prototype.sendPeerAnnounceToParent = function(data) {
  const id = this.msgID;
  this.msgID++;
  parentPort.postMessage({id: id, category: 'child', command: 'peer-announce', errMsg: null, data: data});
};

// D5, and now also its main-thread-routed-path equivalent (see
// docs/composite-tools.md's "billing authority" principle): unlike the
// fire-and-forget peer-channel-request above, this *does* expect a reply
// -- the caller waits for the real {charged, balance} result before
// replying to whichever module made the call, so the platform's own
// authoritative metering result can be threaded back to it (see
// DeviceManager.prototype.onPeerChannelOpen). Uses the same
// sendActiveMessageToParent/msgQueue request-reply pattern every other
// child-initiated request in this file uses (querydevice, rediscommand,
// getjobinfo, ...), not a bespoke one.
WorkerMessage.prototype.sendPeerMeteringRequestToParent = function(data, callback) {
  const message = {};
  message.command = 'peer-metering-request';
  message.data = data;
  return this.sendActiveMessageToParent(message, callback);
};

// R2-1 Task 3: after a peer invoke's handler succeeded, {token}, the token
// the metering reply carried; the main thread bills the hop by it, once,
// and answers with the metering result (the same reply as above).
WorkerMessage.prototype.sendPeerBillRequestToParent = function(data, callback) {
  const message = {};
  message.command = 'peer-bill-request';
  message.data = data;
  return this.sendActiveMessageToParent(message, callback);
};

// D4: a same-worker in-place module reload (POST /load-module targeting an
// already-loaded module name -- see ModuleManager.prototype.onModuleLoad's
// "module reloaded" branch, reached via loadModuleByWorker's `wm != null`
// path, which reuses the existing Worker/threadId rather than creating a
// new one) purges this worker's own devices *entirely locally* -- the main
// thread's deviceMap/workerId for this worker never changes, so it has no
// other way to learn that any peer channel pointing at this worker is now
// stale. Sent unconditionally from DeviceManager.prototype.onPurgeDevice's
// worker-side branch on every local purge (reload or otherwise) --
// harmless and idempotent if this worker is also mid-crash/unload (the
// port's own native 'close' event covers that case redundantly), so there
// is no need to distinguish reload from other purge reasons here.
WorkerMessage.prototype.sendPeerSelfInvalidateToParent = function() {
  const id = this.msgID;
  this.msgID++;
  parentPort.postMessage({id: id, category: 'child', command: 'peer-self-invalidate', errMsg: null, data: null});
};

// RC1-min, child -> main: {remote, tool, args, billingKey}; the reply is
// remote-call-reply, correlated by msgQueue like get-job-info-reply.
WorkerMessage.prototype.sendRemoteCallToParent = function(data, callback) {
  return this.sendActiveMessageToParent({command: 'remote-call', data: data}, callback);
};

// invoke in child thread only: a module sandbox violation (lib/module-
// lockdown.js), already de-duplicated there. No reply.
WorkerMessage.prototype.sendSandboxViolationToParent = function(rule, target) {
  const id = this.msgID;
  this.msgID++;
  parentPort.postMessage({id: id, category: 'child', command: 'sandbox-violation', errMsg: null,
                          data: {rule: rule, target: target}});
};

// invoke in child thread only, send a child created message and expect reply from parent
WorkerMessage.prototype.sendActiveMessageToParent = function(message, callback) {
  const id = this.msgID;
  message.id = id;
  message.category = 'child';    // child category indicates a child created message
  message.errMsg = null;

  this.msgQueue[id] = callback;
  this.msgID++;

  parentPort.postMessage(message);
};

module.exports = WorkerMessage;
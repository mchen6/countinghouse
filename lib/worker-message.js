'use strict';
// A message's field set by definition, with what was taken at load: an
// assignment runs a setter a module put on Object.prototype, with the
// runtime's message (its token among its fields) as `this`.
const ObjectDefinePropertyWM = Object.defineProperty;
const ObjectKeysWM = Object.keys;
// a queued request's deadline (ms), keyed by its callback: set as the request
// is queued (sendMessageToWorker's deadline), so it can't outlive or lag its
// entry in msgQueue (inFlight reads it). A callback is the one closure its
// sender made for that request.
const requestDeadline = new WeakMap();
const setOwn = (o, key, v) => ObjectDefinePropertyWM(o, key, {__proto__: null, value: v, writable: true, enumerable: true, configurable: true});
const Worker         = require('worker_threads').Worker;
const isMainThread   = require('worker_threads').isMainThread;
const parentPort     = require('worker_threads').parentPort;

const events         = require('events');
const util           = require('util');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const {SerializedResult} = require('./serialized-result');
// Every message to the main thread crosses as bounded bytes (#170).
const {performance} = require('perf_hooks');
const envelope = require('./message-envelope');
const options        = require('./cli-options');

// loaded at boot in every worker already (test/sandbox/43), with no cycle:
// required here once, not on every call
const hopInput = require('./hop-input');
const hopInputLib = () => hopInput;
// The worker's own post, looked up at each send. Under audit and enforce the
// lockdown pins parentPort's methods (lib/message-envelope.js pinPort)
// before any module code runs, so the lookup always finds Node's own; under
// off a module shares the realm and the runtime's objects anyway, and the
// envelope is cooperative there (the test fixtures that stand for such a
// module read and rewrite what is sent, as before).
const rawPost = (e, transfer) => parentPort.postMessage(e, transfer);
// The cap a message to the main thread may reach: --maxOutputBytes plus the
// envelope's headroom (lib/message-envelope.js).
const messageCap = () => envelope.capFor(options.maxOutputBytes);

// invoke in child thread only: a message to the main thread, as an envelope.
// Throws MESSAGE_TOO_LARGE over the cap, before anything is posted.
function post(message, transfer) {
  // what the module wrote goes before the runtime's reply: a worker the main
  // thread ends after its reply (a validation, an unload) would lose it
  if (message != null && message.category === 'reply') for (let i = 0; i < beforeReply.length; i++) beforeReply[i]();
  const w = envelope.wrap(message, messageCap(), transfer);
  return rawPost(w.envelope, w.transfer);
}

// Set at boot (lib/worker-stdio.js, lib/worker-logger.js): each sends what it
// still holds before a reply.
const beforeReply = [];


function WorkerMessage(worker) {
  // id -> the callback its reply settles: no prototype, and written as an own
  // property (setOwn), so a setter or getter module code put on
  // Object.prototype for an id is never handed a callback (the reply it
  // settles can carry a token: a peer metering reply's)
  this.msgQueue = {__proto__: null};
  this.msgID = 0;
  this.worker = worker;
  // a device query's id -> the token it was asked under (main thread): its
  // answer is the main thread's own, so a refusal is noted on that call;
  // bounded, a query never answered being dropped first
  this.queried = new Map();
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
  this.rateRefillAt = performance.now();
  // progress messages (jobprogress, callprogress): a bucket of their own,
  // at the same rate, so heavy progress never makes a request RATE_LIMITED;
  // dropped past it, counted (F4-3)
  this.progressTokens = null;
  this.progressRefillAt = performance.now();
  this.progressDropped = 0;
  this.progressDroppedLoggedAt = null;
  // a task's progress held for the next flush, by run (lib/device-manager.js)
  this.progressPending = null;
  this.progressFlush = null;
  this.progressWrites = null;
  this.progressRefused = 0;
  this.progressRefusedLoggedAt = null;
  // and its bytes (F4-4): charged from each envelope's length before it is
  // decoded, BYTE_BUDGET_CAPS of its message cap a second, a burst of as
  // much; past it held undecoded, in order, up to as much again
  // set at a module worker's spawn (lib/module-manager.js), before its load:
  // module code at require time is budgeted too
  this.byteBudgeted = false;
  this.condemned    = false;
  this.byteTokens   = null;
  this.byteRefillAt = performance.now();
  this.held         = [];
  this.heldHead     = 0;   // the queue's head: an index, no array method (test/sandbox/64)
  this.heldBytes    = 0;
  this.heldTimer    = null;
  this.heldCap      = null;
  // The cap for this worker's messages (lib/message-envelope.js); null is
  // the main thread's --maxOutputBytes plus the headroom (a test sets it).
  this.messageCap   = null;
  // Main side: called with each message once it is decoded and handled (the
  // validation worker's refusals, lib/module-manager.js).
  this.onDecoded    = null;
  // child thread will have null worker field
  if (this.worker != null) this.worker.on('message', this.onEnvelope.bind(this));
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
// Counted like any message, but past the rate dropped without an answer
// (fire-and-forget: nothing waits for one) and counted with what their
// budgets drop (lib/worker-output.js).
const RATE_QUIET = new Set(['log', 'stdout', 'stderr']);
const MAX_VIOLATION_REPORTS = 100;
// A module worker's bytes a second to the main thread, as messages: this
// many of its message cap (lib/message-envelope.js capFor: --maxOutputBytes
// plus the headroom), and a burst of as much (F4-4)
const BYTE_BUDGET_CAPS = 4;
// and each envelope held costs this much beside its bytes (its record and
// its ArrayBuffer), and at most this many are held (F4-4): many tiny ones
// can't pile up
const HELD_OVERHEAD_BYTES = 512;
const MAX_HELD = 1024;
// What may carry buffers beside its envelope (t): a reply (a hop's result or
// error as bytes, capped by their length where they are read), a hop's
// input (invokeforeignaction, peer-announce: INPUT_TOO_LARGE on their own
// path) and a peer callee's result to meter or bill (peer-metering-request,
// peer-bill-request: the broker caps it). A module worker's message of any
// other kind carrying them is a tampered worker's: ended (its buffers are
// counted only up to the cap in the bytes budget, which bounds no other path)
const CARRIES_BUFFERS = {__proto__: null, 'invokeforeignaction': true, 'peer-announce': true, 'peer-metering-request': true, 'peer-bill-request': true};
const carriesBuffers = (m) => m != null && typeof(m) === 'object' && typeof(m.command) === 'string' && CARRIES_BUFFERS[m.command] === true;
// a line of the main thread's log about this worker (one place, so the token
// path's guard reads one require: test/sandbox/64)
function logLine(wm, text) {
  try { require('./logger').E(new Error(`module worker ${wm.moduleName || wm.hostModuleName || '(loading)'}: ${text}`)); } catch (e) { /* bare process */ }
}

// invoke from main thread
WorkerMessage.prototype.sendLoadModuleMessage = function(message, callback) {
  setOwn(message, 'command', 'load-module');
  this.sendMessageToWorker(message, callback);
};

// invoke from main thread: a discarded load that only runs the validator
// (countinghouse_validate_module; review R1-4).
WorkerMessage.prototype.sendValidateModuleMessage = function(message, callback) {
  setOwn(message, 'command', 'validate-module');
  this.sendMessageToWorker(message, callback);
};

WorkerMessage.prototype.sendUnloadModuleMessage = function(message, callback) {
  setOwn(message, 'command', 'unload-module');
  this.sendMessageToWorker(message, callback);
};

// invoke from main thread
WorkerMessage.prototype.sendSetOptionsMessage = function(message, callback) {
  setOwn(message, 'command', 'set-options');
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
  setOwn(message, 'command', 'set-composition');
  this.sendMessageToWorker(message, callback);
};

// invoke in main thread
WorkerMessage.prototype.sendInvokeActionMessage = function(message, callback, deadline) {
  setOwn(message, 'command', 'invoke-action');
  // a hop's input bytes cross transferred, never cloned (lib/hop-input.js)
  const bytes = hopInputLib().bytesOf(message.args);
  this.sendMessageToWorker(message, callback, bytes != null ? [bytes] : undefined, deadline);
};

// message contains: {msgID: msgID, errMsg: errMsg, spec: spec}
// refusedCode: the main thread's own code for an error answer whose wire form
// carries only its text (the worker sees what it saw before), for the call's
// note alone; never sent
WorkerMessage.prototype.sendDeviceQueryReplyToChild = function(message, refusedCode) {
  if (isMainThread === true && this.queried != null && this.queried.has(message.msgID)) {
    const token = this.queried.get(message.msgID);
    this.queried.delete(message.msgID);
    // (an error answer with its code: that refusal; one without a code says
    // nothing either way; a device found: the call went through. The main
    // thread's own store, required here on the main thread only.)
    const callTokens = require('./call-tokens');
    const code = (message.errCode != null) ? message.errCode : (typeof(refusedCode) === 'string' ? refusedCode : null);
    if (code != null) callTokens.noteRefused(token, code, 'module', this.workerId);
    else if (message.errMsg == null) callTokens.noteThrough(token, this.workerId);
  }
  setOwn(message, 'command', 'query-device-reply');
  this.sendMessageToWorker(message, null);
};

// message contains: {msgID: msgID, errMsg: errMsg}
WorkerMessage.prototype.sendDeviceLogReplyToChild = function(message) {
  setOwn(message, 'command', 'device-log-reply');
  this.sendMessageToWorker(message, null);
};

WorkerMessage.prototype.sendRedisCommandReplyToChild = function(message) {
  setOwn(message, 'command', 'redis-command-reply');
  this.sendMessageToWorker(message, null);
}

WorkerMessage.prototype.sendGetJobInfoReplyToChild = function(message) {
  setOwn(message, 'command', 'get-job-info-reply');
  this.sendMessageToWorker(message, null);
}

// RC1-min, main -> child: {msgID, result} or the error's reply fields
// (CountinghouseError.replyFields), so the code survives the hop.
WorkerMessage.prototype.sendRemoteCallReplyToChild = function(message) {
  setOwn(message, 'command', 'remote-call-reply');
  CountinghouseError.postReply((m) => this.sendMessageToWorker(m, null), message);
};

// message: {msgID, result, errMsg} -- reply to sendUsageQueryToParent,
// decoded in the worker as a remote call's reply is.
WorkerMessage.prototype.sendUsageQueryReplyToChild = function(message) {
  setOwn(message, 'command', 'usage-query-reply');
  CountinghouseError.postReply((m) => this.sendMessageToWorker(m, null), message);
};

// the answer to a worker's ctx.ask (lib/module-ask.js): {msgID, result} or
// a refusal's reply fields
WorkerMessage.prototype.sendAskReplyToChild = function(message) {
  message.command = 'ask-reply';
  CountinghouseError.postReply((m) => this.sendMessageToWorker(m, null), message);
};

// message contains: {msgID: msgID, errMsg: errMsg, meteringResult: meteringResult}
// -- reply to sendPeerMeteringRequestToParent, same shape/pattern as
// sendGetJobInfoReplyToChild above.
// transfer: a peer invoke's checked input bytes, handed back to the callee
// (lean worker step 4)
WorkerMessage.prototype.sendPeerMeteringReplyToChild = function(message, transfer) {
  setOwn(message, 'command', 'peer-metering-reply');
  this.sendMessageToWorker(message, null, transfer);
}

// Lean worker step 4: to a peer invoke's *caller* worker, the main thread's
// answer to it: {channel, invokeId} with the checked result's bytes
// (dataBuffer, transferred) and platformMetering, or its error
// (errorBuffer, the callee's own; or errMsg and errCode, the main thread's
// refusal). The callee no longer answers the caller over the port.
// To a peer invoke's caller: its announcement refused (lean worker step 4:
// a target or input the main thread will not hold), so the invoke fails at
// once rather than at the callee's deadline.
WorkerMessage.prototype.sendPeerAnnounceRefusedToChild = function(message) {
  setOwn(message, 'command', 'peer-announce-refused');
  this.sendMessageToWorker(message, null);
};

WorkerMessage.prototype.sendPeerResultToChild = function(message, transfer) {
  setOwn(message, 'command', 'peer-result');
  this.sendMessageToWorker(message, null, transfer);
};

// --- direct peer channels (docs/direct-peer-channels-design.md), main -> child ---

// D1: told to the *caller* worker A -- either a fresh port (new pair, `port`
// present, transferred) or a bare ack that a previously-granted port for
// this worker pair should now also be used for `targetDeviceID` (no new
// MessageChannel, `port` omitted). See lib/peer-channel-broker.js#grant.
WorkerMessage.prototype.sendPeerChannelGrantToChild = function(message, port) {
  setOwn(message, 'command', 'peer-channel-grant');
  if (this.worker == null) return;
  if (port != null) return this.worker.postMessage(message, [port]);
  return this.worker.postMessage(message);
};

// D3: told to the caller worker A when brokering was denied (unknown
// device, self-target, or the userAuth check failed).
WorkerMessage.prototype.sendPeerChannelDenyToChild = function(message) {
  setOwn(message, 'command', 'peer-channel-deny');
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
  setOwn(message, 'command', 'peer-channel-allow');
  this.sendMessageToWorker(message, callback);
};

WorkerMessage.prototype.sendPeerChannelOpenToChild = function(message, port) {
  setOwn(message, 'command', 'peer-channel-open');
  setOwn(message, 'port', port); // must be on the message itself, not just in the transferList, or the receiving side has nothing to read msg.port from
  if (this.worker != null) this.worker.postMessage(message, [port]);
};

// D4: told to whichever worker did NOT trigger the reload/unload/exit, so
// it can drop its now-stale cached port for the affected workerId.
WorkerMessage.prototype.sendPeerInvalidateToChild = function(message) {
  setOwn(message, 'command', 'peer-invalidate');
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
  setOwn(message, 'command', 'invoke-action-reply');
  // A hop's result as bytes (lean worker step 2): relayed as dataBuffer, its
  // ArrayBuffer transferred, never read here.
  if (message.data instanceof SerializedResult) {
    const buffer = message.data.buffer;
    setOwn(message, 'data', null);
    setOwn(message, 'dataBuffer', buffer);
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

// Whether a request sent to this worker is still under way: one with no
// deadline always is (a load, its options, a job run with no timeout); one
// with a deadline is until marginMs past it. A call whose own timeout has
// fired has been answered already (lib/session.js's timer), and its reply,
// if it ever comes, is dropped; so a handler that never answers doesn't
// keep its worker busy for ever (a per-session worker's pool slot,
// lib/session-workers.js: the security pass of 11-17). The deadline rides
// with the queued callback (requestDeadline, set as it is queued): it leaves
// with the entry, wherever the entry leaves.
WorkerMessage.prototype.inFlight = function(now, marginMs) {
  // (the captured Object.keys and an index loop: this file is on the token
  // path's lexical guard, sandbox 64)
  const ids = ObjectKeysWM(this.msgQueue);
  for (let i = 0; i < ids.length; i++) {
    const d = requestDeadline.get(this.msgQueue[ids[i]]);
    if (!Number.isFinite(d) || now <= d + marginMs) return true;
  }
  return false;
};

// invoke in main thread. Called once the worker has ended (module-manager.js,
// on its 'exit'), whatever ended it: every request still waiting for a reply
// -- calls, jobs, the unload's own acknowledgement -- is answered now with
// the code that says why, instead of never, and so is any request sent from
// here on (posting to an ended worker drops the message silently).
WorkerMessage.prototype.endWith = function(code, name, reason) {
  if (this.ended != null) return;
  // what the worker sent before it ended and was held for its bytes budget
  // (F4-4): its replies are read first, answered as they came, not with the
  // ending's code; its requests are not run. A worker ended for what it sent
  // (the budget's overflow, a violation) has what it held dropped.
  if (this.condemned !== true) this.decodeAllHeld(); else this.dropHeld();
  if (this.progressDropped > 0) {
    logLine(this, `${this.progressDropped} progress messages dropped past --moduleMessageRate`);
    this.progressDropped = 0;
  }
  this.ended = {code: code, name: name, reason: reason};
  if (this.progressFlush != null) clearTimeout(this.progressFlush);
  this.progressFlush = null;
  this.progressPending = null;
  const pending = this.msgQueue;
  this.msgQueue = {__proto__: null};
  this.bytesExpected.clear();
  Object.keys(pending).forEach((id) => {
    if (typeof(pending[id]) === 'function') pending[id](new CountinghouseError(code, name, reason), null);
  });
};

// invoke in main thread, message handler defined in app-sandbox
// transfer: ArrayBuffers in message to move to the worker, not copy: a
// hop's result (lean worker step 2), with no reply, and a hop's input
// (lib/hop-input.js), whose invoke has one.
// deadline: when the request's caller stops waiting (ms), or none
WorkerMessage.prototype.sendMessageToWorker = function(message, callback, transfer, deadline) {
  if (this.ended != null) {
    if (typeof(callback) === 'function') callback(new CountinghouseError(this.ended.code, this.ended.name, this.ended.reason), null);
    return;
  }
  if (this.worker != null) {
    //callback null indicates this message doesn't need reply
    //usually this is a reply to child initiated message
    if (callback == null) return (transfer != null) ? this.worker.postMessage(message, transfer) : this.worker.postMessage(message);

    const id = this.msgID;
    setOwn(message, 'id', id);
    setOwn(this.msgQueue, id, callback);
    if (Number.isFinite(deadline)) requestDeadline.set(callback, deadline);
    else requestDeadline.delete(callback);   // (a callback queued again with none: no earlier deadline read for it)
    this.msgID++;
    if (message.serializedReply === true) this.bytesExpected.add(id);
    // A post that throws (a hop's transferred input bytes, lib/hop-input.js;
    // or a message that can't be cloned) leaves no reply waiting: its caller
    // answers, and the worker's end must never answer it again (the review of
    // #185), nor may it count as under way for ever
    const transferring = Array.isArray(transfer) && transfer.length > 0;
    try {
      return transferring ? this.worker.postMessage(message, transfer) : this.worker.postMessage(message);
    } catch (e) {
      delete this.msgQueue[id];
      this.bytesExpected.delete(id);
      throw e;
    }
  }
};

// a message sending from child to parent has following fields:
// {id:       message id,
//  category: "child" or "reply", indicates child created message or reply message
//  command:  null for reply category, string name of the command for child message
//  errMsg:   null for child created message, contains error information for reply message
//  data:     contains the data sending to parent
// }

// invoke in main thread: what a module's worker posted, read as an envelope
// (lib/message-envelope.js) before anything is decoded. Anything else -- not
// an envelope, malformed, over the cap -- is a tampered worker's: it is ended,
// and the message is handled no further. Node has already decoded a message
// that is not an envelope by the time it arrives: at most one such decode per
// worker, which the worker's heap limit bounds.
WorkerMessage.prototype.onEnvelope = function(raw) {
  const cap = this.messageCap != null ? this.messageCap : envelope.capFor(options.maxOutputBytes);
  // a worker condemned for what it sent: nothing more of it is read
  if (this.condemned === true) return undefined;
  if (this.byteBudgeted !== true && this.messageRate == null) return this.decode(raw, cap);
  // A module worker's bytes, before any decode (F4-4): the rate limit
  // (onWorkerMessage) reads the command, so it runs after the decode. Not an
  // envelope, or over the cap: unwrap says so, and the worker is ended. A
  // carried buffer counts up to the cap (one over it is its own path's to
  // refuse, INPUT_TOO_LARGE), and no one message is charged more than the
  // budget: only sustained excess across messages holds, and then ends.
  const bytes = envelope.bytesOf(raw, cap);
  if (bytes == null || bytes.body > cap) return this.decode(raw, cap);
  const budget = BYTE_BUDGET_CAPS * cap;
  const charge = Math.min(bytes.charge, budget);
  if (this.heldCount() === 0 && this.spendBytes(charge, budget)) return this.decode(raw, cap);
  // held: its record and its buffer cost besides its bytes
  const heldCharge = Math.min(charge + HELD_OVERHEAD_BYTES, budget);
  // past the budget: held as it came, undecoded, in order, and decoded as the
  // budget refills (a reply is late, not lost); past as much again, ended
  if (this.heldCount() > 0 && (this.heldBytes + heldCharge > budget || this.heldCount() >= MAX_HELD)) {
    this.dropHeld();
    return this.endForMessage(`over ${budget} bytes a second of messages, and as much held (or ${MAX_HELD} messages)`);
  }
  this.held[this.held.length] = {raw, bytes: charge, heldBytes: heldCharge};
  this.heldBytes += heldCharge;
  this.heldCap = cap;
  this.decodeHeldLater(cap);
};

WorkerMessage.prototype.decode = function(raw, cap, {repliesOnly = false} = {}) {
  const r = envelope.unwrap(raw, cap);
  if (r.violation != null) return this.endForMessage(r.violation);
  const m = r.message;
  const isReply = m != null && typeof(m) === 'object' && m.category === 'reply';
  if (this.messageRate != null && raw != null && Array.isArray(raw.t) && raw.t.length > 0 && !isReply &&
    !carriesBuffers(m)) {
    return this.endForMessage('a message carrying buffers it may not');
  }
  // a worker that has ended: only its replies are answered (its requests
  // would run for a caller that is gone)
  if (repliesOnly && !isReply) return undefined;
  this.onWorkerMessage(m);
  if (typeof(this.onDecoded) === 'function') this.onDecoded(m);
};

WorkerMessage.prototype.heldCount = function() { return this.held.length - this.heldHead; };

WorkerMessage.prototype.decodeHeldLater = function(cap) {
  if (this.heldTimer != null || this.heldCount() === 0) return;
  const budget = BYTE_BUDGET_CAPS * cap;
  const short = this.held[this.heldHead].bytes - (this.byteTokens != null ? this.byteTokens : 0);
  this.heldTimer = setTimeout(() => {
    this.heldTimer = null;
    // (endWith read what was held; a worker condemned for what it sent has
    // nothing more of it read)
    if (this.condemned === true || this.ended != null) return this.dropHeld();
    try {
      while (this.heldCount() > 0 && this.spendBytes(this.held[this.heldHead].bytes, budget)) {
        const h = this.held[this.heldHead];
        this.held[this.heldHead] = undefined;
        this.heldHead += 1;
        this.heldBytes -= h.heldBytes;
        if (this.heldCount() === 0) { this.held = []; this.heldHead = 0; }
        this.decodeOne(h.raw, cap);
      }
    } finally {
      // whatever one message did, the rest are still read
      this.decodeHeldLater(cap);
    }
  }, Math.max(1, Math.ceil(short * 1000 / budget)));
  if (typeof(this.heldTimer.unref) === 'function') this.heldTimer.unref();
};

// one held message, its throw its own (as a message the 'message' event
// delivered: logged, the rest go on)
WorkerMessage.prototype.decodeOne = function(raw, cap, opts) {
  try {
    this.decode(raw, cap, opts);
  } catch (e) {
    logLine(this, `a held message: ${e != null && e.message != null ? e.message : String(e)}`);
  }
};

// everything held, now, whatever the budget: the worker has ended
WorkerMessage.prototype.decodeAllHeld = function() {
  if (this.heldCount() === 0) return;
  const held = this.held;
  const from = this.heldHead;
  const cap = this.heldCap;
  this.dropHeld();
  for (let i = from; i < held.length && this.condemned !== true; i++) this.decodeOne(held[i].raw, cap, {repliesOnly: true});
};

WorkerMessage.prototype.dropHeld = function() {
  if (this.heldTimer != null) clearTimeout(this.heldTimer);
  this.heldTimer = null;
  this.held = [];
  this.heldHead = 0;
  this.heldBytes = 0;
};

// (a monotonic clock: a wall clock stepped back must not empty the bucket)
WorkerMessage.prototype.spendBytes = function(bytes, budget) {
  const now = performance.now();
  this.byteTokens = Math.min(budget, (this.byteTokens == null ? budget : this.byteTokens) + Math.max(0, now - this.byteRefillAt) * budget / 1000);
  if (now > this.byteRefillAt) this.byteRefillAt = now;
  if (bytes > this.byteTokens) return false;
  this.byteTokens -= bytes;
  return true;
};

// One progress message of the worker's own progress bucket, at the message
// rate; past it dropped, counted, and said at most once a minute (F4-3)
WorkerMessage.prototype.spendProgress = function() {
  if (this.messageRate == null) return true;
  const now = performance.now();
  const rate = this.messageRate;
  this.progressTokens = Math.min(rate, (this.progressTokens == null ? rate : this.progressTokens) + Math.max(0, now - this.progressRefillAt) * rate / 1000);
  if (now > this.progressRefillAt) this.progressRefillAt = now;
  if (this.progressTokens >= 1) {
    this.progressTokens -= 1;
    return true;
  }
  this.progressDropped += 1;
  if (this.progressDroppedLoggedAt == null || now - this.progressDroppedLoggedAt >= 60 * 1000) {
    logLine(this, `${this.progressDropped} progress messages dropped past --moduleMessageRate`);
    this.progressDroppedLoggedAt = now;
    this.progressDropped = 0;
  }
  return false;
};

// One message of the worker's rate (--moduleMessageRate), or false when its
// bucket is empty; true when the worker has no rate (not a module's)
// (a monotonic clock, as the bytes': a wall clock stepped back must not
// empty the bucket)
WorkerMessage.prototype.spendMessage = function() {
  if (this.messageRate == null) return true;
  const now = performance.now();
  this.rateTokens = Math.min(this.messageRate, this.rateTokens + Math.max(0, now - this.rateRefillAt) * this.messageRate / 1000);
  // (a refillAt ahead of now holds the refill until then, as a test sets it)
  if (now > this.rateRefillAt) this.rateRefillAt = now;
  if (this.rateTokens < 1) return false;
  this.rateTokens -= 1;
  return true;
};

WorkerMessage.prototype.endForMessage = function(why) {
  if (this.killReason == null) this.killReason = `message bound: ${why}`;
  // condemned for what it sent: nothing more of it is read (a worker ended
  // for anything else, its watchdog's or its load's timeout, still has what
  // it already sent read: a reply that came is answered)
  this.condemned = true;
  try { require('./logger').E(new Error(`module worker ${this.moduleName || this.hostModuleName || '(loading)'}: ${why}; worker ended`)); } catch (e) { /* bare process */ }
  if (this.worker != null) this.worker.terminate().catch(() => {});
};

// invoke in main thread
WorkerMessage.prototype.onWorkerMessage = function(msg) {
  // module code can send anything, null included
  if (msg == null || typeof(msg) !== 'object') return;
  const id = msg.id;

  if (id == null) return;

  // jobprogress originates in the worker and has no callback of the
  // parent's. (A worker announced its device as 'deviceonline' until lean
  // worker step 3: the main thread registers it from its own spec now, and
  // such a message is discarded below.)
  // (F4-3)
  // A task's progress always reaches its handler, which keeps each run's
  // latest and writes it at most every 250 ms: the writes are bounded there,
  // and the last value (100) always survives. A call's own progress (each a
  // client notification) spends a bucket of its own, never the requests'.
  if (id === 'jobprogress') return this.emit(id, msg, this);
  if (id === 'callprogress') {
    if (!this.spendProgress()) return undefined;
    return this.emit(id, msg, this);
  }

  if (msg.category === 'reply') {
    if (this.msgQueue[id] != null) {
      const callback = this.msgQueue[id];
      if (callback == null || typeof(callback) !== 'function') return;
      // taken off the queue before it runs: a callback that throws leaves
      // nothing for the worker's end to answer a second time
      delete this.msgQueue[id];

      // A hop's result crosses as bytes (lean worker step 2), held here and
      // never read; only a request that asked for bytes gets them, and it
      // gets nothing else: a plain value there would skip the length cap,
      // and bytes anywhere else would reach a client unread.
      // A failed call's error crosses as bytes too (the review of #165), so a
      // plain error, a huge fault or message, is refused where bytes were
      // asked for.
      const expectsBytes = this.bytesExpected.delete(id);
      if (expectsBytes) {
        if (msg.dataBuffer instanceof ArrayBuffer) callback(null, new SerializedResult(msg.dataBuffer));
        else if (msg.errorBuffer instanceof ArrayBuffer) callback(null, new SerializedResult(msg.errorBuffer, {error: true}));
        else callback(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a module\'s result did not cross as bytes'), null);
      } else if (msg.errMsg != null) {
        callback(CountinghouseError.fromReplyFields(msg), msg.data);
      } else if (msg.dataBuffer != null || msg.errorBuffer != null) {
        callback(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a reply carried bytes it was not asked for'), null);
      } else {
        callback(null, msg.data);
      }
    }
  } else if (msg.category === 'child') {
    const billOfAMatch = msg.command === 'peer-bill-request' && this.unbilledTokens instanceof Set && msg.data != null &&
      typeof(msg.data.token) === 'string' && this.unbilledTokens.has(msg.data.token);
    if (this.messageRate != null && !RATE_EXEMPT.has(msg.command) && !billOfAMatch && !this.spendMessage()) {
      if (this.worker == null) return;
      if (RATE_QUIET.has(msg.command)) return require('./worker-output').onRateDropped(this, msg.command, msg.data);
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
          invokeId: (msg.data != null) ? msg.data.invokeId : null, epoch: (msg.data != null && typeof(msg.data.epoch) === 'string') ? msg.data.epoch.slice(0, 256) : null,
          errMsg: 'too many messages to the main thread (--moduleMessageRate)', errCode: 'RATE_LIMITED'});
      }
      this.worker.postMessage({command: 'rate-limited-reply', msgID: id});
      return;
    }

    if (msg.command == null) return;

    switch(msg.command) {
      case 'querydevice': {
        // a bare deviceID, or {deviceID, token} (R2-1 Task 3): the call's
        // token; nothing the worker states about an identity is read (Task 5)
        const data = msg.data;
        const claim = (data != null && typeof(data) === 'object') ? data : {deviceID: data};
        if (typeof(claim.token) === 'string') {
          if (this.queried == null) this.queried = new Map();
          if (this.queried.size >= 1024) this.queried.delete(this.queried.keys().next().value);
          this.queried.set(id, claim.token);
        }
        this.emit('querydevice', {deviceID: claim.deviceID, token: claim.token, id: id}, this);
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
      // the worker's own log, and its module's output, under their budgets
      case 'log': {
        require('./worker-output').onLog(this, msg.data);
        break;
      }
      case 'stdout':
      case 'stderr': {
        require('./worker-output').onOutput(this, msg.command, msg.data);
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
      // ctx.usage(): the parent's listener (lib/module-manager.js) answers
      // with this worker's call's counts.
      case 'usage-query': {
        this.emit('usage-query', {data: msg.data, id: id}, this);
        break;
      }
      // ctx.ask(): the parent's listener (lib/module-manager.js) answers
      // from the call's ask state, found by this worker's token.
      case 'ask': {
        this.emit('ask', {data: msg.data, id: id}, this);
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

// invoke in child thread only
WorkerMessage.prototype.sendJobProgressMessageToParent = function(msg) {
  return this.sendMessageToParent('jobprogress', null, msg);
};

// a call's own progress (M21), from the worker; no reply
WorkerMessage.prototype.sendCallProgressMessageToParent = function(msg) {
  return this.sendMessageToParent('callprogress', null, msg);
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
  return post({command: null, id: id, category: 'reply', errMsg: null, data: null, dataBuffer: buffer});
};

// invoke in child thread only: a failed call's error and payload as bytes,
// {fields, data} serialized (lean worker step 2, the review of #165), so the
// main thread caps them by their length as it caps a result.
WorkerMessage.prototype.sendSerializedErrorToParent = function(id, buffer) {
  return post({command: null, id: id, category: 'reply', errMsg: null, data: null, errorBuffer: buffer});
};

WorkerMessage.prototype.sendMessageToParent = function(id, err, data) {
  //reply category indicates a child reply message
  const reply = {command: null, id: id, category: 'reply'};
  const fields = CountinghouseError.replyFields(err);
  const keys = ObjectKeysWM(fields);
  for (let i = 0; i < keys.length; i++) setOwn(reply, keys[i], fields[keys[i]]);
  setOwn(reply, 'data', data);
  return CountinghouseError.postReply((m) => post(m), reply);
};

// below calls are invoked from child worker threads only, and expect callbacks to child worker threads
// claim (R2-1 Task 3): {token}, the call's token; the main thread resolves
// the identity it authorizes as (the module's binding, never a name the
// worker states) and answers a missing device with its reason to an
// identity granted the device. Without it, the bare deviceID as before.
WorkerMessage.prototype.sendDeviceQueryMessageToParent = function(deviceID, callback, claim) {
  const message = {};
  setOwn(message, 'command', 'querydevice');
  setOwn(message, 'data', (claim != null && claim.token != null) ? {deviceID: deviceID, token: claim.token} : deviceID);

  return this.sendActiveMessageToParent(message, callback);
};

// invoke in child thread only
WorkerMessage.prototype.sendDeviceLogMessageToParent = function(deviceID, data, timestamp, callback) {
  const message = {};
  setOwn(message, 'command', 'devicelog');
  setOwn(message, 'data', {deviceID: deviceID, data: data, timestamp: timestamp});

  return this.sendActiveMessageToParent(message, callback);
};

// invoke in child thread only
WorkerMessage.prototype.sendGetJobInfoMessageToParent = function(jobID, callback) {
  const message = {};
  setOwn(message, 'command', 'getjobinfo');
  setOwn(message, 'data', {jobID: jobID});

  return this.sendActiveMessageToParent(message, callback);
}

// invoke in child thread only
WorkerMessage.prototype.sendRedisCommandToParent = function(commandData, callback) {
  const message = {};
  setOwn(message, 'command', 'rediscommand');
  setOwn(message, 'data', commandData);  // command data contains op and data field
  return this.sendActiveMessageToParent(message, callback);
};

// invoke in child thread only
// A hop names no identity and no billing key (R2-1 Task 5): the main thread
// authorizes it as the module's binding and bills the outer caller, both by
// the call's token (docs/composite-tools.md). Nothing is added to a reply's
// `data`, which must stay exactly the callee's own output.
WorkerMessage.prototype.sendActionInvokeMessageToParent = function(deviceID, serviceID, actionName, args, callback) {
  const message = {};
  setOwn(message, 'command', 'invokeforeignaction'); // invoke goes to another thread
  // token (R2-1 Task 3): the call's token, by which the main thread bills
  // and authorizes the hop; the hop names no identity and no billing key
  // (R2-1 Task 5). The input as bytes, transferred (lib/hop-input.js): the
  // main thread never deserialises or clones it.
  const encoded = hopInputLib().encode(args);
  setOwn(message, 'data', {deviceID: deviceID, serviceID: serviceID, actionName: actionName, args: encoded.args,
    token: (args != null && typeof(args.token) === 'string') ? args.token : undefined});

  return this.sendActiveMessageToParent(message, callback, encoded.transfer);
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
  post({id: id, category: 'child', command: 'peer-channel-request', errMsg: null, data: data});
};

// R2-1 Task 3 (spec 10b): the caller worker announces each peer invoke to
// the main thread, {channel, invokeId, token}, so the callee's metering
// request for it can be matched to the call's token. Fire-and-forget, like
// peer-channel-request.
// transfer: the invoke's input bytes (lean worker step 4)
WorkerMessage.prototype.sendPeerAnnounceToParent = function(data, transfer) {
  const id = this.msgID;
  this.msgID++;
  post({id: id, category: 'child', command: 'peer-announce', errMsg: null, data: data}, transfer);
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
// transfer: the invoke's input bytes (lean worker step 4)
WorkerMessage.prototype.sendPeerMeteringRequestToParent = function(data, callback, transfer) {
  const message = {};
  setOwn(message, 'command', 'peer-metering-request');
  setOwn(message, 'data', data);
  return this.sendActiveMessageToParent(message, callback, transfer);
};

// R2-1 Task 3: after a peer invoke's handler succeeded, {token}, the token
// the metering reply carried; the main thread bills the hop by it, once,
// and answers with the metering result (the same reply as above).
// transfer: the handler's result or error as bytes (lean worker step 4)
WorkerMessage.prototype.sendPeerBillRequestToParent = function(data, callback, transfer) {
  const message = {};
  setOwn(message, 'command', 'peer-bill-request');
  setOwn(message, 'data', data);
  return this.sendActiveMessageToParent(message, callback, transfer);
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
  post({id: id, category: 'child', command: 'peer-self-invalidate', errMsg: null, data: null});
};

// RC1-min, child -> main: {remote, tool, args, usageCall, token}, billed by
// the call's token (R2-1 Task 5); the reply is remote-call-reply, correlated
// by msgQueue like get-job-info-reply.
WorkerMessage.prototype.sendRemoteCallToParent = function(data, callback) {
  return this.sendActiveMessageToParent({command: 'remote-call', data: data}, callback);
};

// invoke in child thread only: ctx.usage(), data {usageCall, token}.
WorkerMessage.prototype.sendUsageQueryToParent = function(data, callback) {
  return this.sendActiveMessageToParent({command: 'usage-query', data: data}, callback);
};

// invoke in child thread only: ctx.ask(), data {token, name, values}.
WorkerMessage.prototype.sendAskToParent = function(data, callback) {
  return this.sendActiveMessageToParent({command: 'ask', data: data}, callback);
};

// (by definition: a worker's logger adds one on its first line, after module
// code may have replaced Array.prototype.push)
WorkerMessage.addBeforeReply = function(fn) { setOwn(beforeReply, beforeReply.length, fn); };

// What a fire-and-forget send says: true sent, 'too-large' refused by the
// envelope as over the cap (its sender can send less), false otherwise.
function quietPost(message) {
  try {
    post(message);
    return true;
  } catch (e) {
    return (e != null && e.code === 'MESSAGE_TOO_LARGE') ? 'too-large' : false;
  }
}

// invoke in child thread only: one of the worker's own log records
// (lib/worker-logger.js). Never throws (see quietPost); a record that was
// not sent is counted by its sender, never logged about here (that would
// recurse).
WorkerMessage.sendLog = function(record) {
  return quietPost({id: 'log', category: 'child', command: 'log', errMsg: null, data: record});
};

// invoke in child thread only: a module's output, {lines} or {dropped}
// (lib/worker-stdio.js), on stream 'stdout' or 'stderr'. As sendLog.
WorkerMessage.sendOutput = function(stream, data) {
  return quietPost({id: stream, category: 'child', command: stream, errMsg: null, data: data});
};

// invoke in child thread only: a module sandbox violation (lib/module-
// lockdown.js), already de-duplicated there. No reply.
// The target is the module's (a path, a host): cut to a length that always
// fits the envelope, so a violation is never lost to its own size.
const VIOLATION_TARGET_MAX = 4096;
// (the lockdown's reports: cut with String's slice as taken when this file
// loaded, so a module that replaced it can't change what is reported)
const StringSliceOf = Function.prototype.call.bind(String.prototype.slice);
const StringOf = String;
WorkerMessage.prototype.sendSandboxViolationToParent = function(rule, target) {
  const id = this.msgID;
  this.msgID++;
  const t = StringOf(target);
  const shown = t.length > VIOLATION_TARGET_MAX ? `${StringSliceOf(t, 0, VIOLATION_TARGET_MAX)}... (${t.length} characters)` : t;
  post({id: id, category: 'child', command: 'sandbox-violation', errMsg: null,
                          data: {rule: StringSliceOf(StringOf(rule), 0, 256), target: shown}});
};

// invoke in child thread only, send a child created message and expect reply from parent
WorkerMessage.prototype.sendActiveMessageToParent = function(message, callback, transfer) {
  const id = this.msgID;
  setOwn(message, 'id', id);
  setOwn(message, 'category', 'child');    // child category indicates a child created message
  setOwn(message, 'errMsg', null);

  setOwn(this.msgQueue, id, callback);
  this.msgID++;

  // over the cap: the caller's callback answers it, and nothing is posted;
  // anything else (a value structured clone cannot carry) throws, as it did.
  // A hop's input bytes (transfer) cross beside the envelope (#185).
  try {
    post(message, transfer);
  } catch (e) {
    delete this.msgQueue[id];
    if (e == null || e.code !== 'MESSAGE_TOO_LARGE' || typeof(callback) !== 'function') throw e;
    process.nextTick(callback, e);
  }
};

module.exports = WorkerMessage;
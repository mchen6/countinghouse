'use strict';
// PeerChannel wraps one end of a worker_threads.MessageChannel port pair
// connecting two worker threads directly (see docs/direct-peer-channels.md
// for the full design). It is transport-only: request/response correlation,
// per-call timeout, and close/invalidation handling. It knows nothing about
// device invocation, authorization, or metering -- those are wired in by
// the caller (lib/lean-worker.js on the worker side) via the `onInvoke` option.
//
// Symmetric by construction (either end can call `invoke()`), but this
// round only uses it directionally -- the side that originally requested
// the channel (the "caller") calls invoke(); the side that was granted it
// unsolicited (the "callee") only ever handles incoming peer-invoke via
// onInvoke. See lib/peer-channel-broker.js for why the reverse direction
// isn't wired up yet.
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const hopInput = require('./hop-input');
let epochs = 0;
// A refusal on the port is the callee's own words: its fields are bounded.
const PORT_ERROR_MESSAGE_MAX = 1000;
const PORT_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
// Loaded at a worker's boot, before module code (lib/lean-worker.js), as
// port-scope is: what this file calls is taken now. Its queues and maps hold
// a call's token and callbacks, so they are written by index or as own
// properties, and walked by index, never through a method or setter module
// code could have replaced.
const {onPortMessage, onPortEvent, postOnPort, closePort, withFields, put, takeFirst, setOwn, rehome, rehomeMessage} = require('./port-scope');
const uncurry = (fn) => Function.prototype.call.bind(fn);
const SetAdd = uncurry(Set.prototype.add);
const SetDelete = uncurry(Set.prototype.delete);
const SetClear = uncurry(Set.prototype.clear);
const SetHas = uncurry(Set.prototype.has);
const RegExpTest = uncurry(RegExp.prototype.test);
const StringSlice = uncurry(String.prototype.slice);
const StringCtor = String;
const MathMax = Math.max;
const DateNow = Date.now;
const FunctionBind = uncurry(Function.prototype.bind);
const NumberToString = uncurry(Number.prototype.toString);
const SetCtor = Set;
const ObjectKeys = Object.keys;
// a list without the entries whose id is id, by index
const without = (list, id) => {
  const out = [];
  for (let i = 0; i < list.length; i++) if (list[i].id !== id) put(out, list[i]);
  return out;
};

function PeerChannel(port, given) {
  // (each field defined as the channel's own, never assigned: an assignment
  // runs a setter module code put on Object.prototype, with the channel, its
  // port and its pending calls as `this`; and the options re-homed, so one a
  // role leaves out reads as undefined, never through a getter there)
  const opts = rehome(given != null ? given : {});

  setOwn(this, 'port', port);
  setOwn(this, 'workerId', opts.workerId);     // the *other* side's worker id
  setOwn(this, 'onInvoke', opts.onInvoke);     // function(msg, replyCallback) -- callee role
  setOwn(this, 'onClose', opts.onClose);       // function() -- fired once, on invalidation or port 'close'
  // callee role: the devices granted on this channel (a Map, set by
  // lib/peer-worker.js); declared here so a caller's channel has it as its own too
  setOwn(this, 'allowedDevices', null);
  setOwn(this, 'callerModule', opts.callerModule); // apiKey this channel was authorized under (see D3/D5)
  // caller role (R2-1 Task 3, spec 10b): function(invokeId, token), the
  // announcement of one invoke to the main thread, which matches the
  // callee's metering request to the call's token by it
  setOwn(this, 'announce', opts.announce);
  // caller role: a result the callee posts on the port is not accepted (lean
  // worker step 4): it comes from the main thread, checked (deliver). A
  // callee's error reply still ends the invoke; a data reply is reported here.
  setOwn(this, 'onForgedReply', opts.onForgedReply);
  setOwn(this, 'forgedReported', false);
  // caller role: this grant of the channel. The main thread's answers name
  // it, so one for an earlier grant (whose ids restart at 0) is never taken
  // for this one's (the review of #202).
  setOwn(this, 'epoch', `${NumberToString(DateNow(), 36)}.${NumberToString(++epochs, 36)}`);

  // Backpressure (docs/direct-peer-channels.md's benchmark finding: with
  // no cap, direct peer channels lost to the main-thread-routed path at
  // large payloads under high concurrency, because that path's own
  // main-thread bottleneck incidentally throttled how much work could
  // pile up; nothing throttled the direct path). Applies symmetrically to
  // whichever role a given instance plays -- capping only the callee's
  // dispatch (onInvoke) turned out not to be enough on its own:
  // postMessage's structured-clone cost for a large payload is paid at
  // *send* time, so an uncapped caller still pays (and blocks its own
  // event loop on) that cost for every concurrent invoke() call before a
  // callee-side cap ever gets a chance to matter. So this caps and queues
  // both directions: outgoing invoke() calls on the caller side, and
  // incoming peer-invoke dispatch on the callee side. Each role uses its
  // own counter/queue pair below; a given instance only ever exercises
  // one pair in practice (see header comment), but they're kept
  // independent rather than shared in case that direction changes later.
  // null/undefined means uncapped (the pre-fix behavior).
  setOwn(this, 'maxConcurrentInvokes', opts.maxConcurrentInvokes);

  setOwn(this, 'activeSends', 0);
  setOwn(this, 'sendQueue', []); // caller role: {request, resolve} waiting to be postMessage'd
  // caller role: the ids sent and not yet finally answered (a refusal on the
  // port, or the main thread's delivery), whether or not their caller has
  // timed out: each holds one of maxConcurrentInvokes until then
  setOwn(this, 'inFlight', new SetCtor());

  setOwn(this, 'activeDispatches', 0);
  setOwn(this, 'dispatchQueue', []); // callee role: incoming peer-invoke messages waiting for onInvoke

  setOwn(this, 'msgID', 0);
  setOwn(this, 'pending', {__proto__: null}); // msgID -> {callback, timer}
  setOwn(this, 'closed', false);

  // in a scope of its own: a module handler it dispatches never finds the
  // port as executionAsyncResource() (lib/port-scope.js)
  onPortMessage(this.port, FunctionBind(onMessageOf, this));
  // Double-insurance invalidation (D4): the main thread broadcasts
  // peer-invalidate on reload/unload/exit, but a worker crash can also
  // close this port directly without that broadcast arriving first (or at
  // all, if the crash is on this channel's own remote end). Both paths
  // must converge on the same cleanup, so `invalidate()` below is
  // idempotent and this listener just calls it.
  // its calls in flight fail from here: their callbacks in a scope of their own too
  onPortEvent(this.port, 'close', FunctionBind(invalidateOf, this));
}

// timeoutMs: per D2, every pending call gets its own timer -- there is no
// main-thread fallback on this path, so a hung callee (or a port that goes
// silently stale without ever firing 'close') must be caught locally. The
// timer starts here, at invoke() time, not when the message actually goes
// out over the wire -- from the caller's perspective it's waiting from the
// moment it asked, queueing delay (backpressure, above) included.
PeerChannel.prototype.invoke = function(deviceID, serviceID, actionName, input, timeoutMs, callback, token) {
  if (this.closed) return callback(new CountinghouseError('PEER_GONE'));
  // the input as bytes (lean worker step 4, as a routed hop's since #185),
  // announced to the main thread, which checks them in a validator. A value
  // structured clone cannot carry throws here, before anything is registered.
  const inputBytes = hopInput.encode({input: input}).args.inputBytes;

  const _this = this;
  const id = this.msgID++;

  const timer = setTimeout(() => {
    delete _this.pending[id];
    // if this request was still queued (never sent), drop it so a stale
    // entry doesn't get sent after the caller already gave up on it.
    _this.sendQueue = without(_this.sendQueue, id);
    // a sent one frees its slot now too: an answer that never comes (a bill
    // the main thread could not match) must not hold it for good
    _this._release(id);
    return callback(new CountinghouseError('PEER_CHANNEL_TIMEOUT'));
  }, timeoutMs);

  setOwn(this.pending, id, {callback: callback, timer: timer});

  // Who pays is per call, not per port (D1 keys a port by *worker pair*, so
  // one port carries calls made on behalf of many outer callers): the
  // call's token (R2-1 Task 3) goes to the main thread in the announcement,
  // never over the port, and the callee is not told it; no key crosses the
  // port at all (R2-1 Task 5).
  // Lean worker step 4 (the review of #202): the target and the input bytes
  // are the CALLER's statement, announced to the main thread, which holds
  // them; the callee learns them only from the main thread, with its match,
  // so it can restate neither. The port carries the invoke's id alone.
  // Announced when the request is sent, not while it waits in the
  // backpressure queue (round 3), with the time its timer has left, so the
  // main thread's deadline is never later than the caller's.
  const request = {id: id, token: token, inputBytes: inputBytes, endsAt: DateNow() + timeoutMs,
    target: {deviceID: deviceID, serviceID: serviceID, actionName: actionName, epoch: this.epoch}};

  if (this.maxConcurrentInvokes != null && this.activeSends >= this.maxConcurrentInvokes) {
    put(this.sendQueue, request);
    return;
  }

  this._sendInvoke(request);
};

PeerChannel.prototype._sendInvoke = function(request) {
  this.activeSends++;
  SetAdd(this.inFlight, request.id);
  if (typeof(this.announce) === 'function') {
    this.announce(request.id, request.token, request.target, request.inputBytes, MathMax(0, request.endsAt - DateNow()));
  }
  request.inputBytes = null;
  postOnPort(this.port, {id: request.id, command: 'peer-invoke'});
};

// Called after a reply for a sent request comes back (see _handleReply) --
// picks up the next queued outgoing invoke, if capacity now allows it.
PeerChannel.prototype._drainSendQueue = function() {
  if (this.sendQueue.length === 0) return;
  if (this.maxConcurrentInvokes != null && this.activeSends >= this.maxConcurrentInvokes) return;

  const next = takeFirst(this.sendQueue);
  this._sendInvoke(next);
};

PeerChannel.prototype._onMessage = function(arrived) {
  // re-homed before anything reads it (lib/port-scope.js rehomeMessage)
  const msg = rehomeMessage(arrived);
  if (msg == null) return;

  if (msg.command === 'peer-invoke') return this._handleInvoke(msg);
  if (msg.category === 'peer-reply') return this._handleReply(msg);
  // unrecognized message on this port -- ignore rather than throw, matching
  // WorkerMessage.prototype.onWorkerMessage's own "or else discard" policy.
};

PeerChannel.prototype._handleInvoke = function(msg) {
  if (typeof(this.onInvoke) !== 'function') {
    const noHandlerErr = new CountinghouseError('PEER_NO_HANDLER');
    return postOnPort(this.port, {id: msg.id, category: 'peer-reply', errMsg: noHandlerErr.message, errCode: noHandlerErr.code, data: null});
  }

  // Backpressure: at capacity, queue instead of dispatching immediately --
  // see the constructor's comment on maxConcurrentInvokes.
  if (this.maxConcurrentInvokes != null && this.activeDispatches >= this.maxConcurrentInvokes) {
    put(this.dispatchQueue, msg);
    return;
  }

  this._dispatchInvoke(msg);
};

// reply(err): the callee's own refusal, posted on the port. reply() with no
// error: the invoke was served, and the main thread answers the caller with
// the checked result (lean worker step 4); nothing goes on the port. Either
// frees the slot, once.
PeerChannel.prototype._dispatchInvoke = function(msg) {
  const _this = this;
  this.activeDispatches++;
  let done = false;
  this.onInvoke(msg, (err) => {
    if (done) return;
    done = true;
    _this.activeDispatches--;
    if (err != null) {
      // a refusal crosses whole (CountinghouseError.replyFields), with no data
      const reply = withFields(withFields({id: msg.id, category: 'peer-reply'}, CountinghouseError.replyFields(err)), {data: null});
      CountinghouseError.postReply((m) => postOnPort(_this.port, m), reply);
    }
    _this._drainDispatchQueue();
  });
};

// Called after every completed dispatch (success or failure) -- picks up
// the next queued incoming request, if capacity now allows it.
PeerChannel.prototype._drainDispatchQueue = function() {
  if (this.dispatchQueue.length === 0) return;
  if (this.maxConcurrentInvokes != null && this.activeDispatches >= this.maxConcurrentInvokes) return;

  const next = takeFirst(this.dispatchQueue);
  this._dispatchInvoke(next);
};

// A reply on the port: the callee refusing the invoke (an error, no data).
// A result is never taken from the port: it comes from the main thread,
// checked (deliver). A data reply is a callee posting around the check:
// reported, dropped, and the invoke goes on waiting for the main thread.
PeerChannel.prototype._handleReply = function(msg) {
  if (msg.errMsg == null) {
    // said once per channel: a callee cannot flood the log with them
    if (this.pending[msg.id] != null && !this.forgedReported && typeof(this.onForgedReply) === 'function') {
      this.forgedReported = true;
      this.onForgedReply(msg.id);
    }
    return;
  }
  const fields = {errMsg: StringSlice(StringCtor(msg.errMsg), 0, PORT_ERROR_MESSAGE_MAX),
    errCode: (typeof(msg.errCode) === 'string' && RegExpTest(PORT_ERROR_CODE, msg.errCode)) ? msg.errCode : 'DEVICE_INVOKE_EXCEPTION',
    // (the runtime's own reason, beside the fields, never in its data: lib/countinghouse-error.js runtimeReason)
    errRuntimeReason: msg.errRuntimeReason === true};
  let err;
  try { err = CountinghouseError.fromReplyFields(fields); } catch (e) { err = new CountinghouseError('DEVICE_INVOKE_EXCEPTION'); }
  return this._settle(msg.id, err, null);
};

// The main thread's answer to an invoke this side announced (lean worker
// step 4): the checked result, or why it was refused.
PeerChannel.prototype.deliver = function(id, err, data, platformMetering) {
  return this._settle(id, err, data, platformMetering);
};

// An invoke's final answer: frees its slot (even when its caller has timed
// out, as the old reply did), then answers the caller still waiting, once.
PeerChannel.prototype._release = function(id) {
  if (SetDelete(this.inFlight, id)) {
    this.activeSends--;
    this._drainSendQueue();
  }
};

PeerChannel.prototype._settle = function(id, err, data, platformMetering) {
  this._release(id);
  const entry = this.pending[id];
  if (entry == null) return;   // timed out already, or not this side's
  delete this.pending[id];
  clearTimeout(entry.timer);
  if (err != null) return entry.callback(err, data);
  return entry.callback(null, data, platformMetering);
};

// Fails one pending invoke now, with `err`: its announcement was refused
// by the main thread (the review of #138, 6). A request still queued is
// dropped from the queue; one already sent frees its slot.
PeerChannel.prototype.fail = function(id, err) {
  const entry = this.pending[id];
  if (entry == null) return;
  delete this.pending[id];
  clearTimeout(entry.timer);
  this.sendQueue = without(this.sendQueue, id);
  // a sent invoke failed here (its announcement refused) frees its slot
  this._release(id);
  return entry.callback(err);
};

// D4: fail every pending call immediately (not waiting for its own
// timeout) with PEER_GONE, then mark this channel dead. Idempotent --
// safe to call from both the explicit peer-invalidate handler and the
// port's own 'close' event, whichever fires first.
PeerChannel.prototype.invalidate = function() {
  if (this.closed) return;
  this.closed = true;

  const pending = this.pending;
  this.pending = {__proto__: null};
  const ids = ObjectKeys(pending);
  for (let i = 0; i < ids.length; i++) {
    const entry = pending[ids[i]];
    clearTimeout(entry.timer);
    entry.callback(new CountinghouseError('PEER_GONE'));
  }
  SetClear(this.inFlight);

  // Anything still queued on either side (backpressure, above) is simply
  // dropped, not replied to/sent -- the port is closing, so there's no one
  // to send to or reply to; queued outgoing requests already had their
  // pending[] entry failed with PEER_GONE just above, and queued incoming
  // ones have no reply path left once the port itself is gone.
  this.sendQueue     = [];
  this.dispatchQueue = [];

  try { closePort(this.port); } catch (e) { /* already closed */ }

  if (typeof(this.onClose) === 'function') this.onClose();
};

// Callee side: finish a served hop once its metering request has answered.
// Metering errors fail open (redis being down must not take peer calls with
// it), except the main thread's own refusals: RATE_LIMITED (the request
// refused outright, --moduleMessageRate), PEER_CHANNEL_TIMEOUT (the bill
// came after the caller's timeout) and CALL_TOKEN_INVALID (the bill matched
// no invoke): nothing will bill this hop, and its result is not delivered
// (the review of #141, N1), as for any hop nobody can be billed for.
const NOT_SERVED = new Set(['RATE_LIMITED', 'PEER_CHANNEL_TIMEOUT', 'CALL_TOKEN_INVALID']);
PeerChannel.finishMeteredHop = function(meteringErr, data, meteringResult, reply) {
  if (meteringErr != null && SetHas(NOT_SERVED, meteringErr.code)) return reply(meteringErr, null, null);
  return reply(null, data, meteringResult);
};

// what each channel's own listeners are bound from (above), taken as this
// file loads
const onMessageOf = PeerChannel.prototype._onMessage;
const invalidateOf = PeerChannel.prototype.invalidate;

module.exports = PeerChannel;

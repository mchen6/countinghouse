// PeerChannel wraps one end of a worker_threads.MessageChannel port pair
// connecting two worker threads directly (see docs/direct-peer-channels.md
// for the full design). It is transport-only: request/response correlation,
// per-call timeout, and close/invalidation handling. It knows nothing about
// device invocation, authorization, or metering -- those are wired in by
// the caller (lib/sandbox.js on the worker side) via the `onInvoke` option.
//
// Symmetric by construction (either end can call `invoke()`), but this
// round only uses it directionally -- the side that originally requested
// the channel (the "caller") calls invoke(); the side that was granted it
// unsolicited (the "callee") only ever handles incoming peer-invoke via
// onInvoke. See lib/peer-channel-broker.js for why the reverse direction
// isn't wired up yet.
var DeviceError = require('./countinghouse-error').DeviceError;

function PeerChannel(port, opts) {
  opts = opts || {};

  this.port        = port;
  this.workerId    = opts.workerId;     // the *other* side's worker id
  this.onInvoke     = opts.onInvoke;     // function(msg, replyCallback) -- callee role
  this.onClose      = opts.onClose;      // function() -- fired once, on invalidation or port 'close'
  this.callerModule = opts.callerModule; // apiKey this channel was authorized under (see D3/D5)

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
  this.maxConcurrentInvokes = opts.maxConcurrentInvokes;

  this.activeSends = 0;
  this.sendQueue    = []; // caller role: {request, resolve} waiting to be postMessage'd

  this.activeDispatches = 0;
  this.dispatchQueue     = []; // callee role: incoming peer-invoke messages waiting for onInvoke

  this.msgID   = 0;
  this.pending = {}; // msgID -> {callback, timer}
  this.closed  = false;

  this.port.on('message', this._onMessage.bind(this));
  // Double-insurance invalidation (D4): the main thread broadcasts
  // peer-invalidate on reload/unload/exit, but a worker crash can also
  // close this port directly without that broadcast arriving first (or at
  // all, if the crash is on this channel's own remote end). Both paths
  // must converge on the same cleanup, so `invalidate()` below is
  // idempotent and this listener just calls it.
  this.port.on('close', this.invalidate.bind(this));
}

// timeoutMs: per D2, every pending call gets its own timer -- there is no
// main-thread fallback on this path, so a hung callee (or a port that goes
// silently stale without ever firing 'close') must be caught locally. The
// timer starts here, at invoke() time, not when the message actually goes
// out over the wire -- from the caller's perspective it's waiting from the
// moment it asked, queueing delay (backpressure, above) included.
PeerChannel.prototype.invoke = function(deviceID, serviceID, actionName, input, timeoutMs, callback) {
  if (this.closed) return callback(new DeviceError('PEER_GONE'));

  var _this = this;
  var id = this.msgID++;

  var timer = setTimeout(function() {
    delete _this.pending[id];
    // if this request was still queued (never sent), drop it so a stale
    // entry doesn't get sent after the caller already gave up on it.
    _this.sendQueue = _this.sendQueue.filter(function(item) { return item.id !== id; });
    return callback(new DeviceError('PEER_CHANNEL_TIMEOUT'));
  }, timeoutMs);

  this.pending[id] = {callback: callback, timer: timer};

  var request = {id: id, deviceID: deviceID, serviceID: serviceID, actionName: actionName, input: input};

  if (this.maxConcurrentInvokes != null && this.activeSends >= this.maxConcurrentInvokes) {
    this.sendQueue.push(request);
    return;
  }

  this._sendInvoke(request);
};

PeerChannel.prototype._sendInvoke = function(request) {
  this.activeSends++;
  this.port.postMessage({
    id: request.id,
    command: 'peer-invoke',
    deviceID: request.deviceID,
    serviceID: request.serviceID,
    actionName: request.actionName,
    input: request.input
  });
};

// Called after a reply for a sent request comes back (see _handleReply) --
// picks up the next queued outgoing invoke, if capacity now allows it.
PeerChannel.prototype._drainSendQueue = function() {
  if (this.sendQueue.length === 0) return;
  if (this.maxConcurrentInvokes != null && this.activeSends >= this.maxConcurrentInvokes) return;

  var next = this.sendQueue.shift();
  this._sendInvoke(next);
};

PeerChannel.prototype._onMessage = function(msg) {
  if (msg == null) return;

  if (msg.command === 'peer-invoke') return this._handleInvoke(msg);
  if (msg.category === 'peer-reply') return this._handleReply(msg);
  // unrecognized message on this port -- ignore rather than throw, matching
  // WorkerMessage.prototype.onWorkerMessage's own "or else discard" policy.
};

PeerChannel.prototype._handleInvoke = function(msg) {
  if (typeof(this.onInvoke) !== 'function') {
    var noHandlerErr = new DeviceError('PEER_NO_HANDLER');
    return this.port.postMessage({id: msg.id, category: 'peer-reply', errMsg: noHandlerErr.message, errCode: noHandlerErr.code, data: null});
  }

  // Backpressure: at capacity, queue instead of dispatching immediately --
  // see the constructor's comment on maxConcurrentInvokes.
  if (this.maxConcurrentInvokes != null && this.activeDispatches >= this.maxConcurrentInvokes) {
    this.dispatchQueue.push(msg);
    return;
  }

  this._dispatchInvoke(msg);
};

PeerChannel.prototype._dispatchInvoke = function(msg) {
  var _this = this;
  this.activeDispatches++;

  this.onInvoke(msg, function(err, data) {
    _this.activeDispatches--;

    _this.port.postMessage({
      id: msg.id,
      category: 'peer-reply',
      errMsg:  err != null ? err.message : null,
      errCode: err != null ? (err.code || null) : null,
      data: data
    });

    _this._drainDispatchQueue();
  });
};

// Called after every completed dispatch (success or failure) -- picks up
// the next queued incoming request, if capacity now allows it.
PeerChannel.prototype._drainDispatchQueue = function() {
  if (this.dispatchQueue.length === 0) return;
  if (this.maxConcurrentInvokes != null && this.activeDispatches >= this.maxConcurrentInvokes) return;

  var next = this.dispatchQueue.shift();
  this._dispatchInvoke(next);
};

PeerChannel.prototype._handleReply = function(msg) {
  this.activeSends--;
  this._drainSendQueue();

  var entry = this.pending[msg.id];
  if (entry == null) return; // already timed out, or unknown id -- drop

  delete this.pending[msg.id];
  clearTimeout(entry.timer);

  if (msg.errMsg != null) {
    var err = new Error(msg.errMsg);
    if (msg.errCode != null) err.code = msg.errCode;
    return entry.callback(err, msg.data);
  }
  return entry.callback(null, msg.data);
};

// D4: fail every pending call immediately (not waiting for its own
// timeout) with PEER_GONE, then mark this channel dead. Idempotent --
// safe to call from both the explicit peer-invalidate handler and the
// port's own 'close' event, whichever fires first.
PeerChannel.prototype.invalidate = function() {
  if (this.closed) return;
  this.closed = true;

  for (var id in this.pending) {
    var entry = this.pending[id];
    clearTimeout(entry.timer);
    entry.callback(new DeviceError('PEER_GONE'));
  }
  this.pending = {};

  // Anything still queued on either side (backpressure, above) is simply
  // dropped, not replied to/sent -- the port is closing, so there's no one
  // to send to or reply to; queued outgoing requests already had their
  // pending[] entry failed with PEER_GONE just above, and queued incoming
  // ones have no reply path left once the port itself is gone.
  this.sendQueue     = [];
  this.dispatchQueue = [];

  try { this.port.close(); } catch (e) { /* already closed */ }

  if (typeof(this.onClose) === 'function') this.onClose();
};

module.exports = PeerChannel;

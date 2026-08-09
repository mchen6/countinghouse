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
// silently stale without ever firing 'close') must be caught locally.
PeerChannel.prototype.invoke = function(deviceID, serviceID, actionName, input, timeoutMs, callback) {
  if (this.closed) return callback(new DeviceError('PEER_GONE'));

  var _this = this;
  var id = this.msgID++;

  var timer = setTimeout(function() {
    delete _this.pending[id];
    return callback(new DeviceError('PEER_CHANNEL_TIMEOUT'));
  }, timeoutMs);

  this.pending[id] = {callback: callback, timer: timer};

  this.port.postMessage({
    id: id,
    command: 'peer-invoke',
    deviceID: deviceID,
    serviceID: serviceID,
    actionName: actionName,
    input: input
  });
};

PeerChannel.prototype._onMessage = function(msg) {
  if (msg == null) return;

  if (msg.command === 'peer-invoke') return this._handleInvoke(msg);
  if (msg.category === 'peer-reply') return this._handleReply(msg);
  // unrecognized message on this port -- ignore rather than throw, matching
  // WorkerMessage.prototype.onWorkerMessage's own "or else discard" policy.
};

PeerChannel.prototype._handleInvoke = function(msg) {
  var _this = this;

  if (typeof(this.onInvoke) !== 'function') {
    var noHandlerErr = new DeviceError('PEER_NO_HANDLER');
    return this.port.postMessage({id: msg.id, category: 'peer-reply', errMsg: noHandlerErr.message, errCode: noHandlerErr.code, data: null});
  }

  this.onInvoke(msg, function(err, data) {
    return _this.port.postMessage({
      id: msg.id,
      category: 'peer-reply',
      errMsg:  err != null ? err.message : null,
      errCode: err != null ? (err.code || null) : null,
      data: data
    });
  });
};

PeerChannel.prototype._handleReply = function(msg) {
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

  try { this.port.close(); } catch (e) { /* already closed */ }

  if (typeof(this.onClose) === 'function') this.onClose();
};

module.exports = PeerChannel;

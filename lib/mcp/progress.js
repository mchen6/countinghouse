'use strict';
// The per-call progress notifier (MCP completeness M9, spec section 6), on
// the main thread only. Made for a request whose params._meta.progressToken
// is a string of at most MAX_TOKEN_CHARS characters or a safe integer (the
// token is the client's and is echoed back in every notification, so it is
// bounded; anything else is ignored: no progress, no error). Never taken
// from arguments, and never sent to a worker.
//
// Its sources: tick(), one per hop or remote call billed under the outer
// call (progress is the count so far, no total); report(value, total), the
// outer handler's own (M21), after which ticks stop so its scale stays
// 0..total. Rules: progress strictly increases (a value at or below the
// highest offered is dropped); at most one notification per MIN_INTERVAL_MS,
// the latest pending one winning; at most MAX_PER_CALL per call; nothing
// after done() (the answer, an input_required result included) or gone()
// (the client left). No message field is ever sent, so an unlisted part is
// never named to the client. A send that throws ends the notifier, never the
// call.
const MIN_INTERVAL_MS = 250;
const MAX_PER_CALL = 240;
const MAX_TOKEN_CHARS = 256;

function tokenOf(params) {
  const meta = (params != null && typeof(params) === 'object' && params._meta != null && typeof(params._meta) === 'object') ? params._meta : null;
  if (meta == null) return null;
  const t = meta.progressToken;
  if (typeof(t) === 'string' && t.length <= MAX_TOKEN_CHARS) return t;
  if (Number.isSafeInteger(t)) return t;
  return null;
}

function createProgress({token, send, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout}) {
  let closed = false;
  let reported = false;
  let ticks = 0;
  let highest = -Infinity;
  let sentCount = 0;
  let lastAt = -Infinity;
  let pending = null;
  let timer = null;

  const stop = () => {
    closed = true;
    pending = null;
    if (timer != null) { clearTimer(timer); timer = null; }
  };
  const flush = () => {
    timer = null;
    if (closed || pending == null) return;
    const {progress, total} = pending;
    pending = null;
    lastAt = now();
    sentCount += 1;
    const params = {progressToken: token, progress};
    if (total != null) params.total = total;
    try {
      send({jsonrpc: '2.0', method: 'notifications/progress', params});
    } catch (e) {
      stop();
    }
  };
  const offer = (progress, total) => {
    if (closed || sentCount >= MAX_PER_CALL || !(progress > highest)) return;
    highest = progress;
    pending = {progress, total};
    if (timer != null) return;
    const wait = lastAt + MIN_INTERVAL_MS - now();
    if (wait <= 0) return flush();
    timer = setTimer(flush, wait);
    if (timer != null && typeof(timer.unref) === 'function') timer.unref();
  };

  return {
    tick() {
      if (reported) return;
      ticks += 1;
      offer(ticks, null);
    },
    report(value, total = 100) {
      if (!Number.isFinite(value)) return;
      reported = true;
      offer(value, total);
    },
    done: stop,
    gone: stop
  };
}

module.exports = {tokenOf, createProgress, MIN_INTERVAL_MS, MAX_PER_CALL, MAX_TOKEN_CHARS};

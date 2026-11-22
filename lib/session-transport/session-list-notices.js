'use strict';
// notifications/tools/list_changed for a shared runtime's legacy session.
//
// A session on 2025-11-25 (it sent initialize) has no subscriptions/listen
// stream, so nothing told it that its tools changed. Claude Code (2.1.330)
// falls back to it when its 3 s server/discover probe times out: a slow cold
// start of the shared runtime does that, a fast one doesn't.
//
// The rule is deliberately plain: once such a session has asked for its list,
// every change to the tool set, after a settle, sends it one notice. Nothing
// compares lists, so a change can't be missed; a notice for a change that
// left its list the same costs it one re-list. The notice carries no content,
// and every session of a shared runtime is the same user (framework.js
// refuses --sessionSocket outside the single-identity profile).
//
// - A successful initialize makes a session's state, and an id'd tools/list
//   arriving after it marks it listed. (On a reattach the shim writes its
//   replayed initialize and the client's held lines together; initialize is
//   answered as it is read, so the list still comes after it.)
// - A well-formed 2026-07-28 request ends it, whatever its method's answer:
//   the client is speaking that revision, which tells nothing unasked. One
//   malformed for that revision changes nothing. A replayed initialize
//   follows it again.
// - A detach drops it: the shim tells its client on reattaching. A drain, an
//   idle stop or the daemon going stops all of it.
// - A write to a slow connection is bounded by the listener (it shuts one past
//   its write bound), and one session's failed write stops no other's.
const era = require('../mcp/era');
const {isServedRequest} = require('../mcp/gateway');

const NOTICE = {jsonrpc: '2.0', method: 'notifications/tools/list_changed'};
const SETTLE_MS = 250;
const MAX_WAIT_SETTLES = 4;

function createSessionListNotices({registry, settleMs = SETTLE_MS, maxWaitMs = MAX_WAIT_SETTLES * settleMs, now = Date.now}) {
  const held = new Map();        // session id -> {s, listed}
  const watched = new WeakSet();
  let stopped = false;
  let timer = null;
  let since = null;

  const fire = () => {
    timer = null;
    since = null;
    for (const st of held.values()) {
      if (!st.listed) continue;
      try { st.s.notify(NOTICE); } catch (e) { /* its connection is gone: its detach follows */ }
    }
  };

  registry.on('gone', (id) => { held.delete(id); });

  return {
    // its initialize succeeded (a shim's replay too)
    initialized(s) {
      if (stopped || held.has(s.id) || registry.get(s.id) !== s || s.connected !== true) return;
      held.set(s.id, {s, listed: false});
      if (!watched.has(s)) {
        watched.add(s);
        s.on('detach', () => { held.delete(s.id); });
      }
    },
    // every message from a session, as it arrives
    arrived(s, message) {
      const st = held.get(s.id);
      // (one the gateway refuses before it reads the era says nothing of it)
      if (st == null || !isServedRequest(message)) return;
      if (era.isModern(message)) {
        if (era.checkModern(message, null) == null) held.delete(s.id);
        return;
      }
      if (message.method === 'tools/list') st.listed = true;
    },
    // the device manager's toolschanged
    changed() {
      if (stopped) return;
      const at = now();
      if (since == null) since = at;
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, Math.min(settleMs, since + maxWaitMs - at)));
      if (typeof(timer.unref) === 'function') timer.unref();
    },
    // a drain, an idle stop, the daemon gone
    stop() {
      stopped = true;
      if (timer != null) clearTimeout(timer);
      timer = null;
      since = null;
      held.clear();
    },
    heldForTests: () => held.size,
    idleForTests: () => timer == null
  };
}

module.exports = {createSessionListNotices};

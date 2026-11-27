'use strict';
// notifications/tools/list_changed for a shared runtime's legacy session, and
// its prompts' and resources' list_changed (R-cold-prompts).
//
// A session on 2025-11-25 (it sent initialize) has no subscriptions/listen
// stream, so nothing told it that its tools changed. Claude Code (2.1.330)
// falls back to it when its 3 s server/discover probe times out: a slow cold
// start of the shared runtime does that, a fast one doesn't.
//
// The rule is deliberately plain: once such a session has asked for a list,
// every change to the module set, after a settle, sends it one notice for each
// list it has asked for (a module's prompts and resources come from its spec,
// so they move with the same changes as its tools: lib/mcp/subscriptions.js).
// Nothing
// compares lists, so a change can't be missed; a notice for a change that
// left its list the same costs it one re-list. The notice carries no content,
// and every session of a shared runtime is the same user (framework.js
// refuses --sessionSocket outside the single-identity profile).
//
// - A successful initialize makes a session's state, and an id'd tools/list
//   arriving after it marks it listed (prompts/list its prompts; resources/list
//   or resources/templates/list its resources). (On a reattach the shim writes its
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

// each list a session may have asked for, and the notice its change sends
const LISTS = [
  {asked: ['tools/list'], notice: {jsonrpc: '2.0', method: 'notifications/tools/list_changed'}},
  {asked: ['prompts/list'], notice: {jsonrpc: '2.0', method: 'notifications/prompts/list_changed'}},
  {asked: ['resources/list', 'resources/templates/list'], notice: {jsonrpc: '2.0', method: 'notifications/resources/list_changed'}}
];
const SETTLE_MS = 250;
const MAX_WAIT_SETTLES = 4;

function createSessionListNotices({registry, settleMs = SETTLE_MS, maxWaitMs = MAX_WAIT_SETTLES * settleMs, now = Date.now}) {
  const held = new Map();        // session id -> {s, listed: Set of LISTS entries it asked for}
  const watched = new WeakSet();
  let stopped = false;
  let timer = null;
  let since = null;

  const fire = () => {
    timer = null;
    since = null;
    for (const st of held.values()) {
      for (const list of LISTS) {
        if (!st.listed.has(list)) continue;
        try { st.s.notify(list.notice); } catch (e) { break; /* its connection is gone: its detach follows */ }
      }
    }
  };

  registry.on('gone', (id) => { held.delete(id); });

  return {
    // its initialize succeeded (a shim's replay too)
    initialized(s) {
      if (stopped || held.has(s.id) || registry.get(s.id) !== s || s.connected !== true) return;
      held.set(s.id, {s, listed: new Set()});
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
      const list = LISTS.find((l) => l.asked.includes(message.method));
      if (list != null) st.listed.add(list);
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

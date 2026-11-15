'use strict';
// subscriptions/listen's listeners (#231): MCP 2026-07-28 sends change
// notifications only on a stream the client opens for them ("The server MUST
// NOT send notification types the client has not explicitly requested",
// basic/patterns/subscriptions.md). This serves the one type the runtime
// has, notifications/tools/list_changed, on HTTP (an SSE response,
// lib/routes/mcp.js) and stdio (lines, lib/route-manager.js) alike.
//
// A listener's baseline is the tool list its key was shown when it opened.
// Once the device manager's changes settle, each listener's key lists again,
// and a list that differs from the listener's last one sends one
// list_changed. So a reload that comes back the same says nothing, as on the
// legacy stdio path. Each notification carries
// _meta["io.modelcontextprotocol/subscriptionId"], the listen request's id.
// At most MAX_PER_KEY are open per key.
const SUBSCRIPTION_ID_KEY = 'io.modelcontextprotocol/subscriptionId';
const MAX_PER_KEY = 8;
// across every key: a bound on what any number of keys can hold open
const MAX_TOTAL = 64;
const SETTLE_MS = 250;

const byName = (a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
const fingerprint = (tools) => (Array.isArray(tools) ? JSON.stringify(tools.slice().sort(byName)) : null);
const keyOf = (appKey) => (appKey == null ? '' : String(appKey));

// listTools(appKey) -> Promise of the tools that key is listed (or null).
function createHub({listTools, settleMs = SETTLE_MS, maxPerKey = MAX_PER_KEY, maxTotal = MAX_TOTAL}) {
  const listeners = new Set();
  let timer = null;
  const listOf = (appKey) => Promise.resolve().then(() => listTools(appKey)).then(fingerprint, () => null);

  function count(appKey) {
    const key = keyOf(appKey);
    let n = 0;
    for (const l of listeners) if (l.key === key) n += 1;
    return n;
  }

  // -> {ok: true, close()}, or {ok: false, reason}: 'key' when the key has
  // maxPerKey open, 'total' when maxTotal are open across every key.
  // write(message) sends one notification on the listener's stream; finish()
  // ends it gracefully (the transport then answers the listen request).
  function open({id, appKey, filter, write, finish}) {
    if (listeners.size >= maxTotal) return {ok: false, reason: 'total'};
    if (count(appKey) >= maxPerKey) return {ok: false, reason: 'key'};
    const l = {id, appKey, key: keyOf(appKey), filter: filter || {}, write, finish, shown: null, open: true};
    l.ready = listOf(appKey).then((fp) => { l.shown = fp; });
    listeners.add(l);
    return {ok: true, close: () => { l.open = false; listeners.delete(l); }};
  }

  async function round() {
    const lists = new Map();
    for (const l of [...listeners]) {
      if (!l.open || l.filter.toolsListChanged !== true) continue;
      await l.ready;
      if (!lists.has(l.key)) lists.set(l.key, listOf(l.appKey));
      const now = await lists.get(l.key);
      if (now == null || now === l.shown || !l.open) continue;
      l.shown = now;
      try {
        l.write({jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {_meta: {[SUBSCRIPTION_ID_KEY]: l.id}}});
      } catch (e) { /* the stream is gone; its close removes it */ }
    }
  }

  // the device manager's toolschanged: compared once the changes settle
  function changed() {
    if (listeners.size === 0) return;
    clearTimeout(timer);
    timer = setTimeout(() => { round().catch(() => {}); }, settleMs);
    if (typeof(timer.unref) === 'function') timer.unref();
  }

  // the transport is ending (stdio's input ended, or a drain): each listener
  // ends gracefully, once
  function endAll() {
    for (const l of [...listeners]) {
      l.open = false;
      listeners.delete(l);
      try { l.finish(); } catch (e) { /* the stream is gone */ }
    }
  }

  return {open, changed, endAll, count};
}

module.exports = {createHub, SUBSCRIPTION_ID_KEY, MAX_PER_KEY, MAX_TOTAL};

'use strict';
// subscriptions/listen's listeners (#231, M8): MCP 2026-07-28 sends change
// notifications only on a stream the client opens for them ("The server MUST
// NOT send notification types the client has not explicitly requested",
// basic/patterns/subscriptions.md). Served on HTTP (an SSE response,
// lib/routes/mcp.js), stdio (lines, lib/route-manager.js) and a shared
// runtime's session alike.
//
// The lists: notifications/tools/list_changed, notifications/resources/
// list_changed (the resources and the resource templates) and
// notifications/prompts/list_changed. A listener's baseline is each list it
// agreed to as its key (and session) was shown it when it opened. Once the
// device manager's changes settle, each listener's key lists again, and a
// list that differs from the listener's last one sends one list_changed. So
// a reload that comes back the same says nothing, as on the legacy stdio
// path.
//
// resourceSubscriptions (M8, MCP completeness spec section 3): URIs of module
// resources. A module has no API to say its data changed, so its resource
// declaration says which of its actions may change it (changesWith). After
// such a call succeeds (callSucceeded: the main thread records every
// successful call, lib/countinghouse-interface.js), each listener of the
// calling key that subscribed a URI of that resource gets one
// notifications/resources/updated per URI, coalesced over the settle. Each
// listener resolves its URIs in its own view (its key and session: a pack
// its session doesn't list resolves nothing), and on the shared runtime a
// per-session module's change reaches only the calling session's listeners:
// another session's state did not change, and must not learn that this one
// acted.
//
// Each notification carries _meta["io.modelcontextprotocol/subscriptionId"],
// the listen request's id. At most MAX_PER_KEY are open per key.
const SUBSCRIPTION_ID_KEY = 'io.modelcontextprotocol/subscriptionId';
const MAX_PER_KEY = 8;
// a shared runtime's session: a client needs one listen
const MAX_PER_SESSION = 2;
// across every key and session: a bound on what any number can hold open,
// and no lower than the shared runtime's sessions (MAX_SESSIONS, 256), so a
// few sessions can't lock the rest out
const MAX_TOTAL = 512;
const SETTLE_MS = 250;
// resourceSubscriptions: at most this many URIs per listen, each at most
// this many bytes (spec section 11's bounds)
const MAX_URIS = 64;
const MAX_URI_BYTES = 2048;

// The lists a listener may follow: the filter key it agrees to, the lists
// fingerprinted for it, and what a change sends.
const KINDS = [
  {filter: 'toolsListChanged', lists: ['tools'], method: 'notifications/tools/list_changed'},
  {filter: 'resourcesListChanged', lists: ['resources', 'resourceTemplates'], method: 'notifications/resources/list_changed'},
  {filter: 'promptsListChanged', lists: ['prompts'], method: 'notifications/prompts/list_changed'}
];

// a list as a set: its items' JSON, sorted, so an order that moves says
// nothing
const fingerprint = (list) => (Array.isArray(list) ? JSON.stringify(list.map((item) => JSON.stringify(item)).sort()) : null);
// A listener's scope: its session's id on a shared runtime, where every
// session has the user's one key, or its key elsewhere. The per-scope limit
// and the shared listing follow it.
const scopeOf = (appKey, session) => (session != null ? `s:${session}` : `k:${appKey == null ? '' : String(appKey)}`);

// Whether a listen agreed to anything: a slot is held for it only then. Any
// agreed value that is true, or a non-empty list (the URIs of
// resourceSubscriptions, a task's ids).
function agreedToAny(agreed) {
  if (agreed == null || typeof(agreed) !== 'object') return false;
  return Object.keys(agreed).some((k) => agreed[k] === true || (Array.isArray(agreed[k]) && agreed[k].length > 0));
}

// lists: {tools, resources, resourceTemplates, prompts}, each (appKey,
// session) -> Promise of the whole list that key (and that session, on a
// shared runtime) is shown, or null. listTools is lists.tools (the earlier
// signature). resolveUris(appKey, session, uris) -> Promise of a Map from each
// URI that resolves in that view to {deviceID, changesWith}. perSession
// (deviceID) -> whether that module keeps state per session where it runs.
function createHub({listTools, lists = {}, resolveUris = null, perSession = () => false, settleMs = SETTLE_MS, maxPerKey = MAX_PER_KEY,
  maxPerSession = MAX_PER_SESSION, maxTotal = MAX_TOTAL}) {
  const listFns = Object.assign({}, lists);
  if (listFns.tools == null && typeof(listTools) === 'function') listFns.tools = listTools;
  const listeners = new Set();
  let timer = null;
  const listOf = (name, appKey, session) => {
    const fn = listFns[name];
    if (typeof(fn) !== 'function') return Promise.resolve(null);
    return Promise.resolve().then(() => fn(appKey, session)).then(fingerprint, () => null);
  };
  // a kind's fingerprint: its lists' together, or null if one can't be listed
  const kindOf = (kind, appKey, session) => Promise.all(kind.lists.map((name) => listOf(name, appKey, session)))
    .then((fps) => (fps.some((fp) => fp == null) ? null : JSON.stringify(fps)));

  function count(appKey, session = null) {
    const key = scopeOf(appKey, session);
    let n = 0;
    for (const l of listeners) if (l.key === key) n += 1;
    return n;
  }

  // -> {ok: true, close()}, or {ok: false, reason}: 'key' when the key has
  // maxPerKey open, 'total' when maxTotal are open across every key.
  // write(message) sends one notification on the listener's stream; finish()
  // ends it gracefully (the transport then answers the listen request).
  // filter: what was agreed (lib/mcp/gateway.js handleListen): a kind's key
  // true, and resourceSubscriptions the URIs it agreed to.
  function open({id, appKey, session = null, filter, write, finish}) {
    if (listeners.size >= maxTotal) return {ok: false, reason: 'total'};
    if (count(appKey, session) >= (session != null ? maxPerSession : maxPerKey)) return {ok: false, reason: 'key'};
    const f = filter || {};
    const kinds = KINDS.filter((k) => f[k.filter] === true);
    const uris = Array.isArray(f.resourceSubscriptions) ? f.resourceSubscriptions.slice(0, MAX_URIS) : [];
    const l = {id, appKey, session, key: scopeOf(appKey, session), filter: f, kinds, uris, write, finish, shown: {}, open: true};
    l.ready = Promise.all(kinds.map((k) => kindOf(k, appKey, session).then((fp) => { l.shown[k.filter] = fp; })));
    listeners.add(l);
    return {ok: true, close: () => { l.open = false; listeners.delete(l); }};
  }

  const notify = (l, method, params) => {
    try {
      l.write({jsonrpc: '2.0', method, params: Object.assign({}, params, {_meta: {[SUBSCRIPTION_ID_KEY]: l.id}})});
    } catch (e) { /* the stream is gone; its close removes it */ }
  };

  // which listeners the next round lists again: everyone's, or only the
  // sessions named since the last round (B3 Task 5)
  let pendingAll = false;
  const pendingSessions = new Set();

  async function round(all, sessions) {
    const fps = new Map();
    for (const l of [...listeners]) {
      if (!l.open || l.kinds.length === 0) continue;
      if (!all && !sessions.has(l.session)) continue;
      await l.ready;
      for (const kind of l.kinds) {
        const at = `${l.key}|${kind.filter}`;
        if (!fps.has(at)) fps.set(at, kindOf(kind, l.appKey, l.session));
        const now = await fps.get(at);
        if (now == null || now === l.shown[kind.filter] || !l.open) continue;
        l.shown[kind.filter] = now;
        notify(l, kind.method, {});
      }
    }
  }

  // the device manager's toolschanged (no session: everyone's list may have
  // moved), or one session's view (lib/session-packs.js onChange: its pack
  // override, by whatever road): compared once the changes settle. Calls in
  // one settle window make one round, and one with no session in it makes
  // that round list everyone. A module's resources and prompts are derived
  // from its spec, so they move with the same changes as its tools.
  function changed({session = null} = {}) {
    if (listeners.size === 0) return;
    if (session == null) pendingAll = true; else pendingSessions.add(session);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const everyone = pendingAll;
      const sessions = new Set(pendingSessions);
      pendingAll = false;
      pendingSessions.clear();
      round(everyone, sessions).catch(() => {});
    }, settleMs);
    if (typeof(timer.unref) === 'function') timer.unref();
  }

  // resourceSubscriptions: successful calls, held for one settle
  let calls = [];
  let callTimer = null;
  const holdingUris = () => {
    for (const l of listeners) if (l.open && l.uris.length > 0) return true;
    return false;
  };

  async function updateRound(batch) {
    for (const l of [...listeners]) {
      if (!l.open || l.uris.length === 0) continue;
      const mine = batch.filter((c) => c.appKey === l.appKey);
      if (mine.length === 0) continue;
      let seen;
      try { seen = await resolveUris(l.appKey, l.session, l.uris); } catch (e) { continue; }
      if (seen == null || !l.open) continue;
      for (const uri of l.uris) {
        const r = seen.get(uri);
        if (r == null || !Array.isArray(r.changesWith)) continue;
        const shared = perSession(r.deviceID) !== true;
        const moved = mine.some((c) => c.deviceID === r.deviceID && r.changesWith.includes(`${c.serviceID}.${c.actionName}`) &&
          (shared || (c.session != null && c.session === l.session)));
        if (moved) notify(l, 'notifications/resources/updated', {uri});
      }
    }
  }

  // A call that succeeded: {appKey, deviceID, serviceID, actionName,
  // session} (session: the call's, or null). Nothing is held when no
  // listener subscribed a URI.
  function callSucceeded(call) {
    if (typeof(resolveUris) !== 'function' || call == null || !holdingUris()) return;
    calls.push({appKey: call.appKey, deviceID: call.deviceID, serviceID: call.serviceID, actionName: call.actionName,
      session: call.session != null ? call.session : null});
    if (callTimer != null) return;
    callTimer = setTimeout(() => {
      const batch = calls;
      calls = [];
      callTimer = null;
      updateRound(batch).catch(() => {});
    }, settleMs);
    if (typeof(callTimer.unref) === 'function') callTimer.unref();
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

  // a session's streams are gone (its connection dropped, or it ended):
  // its listeners close without an answer, which its client can't read
  function closeSession(session) {
    for (const l of [...listeners]) {
      if (l.session === session) { l.open = false; listeners.delete(l); }
    }
  }

  return {open, changed, callSucceeded, endAll, count, closeSession};
}

module.exports = {createHub, agreedToAny, SUBSCRIPTION_ID_KEY, MAX_PER_KEY, MAX_PER_SESSION, MAX_TOTAL, MAX_URIS, MAX_URI_BYTES, KINDS};

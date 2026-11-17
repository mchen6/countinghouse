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
// taskIds (M16, the tasks extension): a 2026-07-28 task's ids its caller
// may read, agreed at the listen through tasks/get's own lookup. Told of a
// task's change (lib/task-events.js: an id and a kind, never anything about
// who may hear it), a listener holding the id builds the task through its
// own taskView -- the same lookup and the same DetailedTask tasks/get
// answers, run again at each send -- and writes notifications/tasks with it.
// A task it can't read any more (its job gone, its session ended) leaves its
// set silently. A working task's notices are coalesced to at most one per
// TASK_NOTICE_MS per listener and task, the latest; a terminal one
// (completed, failed, cancelled) is sent at once, exactly once, and its id
// leaves the set. A task already terminal at the listen is sent once, right
// after the ack (start). A closed listener frees its timers.
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
// taskIds: at most this many asked per listen (more is -32602), and a
// working task's notices at most once per this many ms per listener
const MAX_TASK_IDS = 64;
const TASK_NOTICE_MS = 1000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

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
  maxPerSession = MAX_PER_SESSION, maxTotal = MAX_TOTAL, taskNoticeMs = TASK_NOTICE_MS, now = Date.now}) {
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
  // true, resourceSubscriptions the URIs it agreed to, taskIds the tasks.
  // taskView(taskId) -> Promise of the task as tasks/get answers it for this
  // listener's caller now, or null where tasks/get would answer -32602.
  // start() (once the ack is written) sends each agreed task already
  // terminal, or waiting on its question (input_required: the client must
  // act, and has not seen it); a working one is not sent.
  function open({id, appKey, session = null, filter, write, finish, taskView = null}) {
    if (listeners.size >= maxTotal) return {ok: false, reason: 'total'};
    if (count(appKey, session) >= (session != null ? maxPerSession : maxPerKey)) return {ok: false, reason: 'key'};
    const f = filter || {};
    const kinds = KINDS.filter((k) => f[k.filter] === true);
    const uris = Array.isArray(f.resourceSubscriptions) ? f.resourceSubscriptions.slice(0, MAX_URIS) : [];
    const l = {id, appKey, session, key: scopeOf(appKey, session), filter: f, kinds, uris, write, finish, shown: {}, open: true,
      tasks: new Map(), taskView};
    if (typeof(taskView) === 'function' && Array.isArray(f.taskIds)) {
      for (const t of f.taskIds.slice(0, MAX_TASK_IDS)) l.tasks.set(t, {last: -Infinity, timer: null, sent: null, chain: Promise.resolve(), queued: false, queuedInitial: false});
    }
    l.ready = Promise.all(kinds.map((k) => kindOf(k, appKey, session).then((fp) => { l.shown[k.filter] = fp; })));
    listeners.add(l);
    return {ok: true, close: () => shut(l), start: () => { for (const t of [...l.tasks.keys()]) kick(l, t, true); }};
  }

  // a listener gone: no more writes, and its timers freed
  function shut(l) {
    l.open = false;
    listeners.delete(l);
    for (const e of l.tasks.values()) if (e.timer != null) clearTimeout(e.timer);
    l.tasks.clear();
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

  // resourceSubscriptions: successful calls, held for one settle in a batch
  // of their own key and session (scopeOf), each with its own timer: a call
  // never shortens, or shows up in, the timing of another key's or session's
  // notices. A batch holds each call once (the same action, device and
  // session); its round lists each view once; and a batch never starts a
  // round while its last one is still running (calls that come meanwhile
  // wait for the next).
  const batches = new Map();
  const holdingUrisFor = (appKey) => {
    for (const l of listeners) if (l.open && l.uris.length > 0 && l.appKey === appKey) return true;
    return false;
  };

  async function updateRound(appKey, batch) {
    // this key's listeners holding URIs, by view (key and session)
    const views = new Map();
    for (const l of listeners) {
      if (!l.open || l.uris.length === 0 || l.appKey !== appKey) continue;
      const at = scopeOf(l.appKey, l.session);
      if (!views.has(at)) views.set(at, {session: l.session, listeners: [], uris: new Set()});
      const v = views.get(at);
      v.listeners.push(l);
      for (const uri of l.uris) v.uris.add(uri);
    }
    for (const v of views.values()) {
      let seen;
      try { seen = await resolveUris(appKey, v.session, [...v.uris]); } catch (e) { continue; }
      if (seen == null) continue;
      for (const l of v.listeners) {
        if (!l.open) continue;
        for (const uri of l.uris) {
          const r = seen.get(uri);
          if (r == null || !Array.isArray(r.changesWith)) continue;
          const shared = perSession(r.deviceID) !== true;
          const moved = batch.some((c) => c.deviceID === r.deviceID && r.changesWith.includes(`${c.serviceID}.${c.actionName}`) &&
            (shared || (c.session != null && c.session === l.session)));
          if (moved) notify(l, 'notifications/resources/updated', {uri});
        }
      }
    }
  }

  function schedule(scope, b) {
    if (b.timer != null || b.running) return;
    b.timer = setTimeout(() => {
      b.timer = null;
      b.running = true;
      const batch = [...b.calls.values()];
      b.calls.clear();
      updateRound(b.appKey, batch).catch(() => {}).then(() => {
        b.running = false;
        if (b.calls.size > 0) schedule(scope, b); else batches.delete(scope);
      });
    }, settleMs);
    if (typeof(b.timer.unref) === 'function') b.timer.unref();
  }

  // A call that succeeded: {appKey, deviceID, serviceID, actionName,
  // session} (session: the call's, or null). Held only when a listener of
  // its key holds URIs.
  function callSucceeded(call) {
    if (typeof(resolveUris) !== 'function' || call == null || !holdingUrisFor(call.appKey)) return;
    const session = call.session != null ? call.session : null;
    const scope = scopeOf(call.appKey, session);
    let b = batches.get(scope);
    if (b == null) {
      b = {appKey: call.appKey, calls: new Map(), timer: null, running: false};
      batches.set(scope, b);
    }
    b.calls.set(`${call.deviceID}|${call.serviceID}.${call.actionName}|${session}`,
      {appKey: call.appKey, deviceID: call.deviceID, serviceID: call.serviceID, actionName: call.actionName, session});
    schedule(scope, b);
  }

  // taskIds: a task's change, built and sent per listener. Each (listener,
  // task) runs one step at a time (its chain), so a terminal send and a
  // coalesced one never cross.
  // At most one step waits behind the running one, and it builds the task
  // as it is when it runs, so a flood of changes costs one build at a time,
  // never one per change. While a window's send is pending, a change whose
  // kind isn't terminal builds nothing: that send reads the latest. A
  // terminal kind always builds at once (kind is a hint; the view decides).
  function kick(l, taskId, initial = false, kind = null) {
    const e = l.tasks.get(taskId);
    if (e == null) return;
    if (!initial && e.timer != null && !TERMINAL.has(kind)) return;
    if (e.queued) {
      if (!initial) e.queuedInitial = false;
      return;
    }
    e.queued = true;
    e.queuedInitial = initial;
    e.chain = e.chain.then(() => {
      e.queued = false;
      return taskStep(l, taskId, e, e.queuedInitial);
    }).catch(() => {});
  }
  const holds = (l, taskId, e) => l.open && l.tasks.get(taskId) === e;
  function dropTask(l, taskId, e) {
    if (e.timer != null) clearTimeout(e.timer);
    e.timer = null;
    if (l.tasks.get(taskId) === e) l.tasks.delete(taskId);
  }
  // terminal: sent once and the entry dropped, so no copy is kept to compare
  function sendTask(l, e, task, terminal = false) {
    if (!terminal) {
      const text = JSON.stringify(task);
      if (text === e.sent) return;
      e.sent = text;
    }
    e.last = now();
    notify(l, 'notifications/tasks', task);
  }
  async function taskStep(l, taskId, e, initial) {
    if (!holds(l, taskId, e)) return;
    let task = null;
    try { task = await l.taskView(taskId); } catch (err) { task = null; }
    if (!holds(l, taskId, e)) return;
    // not readable now (its job gone, its session ended): left, unsaid
    if (task == null) return dropTask(l, taskId, e);
    if (TERMINAL.has(task.status)) {
      sendTask(l, e, task, true);
      return dropTask(l, taskId, e);
    }
    // working at the listen: the client has it already; changes follow. One
    // waiting on its question is sent: the client must answer it.
    if (initial && task.status !== 'input_required') return undefined;
    const wait = e.last + taskNoticeMs - now();
    if (wait <= 0) return sendTask(l, e, task);
    // within the window: one send at its end, of the task as it is then
    if (e.timer == null) {
      e.timer = setTimeout(() => { e.timer = null; kick(l, taskId); }, wait);
      if (typeof(e.timer.unref) === 'function') e.timer.unref();
    }
    return undefined;
  }

  // lib/task-events.js: a task changed (kind is only a hint: every listener
  // holding the id rebuilds the task through its own view)
  function taskChanged(taskId, kind = null) {
    for (const l of [...listeners]) if (l.open && l.tasks.has(taskId)) kick(l, taskId, false, kind);
  }

  // the transport is ending (stdio's input ended, or a drain): each listener
  // ends gracefully, once
  function endAll() {
    for (const l of [...listeners]) {
      shut(l);
      try { l.finish(); } catch (e) { /* the stream is gone */ }
    }
  }

  // a session's streams are gone (its connection dropped, or it ended):
  // its listeners close without an answer, which its client can't read
  function closeSession(session) {
    for (const l of [...listeners]) {
      if (l.session === session) shut(l);
    }
  }

  return {open, changed, callSucceeded, taskChanged, endAll, count, closeSession};
}

module.exports = {createHub, agreedToAny, SUBSCRIPTION_ID_KEY, MAX_PER_KEY, MAX_PER_SESSION, MAX_TOTAL, MAX_URIS, MAX_URI_BYTES, MAX_TASK_IDS,
  TASK_NOTICE_MS, KINDS};

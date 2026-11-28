'use strict';
// The main thread's per-session state (the shared runtime, B1 Task 1:
// docs/superpowers/plans/2026-11-15-shared-runtime-b1-sessions.md). C1's
// registry (lib/session-transport/registry.js) holds the connections; this
// holds what each session is to the runtime: its client, as its first
// initialize named it; its context for a request (P2's lib/mcp/client-info.js,
// per session); its repository default (C1's client frame). Its notice
// queue and log level are lib/notices.js's (B2 Task 3). Its calls' tokens are indexed by lib/call-tokens.js
// (ofSession(id), Task 2). Nothing here ever reaches a worker. A session
// that ends leaves nothing.
//
// --stdio is one session, opened when the stdio runtime starts serving
// (lib/route-manager.js startStdio: openLocal), its id fixed for the
// process's life, as P2's confirmations need.
//
// A session acts only once its client frame has settled (C1: the registry
// announces a session only once settled; until s.client is set it answers
// nothing here either).
const crypto = require('crypto');

// id -> {id, source, clientInfo, limits, legacy}
const states = new Map();
// the --stdio session's id: one for the process, made at load
const LOCAL = crypto.randomBytes(16).toString('hex');
const attached = new WeakSet();
// shared mode: on once a registry is attached (the runtime serves the shim's
// session listener, and nothing else: no HTTP, no --stdio). Every call then
// needs a live session (lib/mcp/gateway.js sessionIdOf).
let sharedMode = false;

const asInfo = (v) => (v != null && typeof(v) === 'object' && typeof(v.name) === 'string' && typeof(v.version) === 'string')
  ? {name: v.name.slice(0, 128), version: v.version.slice(0, 64)} : null;

// source: C1's session object (its client and its end), or null (--stdio)
function open(id, source) {
  if (states.has(id)) return states.get(id);   // never replaced: its first initialize stays
  // limits: the session's override of the cap and timeout, or null (B2 sets it)
  // shimHolds: the snapshot of its tightenings its shim was last sent ('' for
  // none; null when not known); attached: a settled connection is there (a
  // session is announced once settled)
  const state = {id, source, clientInfo: null, limits: null, legacy: false, shimHolds: '', attached: true, replaying: false};
  states.set(id, state);
  return state;
}

// A session's end: its state is gone, and its jobs run from now on at the
// tighter of its last override and the defaults (lib/job-sessions.js).
// reason: the registry's ('bye', 'window', 'closed', 'unsettled').
// (closeHooks: told each session's id once it is closed: the per-session
// pool clears its stopping mark then). One hook per key: a later one under
// the same key replaces it (a new module manager's, in one process)
const closeHooks = new Map();
function onClose(key, fn) {
  closeHooks.set(key, fn);
  return () => { if (closeHooks.get(key) === fn) closeHooks.delete(key); };
}

function close(id, reason) {
  const state = states.get(id);
  states.delete(id);
  for (const fn of [...closeHooks.values()]) { try { fn(id); } catch (e) { /* a hook's own */ } }
  // the validators' per-caller entries of its key (validationCallerOf), in a
  // pool this process started
  if (sharedMode) {
    try { const p = require('./validator-pool').started(); if (p != null) p.forgetSession(id); } catch (e) { /* the close goes on */ }
  }
  // its last caps (B2's overrides) to its jobs, then they're gone
  const settings = require('./session-settings');
  require('./job-sessions').sessionEnded(id, settings.limitsOf(id) || (state != null ? state.limits : null));
  // its tasks are cancelled: nothing runs that no one can read (B5 Task 4).
  // Only at its real end, as R1 removes a session's partitions: its shim
  // left ('bye') or its reconnect window ran out ('window'). The runtime
  // stopping ('closed') or a connection that never settled ('unsettled')
  // cancels nothing: the session may resume. A shared runtime's runner is
  // the local store's (framework.js refuses --sessionSocket without --store
  // local); a run already under way finishes under the last caps just kept
  // for it
  if ((reason === 'bye' || reason === 'window') && require('./cli-options').store === 'local') {
    const jobs = require('./store').jobs;
    if (typeof(jobs.cancelSession) === 'function') jobs.cancelSession(id);
  }
  settings.forget(id);
  require('./notices').forget(id);
  // the counts of its repeated requests are written, and nothing of it kept
  require('./settings-tool').forgetSession(id);
  // its confirmations: a form it left pending counts as an expiry, and is
  // said in the history with any its timer expired since it last asked
  require('./settings-tool').recordUnanswered(id, require('./settings-confirm').forget(id));
  // its calls still under way go on at the defaults or tighter: a loosened
  // call's longer timer is re-armed now (#271's review, 3)
  require('./session').rearmSession(id);
  // and what was last told of it to the daemon is forgotten (B2 Task 6)
  require('./session-state').gone(id);
}

// The session id a usage record carries: a shared runtime's session's, in
// shared mode only (under --stdio its one id means nothing across processes,
// and a record from no session has no field: today's records unchanged).
function forUsage(id) {
  return (sharedMode && typeof(id) === 'string') ? id : null;
}

// The validators' per-caller key (lib/validator-pool.js: an input's stalls,
// the throttle they lead to, a caller's one validation in flight, the
// scheduling of a caller that stalled lately): the caller id, and in a
// shared runtime its session as well (B-valsess, the Fable pass of 11-17).
// There every session is the one local user's, one caller id, so one
// session's stalling inputs throttled every session's calls to that module.
// So each session has its own allowance and its own validation in flight;
// a new session starts afresh, which only the local user (the holder of
// the runtime's secret) can open. Only in shared mode, whose session ids the
// runtime's registry makes: never over HTTP, where a client choosing new
// session ids would slip its own throttle; under --stdio there is one
// session. A session's entries go with it (close: validator-pool
// forgetSession).
function validationCallerOf(callerId, sessionId) {
  if (callerId == null) return null;
  return (sharedMode && typeof(sessionId) === 'string' && sessionId !== '') ? `${callerId}#${sessionId}` : callerId;
}

// A session's tightenings, kept by its shim for a daemon restart (B2 Task 4;
// the design, #236 section 6). After each change the shim is told to forget
// what it holds and then given ONE record, a snapshot of every tightening
// of the session ({name: value} for the two caps), so its eviction (at most
// 64 entries, the oldest first) can never drop a live one (finding 10).
// C1's session drops whatever is sent with no settled connection attached
// (and it is `connected` from a resumed connection's WELCOME, before that
// connection has settled), so nothing is sent, or taken as sent, between a
// session's 'detach' and its 'attach': the snapshot goes at the attach
// (F10). A loosening is never recorded: only what a replay may apply.
const {CAPS} = require('./session-settings');   // the two caps a session may set for itself
const MAX_REPLAYED = 64;

function tighteningsOf(id) {
  const out = {};
  for (const o of require('./session-settings').overridesOf(id)) if (CAPS.includes(o.name) && o.loosening !== true) out[o.name] = o.value;
  return out;
}

function snapshot(id) {
  const state = states.get(id);
  // while detached, or in the middle of a replay, nothing is sent: the
  // attach, or the replay's end, sends it
  if (state == null || state.source == null || state.attached !== true || state.replaying === true) return;
  const values = tighteningsOf(id);
  const text = Object.keys(values).length > 0 ? JSON.stringify(values) : '';
  if (text === state.shimHolds) return;
  state.source.forget();
  if (text !== '') state.source.record(values);
  state.shimHolds = text;
}

// A replay: the records a restarted daemon's shim kept, given back for its
// new session. Each is untrusted (anything on the user's side of the pipe
// may have written it): a name is taken only if it is one of the two caps,
// its value checked as set checks one (a whole number within the bounds,
// never a string), and applied only if it tightens -- at least as tight as
// the default and the ceiling, and as anything an earlier entry set. So a
// forged replay can only tighten.
//
// The shim holds whatever it replayed, applied or not. So after a replay it
// is told to forget and given the session's snapshot as it now stands, once
// (not at each entry): a record that no longer tightens is not replayed at
// every later restart. A replay may come from a resumed connection too,
// with calls under way: a tightened timeout re-arms them.
function replayed(id, entries) {
  const state = states.get(id);
  if (state == null || !Array.isArray(entries) || entries.length === 0) return;
  const settings = require('./session-settings');
  let timeout = false;
  const valuesNow = () => Object.fromEntries(CAPS.map((name) => { try { return [name, settings.effective(id, name)]; } catch (e) { return [name, null]; } }));
  const before = valuesNow();
  state.replaying = true;
  try {
    for (const entry of entries.slice(0, MAX_REPLAYED)) {
      if (entry == null || typeof(entry) !== 'object' || Array.isArray(entry)) continue;
      for (const name of CAPS) {
        try {
          if (!Object.prototype.hasOwnProperty.call(entry, name)) continue;
          const value = entry[name];
          if (!Number.isSafeInteger(value) || settings.isLoosening(id, name, value) || value === settings.effective(id, name)) continue;
          settings.set(id, name, value);
          if (name === 'requestTimeout') timeout = true;
        } catch (e) { /* what set would refuse: ignored */ }
      }
    }
  } finally {
    state.replaying = false;
  }
  if (timeout) require('./session').rearmSession(id);
  // recorded, one line a setting, as a replay (the reviewer's ruling on #284)
  const after = valuesNow();
  const changes = CAPS.filter((name) => after[name] !== before[name]).map((name) => ({name, old: before[name], next: after[name]}));
  if (changes.length > 0) require('./settings-tool').recordReplayed(id, changes);
  state.shimHolds = null;   // not known: whatever it replayed
  snapshot(id);
}

// Every session C1's registry opens, and closed when it ends.
// Attach before the listener starts (a session announced earlier has no
// state); attaching one registry twice adds nothing.
function attach(registry) {
  if (registry == null || attached.has(registry)) return;
  attached.add(registry);
  sharedMode = true;
  require('./notices').dropProcessQueue();
  require('./session-settings').onChange(snapshot);
  // each change of a session's state is told to the daemon, which keeps it
  // for a restarted runtime (B2 Task 6)
  require('./session-state').attach();
  // a session the registry forgets, announced or not (one restored that
  // never resumed): its imported row goes too
  registry.on('gone', (id) => require('./session-state').dropPending(id));
  registry.on('session', (s) => {
    const state = open(s.id, s);
    s.on('replay', (entries) => replayed(s.id, entries));
    s.on('detach', () => { state.attached = false; });
    s.on('attach', () => { state.attached = true; snapshot(s.id); latchOnNo(s.id, s.client); });
    // every later frame, as it comes (the session's own copy is overwritten
    // in place); none for a session that has ended, which has no store
    s.on('client', (client) => { if (states.get(s.id) === state) latchOnNo(s.id, client); });
    latchOnNo(s.id, s.client);
    // its notices: its own queue and level. Sent unasked as
    // notifications/message only to a legacy session (one that sent
    // initialize), as --stdio does: 2026-07-28 sends no notification type
    // the client has not asked for, so a modern session's ride on its next
    // result only (B2 Task 3's review, 1)
    // (a session back after a runtime restart, as its registry restored it,
    // is told the new run's kept notices as from before it resumed, not as
    // new to it)
    require('./notices').openSession(s.id, (m) => { if (isLegacy(s.id)) s.notify(m); }, {resumed: s.restoredAfterRestart === true});
    s.once('end', (reason) => close(s.id, reason));
    // a session resumed after a runtime restart: what the daemon kept of it
    // is applied (last: its notices have their queue, its end is heard)
    require('./session-state').resumed(s.id);
  });
}

// The --stdio session: one per process, its id fixed.
function openLocal() {
  open(LOCAL, null);
  return LOCAL;
}

// A session's state, live, for this file's own use only.
function stateOf(id) {
  if (typeof(id) !== 'string' || !states.has(id)) return null;
  const state = states.get(id);
  // a shared runtime's session acts only once its client frame is there
  if (state.source != null && state.source.client == null) return null;
  return state;
}

// Whether a session is open here (R1: the one rule workerFor and the
// per-session pool both apply); no view made
function live(id) {
  return stateOf(id) != null;
}

// A frozen view of a session ({id, clientInfo, repo}), or null: nothing a
// caller can change, and never C1's session object.
function get(id) {
  const state = stateOf(id);
  if (state == null) return null;
  return Object.freeze({id: state.id, clientInfo: state.clientInfo, repo: repoOf(id)});
}

// a session's first initialize's clientInfo; later ones change nothing.
// Any initialize makes it a legacy session (an initialize is never a
// 2026-07-28 request: lib/mcp/era.js).
function recordClientInfo(id, clientInfo) {
  const state = stateOf(id);
  if (state == null) return;
  state.legacy = true;
  if (state.clientInfo == null) state.clientInfo = asInfo(clientInfo);
}
// whether the session has sent initialize (lib/notices.js: only then is it
// sent notifications/message unasked)
function isLegacy(id) {
  const state = stateOf(id);
  return state != null && state.legacy === true;
}

// A request's context in its session ({clientInfo, capabilities, session}),
// as P2's contextOf under #229's rule. modern (a 2026-07-28 request,
// lib/mcp/era.js): only the request's own _meta, never anything a prior
// request (the session's initialize) said. Legacy: the session's
// initialize's client, and no capabilities, since an InputRequiredResult is
// the 2026-07-28 revision's and a legacy session cannot answer one. An ended
// or unknown session is none.
function contextOf(id, params, modern) {
  const state = stateOf(id);
  if (state == null) return {clientInfo: null, capabilities: null, session: null};
  if (modern === true) {
    const meta = params != null && params._meta != null && typeof(params._meta) === 'object' ? params._meta : {};
    const capabilities = meta['io.modelcontextprotocol/clientCapabilities'];
    return {
      clientInfo: asInfo(meta['io.modelcontextprotocol/clientInfo']),
      capabilities: capabilities != null && typeof(capabilities) === 'object' ? capabilities : null,
      session: id
    };
  }
  return {clientInfo: state.clientInfo, capabilities: null, session: id};
}

// The per-session latch (B2 Task 5, N1): any client frame of a session that
// says status ok and conditions no locks every kind of form for that
// session's life (lib/settings-confirm.js latch). A hook the client loaded
// can be deleted from disk, and a fresh conditions? would then answer yes
// while the client still answers the form by itself: one "no" is final.
// Every frame is seen: the first in s.client at the session's settle, a
// reconnect's at its attach, and each later one as the registry announces
// it ('client': an answer, a late answer to an ask that timed out, an
// unasked one), so a "no" that a later frame overwrites has latched all
// the same. askConditions looks again at the frame the session holds, and
// at its answer.
function latchOnNo(id, client) {
  // with why its client said no, as the line says it (lib/conditions-why.js checks it)
  if (client != null && client.status === 'ok' && client.conditions === 'no') require('./settings-confirm').latch(id, client.why);
}

// The session's own answer to "may a form be shown": its client's
// conditions, asked now (C1's s.askConditions: {status, conditions, repo},
// or null for no answer). Null too for a session that is gone, or --stdio's.
async function askConditions(id) {
  const state = stateOf(id);
  if (state == null || state.source == null || typeof(state.source.askConditions) !== 'function') return null;
  // the latest frame first, whatever brought it (C1 keeps it in place): a
  // "no" there is final, and the shim is not asked again
  latchOnNo(id, state.source.client);
  if (state.source.client.status === 'ok' && state.source.client.conditions === 'no') return Object.assign({}, state.source.client);
  const answer = await state.source.askConditions();
  if (states.get(id) === state) latchOnNo(id, answer);
  return answer == null ? null : answer;
}

// The session's repository default (an owner/name slug C1 checked), or null.
function repoOf(id) {
  const state = stateOf(id);
  const client = state != null && state.source != null ? state.source.client : null;
  return client != null && typeof(client.repo) === 'string' ? client.repo : null;
}

// (tests: a session's override, as B2 will set it)
function overrideForTests(id, limits) {
  const state = states.get(id);
  if (state != null) require('./call-limits').override(state, limits);
}

// (tests: a session's recorded client forgotten, its id kept)
function forgetClientInfoForTests(id) {
  const state = states.get(id);
  if (state != null) state.clientInfo = null;
}

// The daemon's session table, once, before the socket listens (C3's
// lib/route-manager.js startSessions, with lib/session-transport/restore.js's
// validated table): {sessions: [{session, state}], declines, reset}.
const importTable = (table) => require('./session-state').importTable(table);

module.exports = {attach, openLocal, get, live, onClose, recordClientInfo, isLegacy, contextOf, repoOf, askConditions, importTable, forgetClientInfoForTests,
  shared: () => sharedMode, forUsage, validationCallerOf, overrideForTests,
  // the ids of the sessions open now (a shared runtime's: every one is told a module's notice)
  ids: () => [...states.keys()].filter((id) => id !== LOCAL),
  // (tests: shared mode off again, every session but --stdio's gone)
  // (a test's: shared mode on or off alone, with none of attach's wiring)
  sharedForTests: (on) => { sharedMode = on === true; },
  resetForTests: () => { sharedMode = false; for (const id of [...states.keys()]) if (id !== LOCAL) states.delete(id); forgetClientInfoForTests(LOCAL); }};

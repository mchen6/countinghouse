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
function close(id) {
  const state = states.get(id);
  states.delete(id);
  // its last caps (B2's overrides) to its jobs, then they're gone
  const settings = require('./session-settings');
  require('./job-sessions').sessionEnded(id, settings.limitsOf(id) || (state != null ? state.limits : null));
  settings.forget(id);
  require('./notices').forget(id);
  // the counts of its repeated requests are written, and nothing of it kept
  require('./settings-tool').forgetSession(id);
  // its calls still under way go on at the defaults or tighter: a loosened
  // call's longer timer is re-armed now (#271's review, 3)
  require('./session').rearmSession(id);
}

// The session id a usage record carries: a shared runtime's session's, in
// shared mode only (under --stdio its one id means nothing across processes,
// and a record from no session has no field: today's records unchanged).
function forUsage(id) {
  return (sharedMode && typeof(id) === 'string') ? id : null;
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
  registry.on('session', (s) => {
    const state = open(s.id, s);
    s.on('replay', (entries) => replayed(s.id, entries));
    s.on('detach', () => { state.attached = false; });
    s.on('attach', () => { state.attached = true; snapshot(s.id); });
    // its notices: its own queue and level. Sent unasked as
    // notifications/message only to a legacy session (one that sent
    // initialize), as --stdio does: 2026-07-28 sends no notification type
    // the client has not asked for, so a modern session's ride on its next
    // result only (B2 Task 3's review, 1)
    require('./notices').openSession(s.id, (m) => { if (isLegacy(s.id)) s.notify(m); });
    s.once('end', () => close(s.id));
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

module.exports = {attach, openLocal, get, recordClientInfo, isLegacy, contextOf, repoOf, forgetClientInfoForTests,
  shared: () => sharedMode, forUsage, overrideForTests,
  // (tests: shared mode off again, every session but --stdio's gone)
  resetForTests: () => { sharedMode = false; for (const id of [...states.keys()]) if (id !== LOCAL) states.delete(id); forgetClientInfoForTests(LOCAL); }};

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

// id -> {id, source, clientInfo, limits}
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
  const state = {id, source, clientInfo: null, limits: null};
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

// Every session C1's registry opens, and closed when it ends.
// Attach before the listener starts (a session announced earlier has no
// state); attaching one registry twice adds nothing.
function attach(registry) {
  if (registry == null || attached.has(registry)) return;
  attached.add(registry);
  sharedMode = true;
  registry.on('session', (s) => {
    open(s.id, s);
    // its notices: its own queue and level, said through its s.notify
    require('./notices').openSession(s.id, (m) => s.notify(m));
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

// a session's first initialize's clientInfo; later ones change nothing
function recordClientInfo(id, clientInfo) {
  const state = stateOf(id);
  if (state != null && state.clientInfo == null) state.clientInfo = asInfo(clientInfo);
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

module.exports = {attach, openLocal, get, recordClientInfo, contextOf, repoOf, forgetClientInfoForTests,
  shared: () => sharedMode, forUsage, overrideForTests,
  // (tests: shared mode off again, every session but --stdio's gone)
  resetForTests: () => { sharedMode = false; for (const id of [...states.keys()]) if (id !== LOCAL) states.delete(id); forgetClientInfoForTests(LOCAL); }};

'use strict';
// The main thread's per-session state (the shared runtime, B1 Task 1:
// docs/superpowers/plans/2026-11-15-shared-runtime-b1-sessions.md). C1's
// registry (lib/session-transport/registry.js) holds the connections; this
// holds what each session is to the runtime: its client, as its first
// initialize named it; its context for a request (P2's lib/mcp/client-info.js,
// per session); its repository default (C1's client frame); its notice queue
// and log level (Task 5). Its calls' tokens are indexed by lib/call-tokens.js
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

// id -> {id, source, clientInfo, notices, logLevel}
const states = new Map();
// the --stdio session's id: one for the process, made at load
const LOCAL = crypto.randomBytes(16).toString('hex');
const attached = new WeakSet();

const asInfo = (v) => (v != null && typeof(v) === 'object' && typeof(v.name) === 'string' && typeof(v.version) === 'string')
  ? {name: v.name.slice(0, 128), version: v.version.slice(0, 64)} : null;

// source: C1's session object (its client and its end), or null (--stdio)
function open(id, source) {
  if (states.has(id)) return states.get(id);   // never replaced: its first initialize stays
  const state = {id, source, clientInfo: null, notices: [], logLevel: null};
  states.set(id, state);
  return state;
}

function close(id) {
  states.delete(id);
}

// Every session C1's registry opens, and closed when it ends.
// Attach before the listener starts (a session announced earlier has no
// state); attaching one registry twice adds nothing.
function attach(registry) {
  if (registry == null || attached.has(registry)) return;
  attached.add(registry);
  registry.on('session', (s) => {
    open(s.id, s);
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

// A request's context in its session, as P2's contextOf: the client (the
// request's own _meta clientInfo when present, which must agree with the
// session's initialize), its capabilities, and the session's id. An ended
// or unknown session is none.
function contextOf(id, params) {
  const state = stateOf(id);
  if (state == null) return {clientInfo: null, capabilities: null, session: null};
  const meta = params != null && params._meta != null && typeof(params._meta) === 'object' ? params._meta : {};
  const fromRequest = asInfo(meta['io.modelcontextprotocol/clientInfo']);
  const initialized = state.clientInfo;
  const disagree = fromRequest != null && initialized != null && (fromRequest.name !== initialized.name || fromRequest.version !== initialized.version);
  const capabilities = meta['io.modelcontextprotocol/clientCapabilities'];
  return {
    clientInfo: disagree ? null : (fromRequest || initialized),
    capabilities: capabilities != null && typeof(capabilities) === 'object' ? capabilities : null,
    session: id
  };
}

// The session's repository default (an owner/name slug C1 checked), or null.
function repoOf(id) {
  const state = stateOf(id);
  const client = state != null && state.source != null ? state.source.client : null;
  return client != null && typeof(client.repo) === 'string' ? client.repo : null;
}

// (tests: a session's recorded client forgotten, its id kept)
function forgetClientInfoForTests(id) {
  const state = states.get(id);
  if (state != null) state.clientInfo = null;
}

module.exports = {attach, openLocal, get, recordClientInfo, contextOf, repoOf, forgetClientInfoForTests,
  resetForTests: () => { for (const id of [...states.keys()]) if (id !== LOCAL) states.delete(id); forgetClientInfoForTests(LOCAL); }};

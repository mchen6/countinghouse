'use strict';
// The main thread's per-session state (the shared runtime, B1 Task 1:
// docs/superpowers/plans/2026-11-15-shared-runtime-b1-sessions.md). C1's
// registry (lib/session-transport/registry.js) holds the connections; this
// holds what each session is to the runtime: its client, as its first
// initialize named it; its context for a request (P2's lib/mcp/client-info.js,
// per session); its repository default (C1's client frame); its notice queue
// and log level (Task 5); and the call tokens issued for it (Task 2). Nothing
// here ever reaches a worker. A session that ends leaves nothing.
//
// --stdio is one session, opened at start (openLocal): today's behaviour.
const crypto = require('crypto');

// id -> {id, source, clientInfo, notices, logLevel, tokens}
const states = new Map();
let local = null;   // the --stdio session's id

const asInfo = (v) => (v != null && typeof(v) === 'object' && typeof(v.name) === 'string' && typeof(v.version) === 'string')
  ? {name: v.name.slice(0, 128), version: v.version.slice(0, 64)} : null;

// source: C1's session object (its client and its end), or null (--stdio)
function open(id, source) {
  const state = {id, source, clientInfo: null, notices: [], logLevel: null, tokens: new Set()};
  states.set(id, state);
  return state;
}

function close(id) {
  states.delete(id);
}

// Every session C1's registry opens, and closed when it ends.
function attach(registry) {
  registry.on('session', (s) => {
    open(s.id, s);
    s.once('end', () => close(s.id));
  });
}

// The --stdio session: one per process.
function openLocal() {
  if (local == null || !states.has(local)) {
    local = crypto.randomBytes(16).toString('hex');
    open(local, null);
  }
  return local;
}

function get(id) {
  return (typeof(id) === 'string' && states.has(id)) ? states.get(id) : null;
}

// a session's first initialize's clientInfo; later ones change nothing
function recordClientInfo(id, clientInfo) {
  const state = get(id);
  if (state != null && state.clientInfo == null) state.clientInfo = asInfo(clientInfo);
}

// A request's context in its session, as P2's contextOf: the client (the
// request's own _meta clientInfo when present, which must agree with the
// session's initialize), its capabilities, and the session's id. An ended
// or unknown session is none.
function contextOf(id, params) {
  const state = get(id);
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
  const state = get(id);
  const client = state != null && state.source != null ? state.source.client : null;
  return client != null && typeof(client.repo) === 'string' ? client.repo : null;
}

module.exports = {attach, openLocal, get, recordClientInfo, contextOf, repoOf,
  resetForTests: () => { states.clear(); local = null; }};

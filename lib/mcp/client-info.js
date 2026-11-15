'use strict';
// The stdio session's client, as its initialize named it (part 3 P2, Task 3):
// one stdio process serves one MCP session, so the clientInfo of its first
// initialize is the session's. A request's own
// _meta["io.modelcontextprotocol/clientInfo"] is used when present (the
// 2026-07-28 protocol sends it on each request); when both are there they
// must agree. session: this process's MCP session id, random, which a
// confirmation is bound to (lib/settings-confirm.js).
const crypto = require('crypto');

let initialized = null;
const session = crypto.randomBytes(16).toString('hex');

const asInfo = (v) => (v != null && typeof(v) === 'object' && typeof(v.name) === 'string' && typeof(v.version) === 'string')
  ? {name: v.name.slice(0, 128), version: v.version.slice(0, 64)} : null;

// initialize's params.clientInfo, the first one only
function record(clientInfo) {
  if (initialized != null) return;
  initialized = asInfo(clientInfo);
  // under --debug, the client's name and version only (the hand test
  // records them: docs/development/elicitation-hand-test.md)
  if (initialized != null && require('../cli-options').debug === true) {
    try { require('../logger').I(`mcp: client ${JSON.stringify(initialized.name)} ${JSON.stringify(initialized.version)}`); } catch (err) { /* not serving */ }
  }
}

// a request's params -> {clientInfo, capabilities, session}
function contextOf(params) {
  const meta = params != null && params._meta != null && typeof(params._meta) === 'object' ? params._meta : {};
  const fromRequest = asInfo(meta['io.modelcontextprotocol/clientInfo']);
  const capabilities = meta['io.modelcontextprotocol/clientCapabilities'];
  const disagree = fromRequest != null && initialized != null && (fromRequest.name !== initialized.name || fromRequest.version !== initialized.version);
  return {
    clientInfo: disagree ? null : (fromRequest || initialized),
    capabilities: capabilities != null && typeof(capabilities) === 'object' ? capabilities : null,
    session: session
  };
}

module.exports = {record, contextOf, resetForTests: () => { initialized = null; }};

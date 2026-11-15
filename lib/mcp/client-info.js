'use strict';
// The stdio session's client, as its initialize named it (part 3 P2, Task 3):
// one stdio process serves one MCP session, so the clientInfo of its first
// initialize is a legacy session's. A 2026-07-28 request names its own, in
// _meta["io.modelcontextprotocol/clientInfo"], and only that counts for it. session: this process's MCP session id, random, which a
// confirmation is bound to (lib/settings-confirm.js).
const crypto = require('crypto');

let initialized = null;
const session = crypto.randomBytes(16).toString('hex');

const asInfo = (v) => (v != null && typeof(v) === 'object' && typeof(v.name) === 'string' && typeof(v.version) === 'string')
  ? {name: v.name.slice(0, 128), version: v.version.slice(0, 64)} : null;

// initialize's params.clientInfo, the first one only
function record(clientInfo) {
  if (initialized == null) initialized = asInfo(clientInfo);
}

// a request's params -> {clientInfo, capabilities, session}. modern (a
// 2026-07-28 request, lib/mcp/era.js): only the request's own _meta, never
// anything a prior request (an initialize) said. Legacy: the initialize's
// client, and no capabilities, since an InputRequiredResult is this
// revision's and a legacy session has no way to answer one (#229).
function contextOf(params, modern) {
  const meta = params != null && params._meta != null && typeof(params._meta) === 'object' ? params._meta : {};
  if (modern === true) {
    const capabilities = meta['io.modelcontextprotocol/clientCapabilities'];
    return {
      clientInfo: asInfo(meta['io.modelcontextprotocol/clientInfo']),
      capabilities: capabilities != null && typeof(capabilities) === 'object' ? capabilities : null,
      session: session
    };
  }
  return {clientInfo: initialized, capabilities: null, session: session};
}

module.exports = {record, contextOf, resetForTests: () => { initialized = null; }};

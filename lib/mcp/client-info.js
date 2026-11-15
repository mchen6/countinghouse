'use strict';
// The stdio session's client, as its initialize named it (part 3 P2, Task 3),
// now kept as the --stdio session's state in lib/sessions.js (the shared
// runtime, B1 Task 1): one stdio process serves one MCP session, opened at
// start (sessions.openLocal()), so the clientInfo of its first initialize is
// the session's. A request's own _meta["io.modelcontextprotocol/clientInfo"]
// is used when present (the 2026-07-28 protocol sends it on each request);
// when both are there they must agree. session: the session's id, random,
// which a confirmation is bound to (lib/settings-confirm.js). A shared
// runtime's sessions use lib/sessions.js directly, by their own ids.
const sessions = require('../sessions');

// initialize's params.clientInfo, the first one only; under --debug, its
// name and version only, once (the hand test records them)
function record(clientInfo) {
  const id = sessions.openLocal();
  const state = sessions.get(id);
  const first = state != null && state.clientInfo == null;
  sessions.recordClientInfo(id, clientInfo);
  const recorded = state != null ? state.clientInfo : null;
  if (first && recorded != null && require('../cli-options').debug === true) {
    try { require('../logger').I(`mcp: client ${JSON.stringify(recorded.name)} ${JSON.stringify(recorded.version)}`); } catch (err) { /* not serving */ }
  }
}

// a request's params -> {clientInfo, capabilities, session}
function contextOf(params) {
  return sessions.contextOf(sessions.openLocal(), params);
}

module.exports = {record, contextOf, resetForTests: () => { const s = sessions.get(sessions.openLocal()); if (s != null) s.clientInfo = null; }};

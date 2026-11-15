'use strict';
// The stdio session's client, as its initialize named it (part 3 P2, Task 3),
// now kept as the --stdio session's state in lib/sessions.js (the shared
// runtime, B1 Task 1): one stdio process serves one MCP session, opened when
// it starts serving (lib/route-manager.js startStdio), its id fixed for the
// process. Its first initialize's clientInfo is a legacy session's; a
// 2026-07-28 request names its own, in
// _meta["io.modelcontextprotocol/clientInfo"], and only that counts for it
// (#229). session: the session's id, random, which a confirmation is bound
// to (lib/settings-confirm.js). A shared runtime's sessions use
// lib/sessions.js directly, by their own ids.
const sessions = require('../sessions');

// initialize's params.clientInfo, the first one only; under --debug, its
// name and version only, once (the hand test records them)
function record(clientInfo) {
  const id = sessions.openLocal();
  const before = sessions.get(id);
  const first = before != null && before.clientInfo == null;
  sessions.recordClientInfo(id, clientInfo);
  const after = sessions.get(id);
  const recorded = after != null ? after.clientInfo : null;
  if (first && recorded != null && require('../cli-options').debug === true) {
    try { require('../logger').I(`mcp: client ${JSON.stringify(recorded.name)} ${JSON.stringify(recorded.version)}`); } catch (err) { /* not serving */ }
  }
}

// a request's params -> {clientInfo, capabilities, session}, in the --stdio
// session; modern as sessions.contextOf takes it
function contextOf(params, modern) {
  return sessions.contextOf(sessions.openLocal(), params, modern);
}

module.exports = {record, contextOf, resetForTests: () => sessions.forgetClientInfoForTests(sessions.openLocal())};

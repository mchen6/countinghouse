'use strict';
// Whose calls countinghouse_usage_report covers (H7/K5, the feature audit):
// on the shared runtime, the asking session's (its records name it); on a
// per-session runtime -- ch-local's profile (the single identity with its
// --settingsFile), not shared: one process for one client session -- this
// process's, since it started; anywhere else (an HTTP host, a plain --stdio
// launch an MCP client starts itself) the caller's, across the processes of
// the usage directory, as before (the medium on H7, 2: singleIdentity alone
// also names that plain launch, whose history would have gone).
function usageReportScope({shared, sessionId, singleIdentity, settingsFile}) {
  if (shared === true) return {session: sessionId, thisProcess: false};
  return {session: undefined, thisProcess: singleIdentity === true && typeof(settingsFile) === 'string' && settingsFile !== ''};
}

module.exports = {usageReportScope};

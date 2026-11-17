'use strict';
// The scope rule for what a shared runtime's session may see of the
// runtime's records (shared runtime B5, Task 0:
// docs/superpowers/plans/2026-11-16-shared-runtime-b5-session-views.md).
//
//   of(sessionId)        -> a frozen {shared, session}: shared is
//                           lib/sessions.js shared(); session the id, or null
//   sees(scope, owner)   -> whether a record whose session is `owner` is in
//                           the scope's view
//   INTERNAL             -> the runtime's own work, which sees everything
//
// Outside shared mode every scope sees every owner, a missing one too: the
// owner key decides, as before. In shared mode a scope sees a record only when the record's
// session is the scope's own: a record with no session (from before the
// shared runtime, or a job that outlived a restart) is in no session's view,
// and a scope with no session sees nothing.

// loaded once, on first use: sees() runs per record
const sessionsLib = require('./require-once')(() => require('./sessions'));

const INTERNAL = Object.freeze({shared: true, session: null, internal: true});

function of(sessionId) {
  return Object.freeze({shared: sessionsLib().shared() === true, session: typeof(sessionId) === 'string' ? sessionId : null});
}

// Fail closed (the review of #334): the mode is read now, never from the
// scope, and in shared mode a missing scope sees nothing. Only INTERNAL, by
// identity, sees everything there.
function sees(scope, owner) {
  if (scope === INTERNAL) return true;
  if (sessionsLib().shared() !== true) return true;
  return scope != null && typeof(scope.session) === 'string' && scope.session === owner;
}

module.exports = {of, sees, INTERNAL};

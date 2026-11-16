'use strict';
// A session's state across a runtime restart, the runtime's side (the
// shared-runtime design, #236, section 6; B2 Task 6). The runtime keeps
// nothing of a session on disk. It tells ch-local's daemon, over the
// control channel, a full snapshot of a session's state after every change,
// and its end; the daemon keeps the table in memory and hands it back in
// its 'restore' when the runtime starts again.
//
//   {type: 'session-state', session, state}
//   {type: 'session-gone', session}
//
//   state: exactly {overrides, locks, formsLeft}
//     overrides  the session's own values (lib/session-settings.js), each
//                exactly {name, value, loosening, over, version}
//     locks      its decline locks, as kinds (lib/settings-confirm.js); a
//                latched session's are the three kinds
//     formsLeft  the forms it may still be shown, 0 to 3
//
// Nothing in it is a key, a user's name, a nonce, a pending form or the MAC
// key: a restart strands a form (its state is under a key the new runtime
// does not have), and never carries one over. The shapes are C's
// lib/session-transport/restore.js's and ch-local's session-table's, held by
// the shared restoreRows vectors.
//
// Main thread only, and a shared runtime's sessions only: --stdio's one
// session tells nothing.
const MAX_STATE_BYTES = 64 * 1024;
// what a session that changed nothing would tell: never told
const UNCHANGED = JSON.stringify({overrides: [], locks: [], formsLeft: 3});

const deps = {};
function configure(given = {}) {
  Object.assign(deps, {
    // -> false with no channel (a runtime not started by ch-local's daemon)
    tell: (m) => require('./control-channel').tell(m)
  }, given);
}
configure();

// session -> the state last told, as JSON
const lastTold = new Map();

// -> {overrides, locks, formsLeft}, or null: not a session of a shared
// runtime, or one that has ended
function exportOf(session) {
  const sessions = require('./sessions');
  if (typeof(session) !== 'string' || !sessions.shared() || sessions.get(session) == null) return null;
  const overrides = require('./session-settings').overridesOf(session)
    .map(({name, value, loosening, over, version}) => ({name: name, value: value, loosening: loosening, over: over, version: version}));
  const own = require('./settings-confirm').stateOf(session);
  return {overrides: overrides, locks: own.locks, formsLeft: own.formsLeft};
}

// Something of a session may have changed: its state is told, whole, when
// it is not the one last told. A tell that fails (no channel) stops nothing:
// the change is made, and a restart then finds the session as it was last
// told, or fresh.
function changed(session) {
  const state = exportOf(session);
  if (state == null) return;
  const text = JSON.stringify(state);
  if ((lastTold.has(session) ? lastTold.get(session) : UNCHANGED) === text) return;
  lastTold.set(session, text);
  try { deps.tell({type: 'session-state', session: session, state: state}); } catch (e) { /* no channel now */ }
}

// A session's end (lib/sessions.js close): the daemon drops its row.
function gone(session) {
  if (typeof(session) !== 'string' || !require('./sessions').shared()) return;
  lastTold.delete(session);
  try { deps.tell({type: 'session-gone', session: session}); } catch (e) { /* no channel now */ }
}

// Every change of a session's values, and of its locks and forms, tells.
function attach() {
  require('./session-settings').onChange(changed);
  require('./settings-confirm').onChange(changed);
}

module.exports = {exportOf, changed, gone, attach, configure, MAX_STATE_BYTES,
  resetForTests: () => { lastTold.clear(); configure(); }};

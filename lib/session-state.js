'use strict';
// A session's state across a runtime restart, the runtime's side (the
// shared-runtime design, #236, section 6; B2 Task 6). The runtime keeps
// nothing of a session on disk. It tells ch-local's daemon, over the
// control channel, a full snapshot of a session's state after every change;
// the daemon keeps the table in memory and hands it back in its 'restore'
// when the runtime starts again. (A session's end is told by the registry,
// which knows every session, announced or not: {type: 'session-gone',
// session}, lib/session-transport/registry.js.)
//
//   {type: 'session-state', session, state}
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
// sessions whose restored row is being applied (the import, below)
const restoring = new Set();


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
  // a restored row being applied: told once, at its end, as it then stands
  if (restoring.has(session)) return;
  const state = exportOf(session);
  if (state == null) return;
  const text = JSON.stringify(state);
  if ((lastTold.has(session) ? lastTold.get(session) : UNCHANGED) === text) return;
  lastTold.set(session, text);
  try { deps.tell({type: 'session-state', session: session, state: state}); } catch (e) { /* no channel now */ }
}

// A session's end (lib/sessions.js close): nothing of it is kept here. The
// daemon drops its row on the registry's own session-gone.
function gone(session) {
  lastTold.delete(session);
}

// Every change of a session's values, and of its locks and forms, tells.
function attach() {
  require('./session-settings').onChange(changed);
  require('./settings-confirm').onChange(changed);
}

// ---- the import: the daemon's 'restore' ----------------------------------
//
// The table the daemon kept is handed over once, before the socket listens
// (lib/route-manager.js, after lib/session-transport/restore.js has
// validated it whole): {sessions: [{session, state}], declines: [{kind,
// at}], reset: [session]}. Each row is checked again here, as strictly, and
// one that fails is dropped. Nothing in a row is trusted further than its
// shape:
//
// - a row waits for its session (the shim resumes it after the restart);
//   one whose session the registry forgets first is dropped with it;
// - its locks and forms left are restored as they were (only ever tighter
//   than a fresh session's);
// - a cap's tightening applies as a replay's does: only if it is at least
//   as tight as today's default and the ceiling. One above today's default
//   is not applied at all, marked a loosening or not;
// - a cap's loosening applies only as a fresh one would be let: the
//   session's own client says "ok, yes" now (there is no request to check
//   a client by, so its conditions alone), the ceiling allows it, and
//   today's default is not under the one it was confirmed over. Otherwise
//   it is reset, and the session told to ask again;
// - a pack's override is reset and said: a session has no packs of its own
//   yet (B3);
// - the declines load into the user's window (lib/settings-confirm.js
//   load); a list that fails, or one longer than the window holds, locks
//   every kind; so does no table at all (noRestore).
const SESSION_ID = /^[0-9a-f]{32}$/;
const CAPS = ['maxOutputBytes', 'requestTimeout'];
const KINDS = ['maxOutputBytes', 'requestTimeout', 'pack'];
const PACK = /^pack\.[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/;
const MAX_OVERRIDES = 64;
const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const keysAre = (o, keys) => { const k = Object.keys(o).sort(); return k.length === keys.length && k.every((x, i) => x === keys[i]); };

// -> null, or why a state is not exactly the agreed shape
function stateProblem(state) {
  if (!isObject(state) || !keysAre(state, ['formsLeft', 'locks', 'overrides'])) return 'not exactly {overrides, locks, formsLeft}';
  if (!Array.isArray(state.overrides) || state.overrides.length > MAX_OVERRIDES) return 'overrides';
  const bounds = require('./settings-tool').ALLOWLIST;
  const names = new Set();
  for (const o of state.overrides) {
    if (!isObject(o) || !keysAre(o, ['loosening', 'name', 'over', 'value', 'version']) || typeof(o.loosening) !== 'boolean') return 'an override';
    if (names.has(o.name)) return 'a setting twice';
    names.add(o.name);
    if (CAPS.includes(o.name)) {
      if (!Number.isSafeInteger(o.value) || o.value < bounds[o.name].min || o.value > bounds[o.name].max || o.version !== null) return 'a cap override';
      if (o.loosening ? !(Number.isSafeInteger(o.over) && o.over > 0) : o.over !== null) return 'a cap override\'s over';
    } else if (typeof(o.name) === 'string' && PACK.test(o.name)) {
      if (typeof(o.value) !== 'boolean' || o.over !== null || typeof(o.version) !== 'string' || !VERSION.test(o.version)) return 'a pack override';
    } else {
      return 'an override\'s name';
    }
  }
  if (!Array.isArray(state.locks) || !state.locks.every((k) => KINDS.includes(k)) || new Set(state.locks).size !== state.locks.length) return 'locks';
  if (!Number.isInteger(state.formsLeft) || state.formsLeft < 0 || state.formsLeft > 3) return 'formsLeft';
  let size = Infinity;
  try { size = Buffer.byteLength(JSON.stringify(state)); } catch (e) { /* not JSON */ }
  return size <= MAX_STATE_BYTES ? null : 'over the size a row may be';
}

// session -> {state, reset}: rows waiting for their session
const imported = new Map();
// session -> the promise of its row's being applied
const applying = new Map();
let tableTaken = false;

// a state as exportOf would give it, for comparing with what is told later
const normal = (state) => JSON.stringify({
  overrides: state.overrides.map(({name, value, loosening, over, version}) => ({name: name, value: value, loosening: loosening, over: over, version: version})),
  locks: [...state.locks].sort(),
  formsLeft: state.formsLeft
});

// -> {sessions: n}: the rows kept, waiting for their sessions. Once only: a
// second table, or one after noRestore, changes nothing.
function importTable(table) {
  if (tableTaken) return {sessions: 0};
  if (!isObject(table) || !Array.isArray(table.sessions) || (table.reset !== undefined && !Array.isArray(table.reset))) return {sessions: 0};
  tableTaken = true;
  const reset = new Set((table.reset || []).filter((id) => typeof(id) === 'string'));
  for (const row of table.sessions) {
    if (!isObject(row) || typeof(row.session) !== 'string' || !SESSION_ID.test(row.session) || imported.has(row.session)) continue;
    if (stateProblem(row.state) != null) continue;
    imported.set(row.session, {state: row.state, reset: reset.has(row.session)});
  }
  // what was declined before the restart still counts; a list that cannot
  // be taken locks every kind (load does)
  require('./settings-confirm').userWindow().load(table.declines);
  return {sessions: imported.size};
}

// No table came (the daemon's restore did not arrive in time): what was
// declined before is not known, so every kind is locked for a window, and
// no later table is taken.
function noRestore() {
  tableTaken = true;
  imported.clear();
  require('./settings-confirm').userWindow().lockAll();
}

const pending = () => imported.size;
// the registry forgot a session (lib/sessions.js, on its 'gone')
function dropPending(session) { imported.delete(session); }

// A session is here (lib/sessions.js, at its 'session' event): the row the
// daemon kept for it, if any, is applied.
function resumed(session) {
  const row = imported.get(session);
  if (row == null) return;
  imported.delete(session);
  restoring.add(session);
  const done = restoreInto(session, row).catch(() => {}).then(() => {
    restoring.delete(session);
    applying.delete(session);
    // the daemon's row put right, when what stands differs from it
    changed(session);
  });
  applying.set(session, done);
}
// (tests) when a resumed session's row has been applied
const whenApplied = (session) => applying.get(session) || Promise.resolve();

async function restoreInto(session, row) {
  const sessions = require('./sessions');
  const settings = require('./session-settings');
  const said = [];
  let restored = false;
  // what the daemon holds for it now
  lastTold.set(session, normal(row.state));
  if (row.reset) said.push('your this-session loosenings were reset; ask again');
  if (row.state.locks.length > 0 || row.state.formsLeft < 3) {
    require('./settings-confirm').confirmations(session).restore({locks: row.state.locks, formsLeft: row.state.formsLeft});
    restored = true;
  }
  let timeout = false;
  const loosenings = [];
  for (const o of row.state.overrides) {
    if (!CAPS.includes(o.name)) {
      said.push(`your this-session change of ${o.name} was reset after a runtime restart; ask again`);
    } else if (o.loosening === true) {
      loosenings.push(o);
    } else {
      // as a replay's: at least as tight as the default and the ceiling now
      try {
        if (!settings.isLoosening(session, o.name, o.value) && o.value !== settings.effective(session, o.name)) {
          settings.set(session, o.name, o.value);
          restored = true;
          if (o.name === 'requestTimeout') timeout = true;
        }
      } catch (e) { /* what set would refuse: not applied */ }
    }
  }
  if (timeout) require('./session').rearmSession(session);
  if (loosenings.length > 0) {
    // the session's own client, now (a "no" latches it, as at any ask)
    let may = false;
    try {
      const answer = await sessions.askConditions(session);
      may = answer != null && answer.status === 'ok' && answer.conditions === 'yes';
    } catch (e) { /* no answer */ }
    for (const o of loosenings) {
      let applied = false;
      if (may && sessions.get(session) != null) {
        // set holds it to the ceiling, and refuses it under a ceiling that
        // allows none or over a default that has since been lowered
        try { settings.set(session, o.name, o.value, {loosening: true, over: o.over}); applied = true; } catch (e) { /* reset */ }
      }
      if (applied) restored = true;
      else said.push(`your this-session loosening of ${o.name} was reset after a runtime restart; ask again`);
    }
  }
  if (sessions.get(session) == null) return;
  if (restored) said.push('this session\'s settings were restored after a runtime restart');
  for (const text of said) require('./notices').add(null, text, {session: session, sessionOnly: true});
}

module.exports = {exportOf, changed, gone, attach, configure, importTable, noRestore, pending, dropPending, resumed, whenApplied, stateProblem, MAX_STATE_BYTES,
  resetForTests: () => { lastTold.clear(); imported.clear(); restoring.clear(); applying.clear(); tableTaken = false; configure(); }};

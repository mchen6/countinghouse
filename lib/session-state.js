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
//   state: exactly {overrides, locks, formsLeft}, or those and unanswered
//     overrides  the session's own values (lib/session-settings.js), each
//                exactly {name, value, loosening, over, version}
//     locks      its decline locks, as kinds (lib/settings-confirm.js); a
//                latched session's are all four kinds
//     formsLeft  the forms it may still be shown, 0 to 3
//     unanswered the kinds it has left one form unanswered of (two lock a
//                kind); a form open at the tell counts, so a kind with one
//                unanswered and another open is told as locked. Only when
//                there is one: a state with none is exactly the three keys.
//                A kind is in locks or in unanswered, never both, and
//                unanswered is there only with a form spent (formsLeft
//                under 3)
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
    tell: (m) => require('./control-channel').tell(m),
    // the validators' heap, before a restored raise of the output cap is in
    // force (as before a confirmed one: lib/settings-tool.js)
    growValidators: (bytes) => require('./validator-pool').growFor(bytes)
  }, given);
}
configure();

// session -> the state last told, as JSON
const lastTold = new Map();
// what lastTold holds for a row the daemon has more of than was taken: no
// state's text, so the session's state is always told
const DAEMON_HAS_MORE = '(the daemon holds a pack override this runtime dropped)';
// sessions whose restored row is being applied (the import, below)
const restoring = new Set();


// -> {overrides, locks, formsLeft} (and unanswered, when there is one), or
// null: not a session of a shared
// runtime, or one that has ended
function exportOf(session) {
  const sessions = require('./sessions');
  if (typeof(session) !== 'string' || !sessions.shared() || sessions.get(session) == null) return null;
  // Never a state the import would refuse (one refused row costs that
  // session its state at the next restart, and C's restore refuses the
  // whole table for one): an override outside its shape is left out. The
  // one way to it is a ceiling under the tool's least value, which clamps
  // a stored loosening below it; left out, the session runs at the default
  // under that same ceiling.
  const overrides = require('./session-settings').overridesOf(session)
    .map(({name, value, loosening, over, version}) => ({name: name, value: value, loosening: loosening, over: over, version: version}))
    .filter((o) => overrideProblem(o) == null);
  // as it would stand if the runtime died now (a form open is one never answered)
  const own = require('./settings-confirm').exportedOf(session);
  const state = {overrides: overrides, locks: own.locks, formsLeft: own.formsLeft};
  if (own.unanswered.length > 0) state.unanswered = own.unanswered;
  return state;
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
// - an override names a cap only (M5a, #413 rev 3 section 5.4: a pack's or
//   a module's on/off is never a session's own). restore.js has dropped a
//   well-formed pack override from before M5a (packsDropped: that session is
//   told once, here); a row still naming anything else is not taken;
// - the declines load into the user's window (lib/settings-confirm.js
//   load); a list that fails, or one longer than the window holds, locks
//   every kind; so does no table at all (noRestore).
const SESSION_ID = /^[0-9a-f]{32}$/;
// the two caps, from the one place a session's overrides are kept
const {CAPS} = require('./session-settings');
const KINDS = ['maxOutputBytes', 'requestTimeout', 'enabled', 'module'];
const MAX_OVERRIDES = CAPS.length;   // one per cap (M5a)
const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const keysAre = (o, keys) => { const k = Object.keys(o).sort(); return k.length === keys.length && k.every((x, i) => x === keys[i]); };

// -> null, or why one override is not of the agreed shape
function overrideProblem(o) {
  if (!isObject(o) || !keysAre(o, ['loosening', 'name', 'over', 'value', 'version']) || typeof(o.loosening) !== 'boolean') return 'an override';
  if (CAPS.includes(o.name)) {
    const bounds = require('./settings-tool').ALLOWLIST[o.name];
    if (!Number.isSafeInteger(o.value) || o.value < bounds.min || o.value > bounds.max || o.version !== null) return 'a cap override';
    if (o.loosening ? !(Number.isSafeInteger(o.over) && o.over > 0) : o.over !== null) return 'a cap override\'s over';
    return null;
  }
  return 'an override\'s name';
}

// a list of kinds, each once
const distinctKinds = (list) => Array.isArray(list) && list.every((k) => KINDS.includes(k)) && new Set(list).size === list.length;

// -> null, or why a state is not exactly the agreed shape
function stateProblem(state) {
  if (!isObject(state) || !(keysAre(state, ['formsLeft', 'locks', 'overrides']) || keysAre(state, ['formsLeft', 'locks', 'overrides', 'unanswered']))) return 'not exactly {overrides, locks, formsLeft}, with unanswered or without';

  if (!Array.isArray(state.overrides) || state.overrides.length > MAX_OVERRIDES) return 'overrides';
  const names = new Set();
  for (const o of state.overrides) {
    const problem = overrideProblem(o);
    if (problem != null) return problem;
    if (names.has(o.name)) return 'a setting twice';
    names.add(o.name);
  }
  if (!distinctKinds(state.locks)) return 'locks';
  if (!Number.isInteger(state.formsLeft) || state.formsLeft < 0 || state.formsLeft > 3) return 'formsLeft';
  // a kind is locked or has one form unanswered, never both; and a form
  // left unanswered was a form spent
  if (state.unanswered !== undefined && !(distinctKinds(state.unanswered) && !state.unanswered.some((k) => state.locks.includes(k))
    && (state.unanswered.length === 0 || state.formsLeft < 3))) return 'unanswered';
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
// (as exportOf writes one: unanswered only when there is one)
const normal = (state) => {
  const unanswered = Array.isArray(state.unanswered) ? [...state.unanswered].sort() : [];
  return JSON.stringify(Object.assign({
    overrides: state.overrides.map(({name, value, loosening, over, version}) => ({name: name, value: value, loosening: loosening, over: over, version: version})),
    locks: [...state.locks].sort(),
    formsLeft: state.formsLeft
  }, unanswered.length > 0 ? {unanswered: unanswered} : {}));
};

// -> {sessions: n}: the rows kept, waiting for their sessions. Once only: a
// second table, or one after noRestore, changes nothing.
function importTable(table) {
  if (tableTaken) return {sessions: 0};
  // a table that is no table is as no table at all: what was declined
  // before is not known, so every kind is locked (the caller, C's restore,
  // has validated it whole; this is the second line, and it fails closed)
  if (!isObject(table) || !Array.isArray(table.sessions) || (table.reset !== undefined && !Array.isArray(table.reset))) {
    noRestore();
    return {sessions: 0};
  }
  tableTaken = true;
  const reset = new Set((table.reset || []).filter((id) => typeof(id) === 'string'));
  // the sessions whose own pack override restore.js dropped (one from before
  // M5a): each told once, at its resume
  const packsDropped = new Map((Array.isArray(table.packsDropped) ? table.packsDropped : [])
    .filter((d) => isObject(d) && typeof(d.session) === 'string' && Array.isArray(d.names))
    .map((d) => [d.session, d.names.filter((n) => typeof(n) === 'string')]));
  for (const row of table.sessions) {
    if (!isObject(row) || typeof(row.session) !== 'string' || !SESSION_ID.test(row.session) || imported.has(row.session)) continue;
    if (stateProblem(row.state) != null) continue;
    imported.set(row.session, {state: row.state, reset: reset.has(row.session), packsDropped: packsDropped.get(row.session) || null});
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

// a cap's value as a person reads it: 12MiB, 20s
const MiB = 1024 * 1024;
const shown = (name, v) => (name === 'maxOutputBytes' ? ((v % MiB === 0) ? `${v / MiB}MiB` : `${v}B`) : ((v % 1000 === 0) ? `${v / 1000}s` : `${v}ms`));

async function restoreInto(session, row) {
  const sessions = require('./sessions');
  const settings = require('./session-settings');
  const confirm = require('./settings-confirm');
  const said = [];
  // what was restored, for the history: {name, old, next}
  const recorded = [];
  // What the daemon holds for it: the row, unless something was told for
  // this session since it settled (its client said no at its settle: the
  // latch's tell has replaced the row). So what stands at the end is told
  // whenever it differs from what the daemon really has.
  // (a row restore.js dropped a pack override from is not what the daemon
  // holds: told at the end whatever stands, so the daemon's copy loses it
  // and the next restart neither drops nor tells it again)
  if (!lastTold.has(session)) lastTold.set(session, Array.isArray(row.packsDropped) && row.packsDropped.length > 0 ? DAEMON_HAS_MORE : normal(row.state));
  if (row.reset) said.push('your this-session loosenings were reset; ask again');
  // a pack's on or off is never a session's own now (M5a): one this session
  // had is gone, said once
  if (Array.isArray(row.packsDropped) && row.packsDropped.length > 0) {
    const named = row.packsDropped.slice(0, 8).join(', ') + (row.packsDropped.length > 8 ? ` and ${row.packsDropped.length - 8} more` : '');
    said.push(`tools are turned on and off for all your sessions now: this session's own setting for ${named} was dropped after a runtime restart`);
  }
  const unanswered = Array.isArray(row.state.unanswered) ? row.state.unanswered : [];
  if (row.state.locks.length > 0 || row.state.formsLeft < 3 || unanswered.length > 0) {
    confirm.confirmations(session).restore({locks: row.state.locks, formsLeft: row.state.formsLeft, unanswered: unanswered});
  }
  let timeout = false;
  // a tightening the row holds that can't be applied now (set refuses it: a
  // cap's bounds changed between the export and the restore): the session
  // would run looser in silence, so its shim is told, and refuses it
  let lost = false;
  const loosenings = [];
  // above what the session would run with now (the default, under the
  // ceiling); one that cannot be judged is taken as one
  const looserNow = (o) => { try { return settings.isLoosening(session, o.name, o.value); } catch (e) { return true; } };
  for (const o of row.state.overrides) {
    if (!CAPS.includes(o.name)) {
      // (a guard: importTable has already dropped a row naming anything but
      // a cap, and restore.js refuses the whole table for one, so this is
      // not reached)
      said.push(`your this-session change of ${o.name} was reset after a runtime restart`);
    } else if (o.loosening === true && looserNow(o)) {
      loosenings.push(o);
    } else {
      // (a marked loosening at or under today's default too: confirmed over
      // the session's own lower value, it is a tightening of the default,
      // and needs no client. Reset, it would leave the session looser.)
      // as a replay's: at least as tight as the default and the ceiling now
      try {
        const before = settings.effective(session, o.name);
        // (above the cap's max now, an upgrade having lowered it: looser than
        // anything the session may run at, so already at least as tight)
        const max = (() => { try { return require('./settings-tool').ALLOWLIST[o.name].max; } catch (e) { return null; } })();
        if (Number.isSafeInteger(max) && Number.isSafeInteger(o.value) && o.value > max) continue;
        if (settings.isLoosening(session, o.name, o.value)) {
          said.push(`your this-session ${o.name} of ${shown(o.name, o.value)} was not restored after a runtime restart: the default is lower now`);
        } else if (o.value !== before) {
          settings.set(session, o.name, o.value);
          recorded.push({name: o.name, old: before, next: settings.effective(session, o.name)});
          if (o.name === 'requestTimeout') timeout = true;
        }
      } catch (e) { lost = true; /* what set refuses: not applied, and said to the shim below */ }
    }
  }
  // (said before any wait below, a loosening's ask: the shim refuses the
  // session before it releases a held line)
  if (lost && sessions.get(session) != null) sessions.tighteningsLost(session, 'restore');
  if (timeout) require('./session').rearmSession(session);
  if (loosenings.length > 0) {
    // The session as it stands before the waits below: a change it makes
    // meanwhile wins (its own tightening is not written over), and a lock
    // that falls meanwhile (its client says no: N1's latch) is final.
    const ownOf = (name) => JSON.stringify(settings.overridesOf(session).find((x) => x.name === name) || null);
    const before = new Map(loosenings.map((o) => [o.name, {effective: settings.effective(session, o.name), own: ownOf(o.name)}]));
    const locksBefore = confirm.lockChangesOf(session);
    // the session's own client, now (a "no" latches it, as at any ask)
    let may = false;
    try {
      const answer = await sessions.askConditions(session);
      may = answer != null && answer.status === 'ok' && answer.conditions === 'yes';
    } catch (e) { /* no answer */ }
    for (const o of loosenings) {
      let applied = false;
      if (may) {
        try {
          // a raised output cap: the validators' heap first (a validator
          // with the old heap would crash on the bigger value)
          if (o.name === 'maxOutputBytes') await deps.growValidators(o.value);
          // checked again after the waits, with no wait from here to the
          // override: the session is here, no lock fell on it, and its
          // value is as it was. set then holds it to the ceiling, and
          // refuses it under a ceiling that allows none or over a default
          // that has since been lowered.
          const was = before.get(o.name);
          if (sessions.get(session) != null && confirm.lockChangesOf(session) === locksBefore
            && settings.effective(session, o.name) === was.effective && ownOf(o.name) === was.own) {
            settings.set(session, o.name, o.value, {loosening: true, over: o.over});
            recorded.push({name: o.name, old: was.effective, next: settings.effective(session, o.name)});
            applied = true;
          }
        } catch (e) { /* reset */ }
      }
      if (!applied) {
        // "ask again" only to a session that can: one with a form left and
        // no lock on the kind
        const own = confirm.stateOf(session);
        const canAsk = own.formsLeft > 0 && !own.locks.includes(confirm.kindOf(o.name));
        said.push(`your this-session loosening of ${o.name} was reset after a runtime restart${canAsk ? '; ask again' : ''}`);
      }
    }
  }
  if (sessions.get(session) == null) return;
  if (recorded.length > 0) {
    // in the history as what it is, and said once; restrictions alone
    // (locks, forms left) are no setting of the session's, and are not said
    require('./settings-tool').recordReplayed(session, recorded, {by: 'restore', change: 'this session (restored after a restart)'});
    said.push('this session\'s settings were restored after a runtime restart');
  }
  for (const text of said) require('./notices').add(null, text, {session: session, sessionOnly: true});
}

module.exports = {exportOf, changed, gone, attach, configure, importTable, noRestore, pending, dropPending, resumed, whenApplied, stateProblem, overrideProblem, MAX_STATE_BYTES,
  resetForTests: () => { lastTold.clear(); imported.clear(); restoring.clear(); applying.clear(); tableTaken = false; configure(); }};

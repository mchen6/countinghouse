'use strict';
// ch-local daemon's 'restore' on the shared runtime (countinghouse's
// shared-runtime design, #236, section 6; the review of #255): the session
// table the daemon kept, handed to this runtime once, before it listens.
//
//   {id, type: 'restore', sessions: [{session, resume, state}], declines: [{kind, at}], reset: [session]}
//
// - Once only: a second restore, or one after the safety net fired or the
//   listen began (close()), is refused CONTROL_RESTORE_DONE.
// - Validated whole, never trusted to lib/sessions.js: the exact keys; at
//   most the listener's MAX_SESSIONS sessions, each a registry id (32 hex),
//   no id twice, with its resume hash (64 lowercase hex) and a state of B2's exact shape (#252 rev 2), at most
//   64 KiB as JSON:
//     overrides: at most one per cap (two), each exactly
//       {name, value, loosening, over, version}: a cap (maxOutputBytes,
//       requestTimeout) with a positive integer value, `over` the default a
//       loosening was confirmed over (else null) and version null. Nothing
//       else: a pack's or a module's on/off is never a session's own (M5a,
//       #413 rev 3 section 5.4). A well-formed pack.<n> override from before
//       M5a (a boolean value, over null, a semver version) is DROPPED from
//       its row, the rest of the row kept and its session told once
//       (lib/session-state.js); any other pack.<n> override refuses;
//     locks: distinct kinds; formsLeft: an integer 0 to 3;
//     unanswered (B2's, optional: there only when there is one): distinct
//       kinds, none of them in locks, and only with formsLeft under 3;
//   at most MAX_DECLINES declines, each exactly {kind, at}, at a
//   non-negative integer of epoch ms no later than a minute from now.
//   A kind is maxOutputBytes, requestTimeout, enabled or module. A table
//   written under a runtime before M5b holds the kind pack: it is taken as
//   enabled, per row (locks, unanswered) and per decline, deduped (a kind
//   locked and unanswered stays locked), so the session's tightenings stay;
//   said once (#449's high review, 2). A row whose locks or unanswered name
//   another kind this runtime has none of (a name of a kind's shape) is
//   dropped alone, and so is such a decline; said once. Anything else is
//   refused CONTROL_BAD_RESTORE, nothing is imported, and a good restore may
//   still come.
const {MAX_SESSIONS} = require('./listener');

const MAX_STATE_BYTES = 64 * 1024;
const MAX_DECLINES = 1024;
const SESSION_ID = /^[0-9a-f]{32}$/;
// SHA-256 of the session's current resume token (registry.js)
const RESUME = /^[0-9a-f]{64}$/;
const STATE_KEYS = ['formsLeft', 'locks', 'overrides'];
const KINDS = ['maxOutputBytes', 'requestTimeout', 'enabled', 'module'];
// what a kind of another runtime may look like: a row naming one is dropped
// alone; anything else in a kind's place refuses
const KIND_SHAPE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const unknownKind = (k) => typeof(k) === 'string' && KIND_SHAPE.test(k) && !KINDS.includes(k);
// the kind before M5b, and the one it is now
const OLD_KIND = 'pack';
const NEW_KIND = 'enabled';
const asNow = (k) => (k === OLD_KIND ? NEW_KIND : k);
// the two caps, from the one place a session's overrides are kept (#438's
// medium review: no hand copy to drift)
const {CAPS} = require('../session-settings');
// the settings tool's own bounds (lib/settings-tool.js ALLOWLIST), as B2
// keeps them, read from it so the two never drift
const CAP_BOUNDS = (() => {
  const {ALLOWLIST} = require('../settings-tool');
  return Object.fromEntries(CAPS.map((c) => [c, [ALLOWLIST[c].min, ALLOWLIST[c].max]]));
})();
const MAX_OVERRIDES = CAPS.length;   // one per cap (M5a)
// a session's own pack override as the runtime before M5a exported it
const STALE_PACK = /^pack\.([a-z0-9][a-z0-9-]{0,63})$/;
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/;
const stalePack = (o) => isObject(o) && keysAre(o, ['loosening', 'name', 'over', 'value', 'version']) && typeof(o.name) === 'string' && STALE_PACK.test(o.name)
  && typeof(o.value) === 'boolean' && typeof(o.loosening) === 'boolean' && o.over === null && typeof(o.version) === 'string' && VERSION.test(o.version);
const posInt = (v) => Number.isSafeInteger(v) && v > 0;

function overrideProblem(o) {
  if (!isObject(o) || !keysAre(o, ['loosening', 'name', 'over', 'value', 'version'])) return 'an override is not exactly {name, value, loosening, over, version}';
  if (typeof(o.loosening) !== 'boolean') return 'an override\'s loosening is not a boolean';
  if (CAPS.includes(o.name)) {
    const [lo, hi] = CAP_BOUNDS[o.name];
    if (!Number.isSafeInteger(o.value) || o.value < lo || o.value > hi) return `a cap override's value is not within ${lo} to ${hi}`;
    if (o.version !== null) return 'a cap override has a version';
    if (o.loosening ? !posInt(o.over) : o.over !== null) return 'a cap override\'s over does not fit its loosening';
    return null;
  }
  return 'an override names no cap (maxOutputBytes, requestTimeout)';
}

// a list of kinds, each once
// (extra: kinds of another runtime, taken as kinds to check a row that is
// dropped for naming them)
const distinctKinds = (list, extra = []) => Array.isArray(list) && list.every((k) => KINDS.includes(k) || extra.includes(k)) && new Set(list).size === list.length;

// the kind pack taken as enabled in one row's state: a list as sent, each
// kind once (else left for stateProblem to refuse), mapped and deduped; a
// kind both locked and unanswered after it stays locked. Returns the state
// as taken and whether anything was mapped.
const distinctAsSent = (list) => Array.isArray(list) && new Set(list).size === list.length;
function mapOldKind(st) {
  if (!isObject(st)) return {state: st, mapped: false};
  const hasOld = (list) => distinctAsSent(list) && list.includes(OLD_KIND);
  if (!hasOld(st.locks) && !hasOld(st.unanswered)) return {state: st, mapped: false};
  const dedupe = (list) => list.map(asNow).filter((k, i, all) => all.indexOf(k) === i);
  const state = Object.assign({}, st);
  if (hasOld(st.locks)) state.locks = dedupe(st.locks);
  if (hasOld(st.unanswered)) {
    state.unanswered = dedupe(st.unanswered);
    if (Array.isArray(state.locks) && state.locks.includes(NEW_KIND)) state.unanswered = state.unanswered.filter((k) => k !== NEW_KIND);
  }
  return {state, mapped: true};
}

function stateProblem(st, extra = []) {
  // B2's unanswered (lib/session-state.js): the distinct kinds the session
  // has left one form unanswered of. There only when there is one; a state
  // with none is exactly the three keys.
  if (!isObject(st) || !(keysAre(st, STATE_KEYS) || keysAre(st, STATE_KEYS.concat('unanswered')))) return 'a state is not exactly {overrides, locks, formsLeft}, with unanswered or without';

  if (!Array.isArray(st.overrides) || st.overrides.length > MAX_OVERRIDES) return `overrides is not a list of at most ${MAX_OVERRIDES}`;
  const names = new Set();
  for (const o of st.overrides) {
    const p = overrideProblem(o);
    if (p != null) return p;
    if (names.has(o.name)) return 'an override names a setting twice';
    names.add(o.name);
  }
  if (!distinctKinds(st.locks, extra)) return 'locks is not a list of distinct kinds';
  if (!Number.isInteger(st.formsLeft) || st.formsLeft < 0 || st.formsLeft > 3) return 'formsLeft is not an integer from 0 to 3';
  // a kind is locked or has one form unanswered, never both; and a form
  // left unanswered was a form spent
  if (st.unanswered !== undefined && !(distinctKinds(st.unanswered, extra) && !st.unanswered.some((k) => st.locks.includes(k))
    && (st.unanswered.length === 0 || st.formsLeft < 3))) return 'unanswered is not distinct kinds, none of them locked, with a form spent';
  return null;
}

const refuse = (code, message) => Object.assign(new Error(message), {code});
const bad = (why) => refuse('CONTROL_BAD_RESTORE', `the restore was refused: ${why}`);
const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const keysAre = (o, keys) => { const k = Object.keys(o).sort(); return k.length === keys.length && k.every((x, i) => x === keys[i]); };

function validate(msg) {
  if (!isObject(msg) || !keysAre(msg, ['declines', 'id', 'reset', 'sessions', 'type'])) throw bad('its keys are not id, type, sessions, declines and reset');
  const {sessions, declines, reset} = msg;
  if (!Array.isArray(sessions) || sessions.length > MAX_SESSIONS) throw bad(`sessions is not a list of at most ${MAX_SESSIONS}`);
  if (!Array.isArray(declines) || declines.length > MAX_DECLINES) throw bad(`declines is not a list of at most ${MAX_DECLINES}`);
  const seen = new Set();
  const hashes = new Set();
  // the rows as taken: a stale pack override dropped (one session's, never
  // the table's fault); packsDropped: [{session, names}], each told once
  const taken = [];
  const packsDropped = [];
  // kindsMapped: how many rows and declines held the kind pack; rowsDropped:
  // [{session, kinds}], the rows naming a kind this runtime has none of
  let kindsMapped = 0;
  const rowsDropped = [];
  for (const given of sessions) {
    let row = given;
    // the bounds hold for what the daemon sent, before anything is dropped:
    // its size, and each name once
    if (isObject(row) && isObject(row.state)) {
      let sent = Infinity;
      try { sent = Buffer.byteLength(JSON.stringify(row.state)); } catch (e) { /* not JSON */ }
      if (!(sent <= MAX_STATE_BYTES)) throw bad(`a state is over ${MAX_STATE_BYTES} bytes`);
      if (Array.isArray(row.state.overrides)) {
        const names = row.state.overrides.map((o) => (isObject(o) ? o.name : undefined)).filter((n) => typeof(n) === 'string');
        if (new Set(names).size !== names.length) throw bad('an override names a setting twice');
      }
    }
    if (isObject(row) && isObject(row.state) && Array.isArray(row.state.overrides) && row.state.overrides.some(stalePack)) {
      const names = row.state.overrides.filter(stalePack).map((o) => STALE_PACK.exec(o.name)[1]);
      row = Object.assign({}, row, {state: Object.assign({}, row.state, {overrides: row.state.overrides.filter((o) => !stalePack(o))})});
      if (typeof(row.session) === 'string') packsDropped.push({session: row.session, names});
    }
    if (!isObject(row) || !keysAre(row, ['resume', 'session', 'state'])) throw bad('a session row is not exactly {session, resume, state}');
    if (typeof(row.resume) !== 'string' || !RESUME.test(row.resume)) throw bad('a resume hash is not 64 lowercase hex characters');
    if (typeof(row.session) !== 'string' || !SESSION_ID.test(row.session)) throw bad('a session id is not 32 hex characters');
    if (seen.has(row.session)) throw bad('a session is named twice');
    seen.add(row.session);
    if (hashes.has(row.resume)) throw bad('two sessions share a resume hash');
    hashes.add(row.resume);
    const asMapped = mapOldKind(row.state);
    // a kind of another runtime: this row alone is dropped, when nothing
    // else in it refuses (checked with the kinds it names taken as known)
    const unknown = [].concat(Array.isArray(asMapped.state.locks) ? asMapped.state.locks : [], Array.isArray(asMapped.state.unanswered) ? asMapped.state.unanswered : [])
      .filter(unknownKind).filter((k, i, all) => all.indexOf(k) === i);
    if (unknown.length > 0) {
      const problem = stateProblem(asMapped.state, unknown);
      if (problem != null) throw bad(problem);
      rowsDropped.push({session: row.session, kinds: unknown});
      continue;
    }
    if (asMapped.mapped) {
      row = Object.assign({}, row, {state: asMapped.state});
      kindsMapped++;
    }
    const st = row.state;
    const problem = stateProblem(st);
    if (problem != null) throw bad(problem);
    taken.push(row);
    let size = Infinity;
    try { size = Buffer.byteLength(JSON.stringify(st)); } catch (e) { /* not JSON */ }
    if (!(size <= MAX_STATE_BYTES)) throw bad(`a state is over ${MAX_STATE_BYTES} bytes`);
  }
  // the sessions that lost loosenings in a handoff (B2 tells each so): each
  // one of the rows, once
  if (!Array.isArray(reset) || reset.length > sessions.length) throw bad('reset is not a list of the restored sessions');
  const resetSeen = new Set();
  for (const id of reset) {
    if (typeof(id) !== 'string' || !seen.has(id) || resetSeen.has(id)) throw bad('reset names a session not restored, or one twice');
    resetSeen.add(id);
  }
  // a decline of the kind pack is one of enabled; one of a kind this runtime
  // has none of is dropped alone
  const declinesTaken = [];
  let declinesDropped = 0;
  for (const d of declines) {
    if (!isObject(d) || !keysAre(d, ['at', 'kind'])) throw bad('a decline is not exactly {kind, at}');
    if (!KINDS.includes(d.kind) && d.kind !== OLD_KIND && !unknownKind(d.kind)) throw bad(`a decline's kind is not one of ${KINDS.join(', ')}`);
    // epoch ms, never in the future (a minute's slack): a future `at` would
    // keep a kind locked for good
    if (!Number.isSafeInteger(d.at) || d.at < 0 || d.at > Date.now() + 60000) throw bad('a decline\'s at is not a past time in epoch ms');
    if (d.kind === OLD_KIND) {
      declinesTaken.push({kind: NEW_KIND, at: d.at});
      kindsMapped++;
    } else if (unknownKind(d.kind)) declinesDropped++;
    else declinesTaken.push(d);
  }
  // reset names the rows taken (a dropped row's session is not restored)
  const takenIds = new Set(taken.map((r) => r.session));
  return {sessions: taken, declines: declinesTaken, reset: reset.filter((id) => takenIds.has(id)), packsDropped,
    kindsMapped, rowsDropped, declinesDropped};
}

// importTable: B2's lib/sessions.js importTable, when it exists
// what a restore took other than as sent, in one line (null: nothing)
function saidOnce(table) {
  const parts = [];
  if (table.kindsMapped > 0) parts.push(`took the kind ${OLD_KIND} as ${NEW_KIND} in ${table.kindsMapped} rows and declines (a table from a runtime before M5b)`);
  if (table.rowsDropped.length > 0) {
    const kinds = [...new Set([].concat(...table.rowsDropped.map((d) => d.kinds)))];
    parts.push(`dropped ${table.rowsDropped.length} sessions naming a kind this runtime has none of (${kinds.slice(0, 8).join(', ')}${kinds.length > 8 ? ', …' : ''})`);
  }
  if (table.declinesDropped > 0) parts.push(`dropped ${table.declinesDropped} declines of such a kind`);
  return parts.length > 0 ? `ch-local daemon's restore: ${parts.join('; ')}` : null;
}

// importTable: B2's lib/sessions.js importTable, when it exists; log: where
// the restore says once what it took other than as sent
function createRestore({importTable = null, log = null} = {}) {
  let isDone = false;
  return {
    handle(msg) {
      if (isDone) throw refuse('CONTROL_RESTORE_DONE', 'the session table was already restored, or the runtime is listening');
      const table = validate(msg);
      isDone = true;
      const said = saidOnce(table);
      if (said != null && typeof(log) === 'function') log(said);
      if (typeof(importTable) === 'function') importTable(table);
      return {sessions: table.sessions.length};
    },
    // the safety net fired, or the listen began: no restore after this
    close() { isDone = true; },
    done: () => isDone
  };
}

module.exports = {createRestore, validate, MAX_STATE_BYTES, MAX_DECLINES};

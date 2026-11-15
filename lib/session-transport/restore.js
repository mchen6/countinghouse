'use strict';
// ch-local daemon's 'restore' on the shared runtime (countinghouse's
// shared-runtime design, #236, section 6; the review of #255): the session
// table the daemon kept, handed to this runtime once, before it listens.
//
//   {id, type: 'restore', sessions: [{session, resume, state}], declines: [{kind, at}]}
//
// - Once only: a second restore, or one after the safety net fired or the
//   listen began (close()), is refused CONTROL_RESTORE_DONE.
// - Validated whole, never trusted to lib/sessions.js: the exact keys; at
//   most the listener's MAX_SESSIONS sessions, each a registry id (32 hex),
//   no id twice, with its resume hash (64 lowercase hex) and a state of B2's exact shape (#252 rev 2), at most
//   64 KiB as JSON:
//     overrides: at most 64, one per name, each exactly
//       {name, value, loosening, over, version}: a cap (maxOutputBytes,
//       requestTimeout) with a positive integer value, `over` the default a
//       loosening was confirmed over (else null) and version null; or
//       pack.<n> with a boolean value, over null and a plain version;
//     locks: distinct kinds; formsLeft: an integer 0 to 3;
//   at most MAX_DECLINES declines, each exactly {kind, at}, at a
//   non-negative integer of epoch ms no later than a minute from now.
//   A kind is maxOutputBytes, requestTimeout or pack. Anything else is
//   refused CONTROL_BAD_RESTORE, nothing is imported, and a good restore may
//   still come.
const {MAX_SESSIONS} = require('./listener');

const MAX_STATE_BYTES = 64 * 1024;
const MAX_DECLINES = 1024;
const SESSION_ID = /^[0-9a-f]{32}$/;
// SHA-256 of the session's current resume token (registry.js)
const RESUME = /^[0-9a-f]{64}$/;
const STATE_KEYS = ['formsLeft', 'locks', 'overrides'];
const KINDS = ['maxOutputBytes', 'requestTimeout', 'pack'];
const CAPS = ['maxOutputBytes', 'requestTimeout'];
const PACK = /^pack\.[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/;
const MAX_OVERRIDES = 64;
const posInt = (v) => Number.isSafeInteger(v) && v > 0;

function overrideProblem(o) {
  if (!isObject(o) || !keysAre(o, ['loosening', 'name', 'over', 'value', 'version'])) return 'an override is not exactly {name, value, loosening, over, version}';
  if (typeof(o.loosening) !== 'boolean') return 'an override\'s loosening is not a boolean';
  if (CAPS.includes(o.name)) {
    if (!posInt(o.value)) return 'a cap override\'s value is not a positive integer';
    if (o.version !== null) return 'a cap override has a version';
    if (o.loosening ? !posInt(o.over) : o.over !== null) return 'a cap override\'s over does not fit its loosening';
    return null;
  }
  if (typeof(o.name) === 'string' && PACK.test(o.name)) {
    if (typeof(o.value) !== 'boolean') return 'a pack override\'s value is not a boolean';
    if (o.over !== null) return 'a pack override has an over';
    if (typeof(o.version) !== 'string' || !VERSION.test(o.version)) return 'a pack override\'s version is not a plain version';
    return null;
  }
  return 'an override names neither a cap nor pack.<n>';
}

function stateProblem(st) {
  if (!isObject(st) || !keysAre(st, STATE_KEYS)) return 'a state is not exactly {overrides, locks, formsLeft}';
  if (!Array.isArray(st.overrides) || st.overrides.length > MAX_OVERRIDES) return `overrides is not a list of at most ${MAX_OVERRIDES}`;
  const names = new Set();
  for (const o of st.overrides) {
    const p = overrideProblem(o);
    if (p != null) return p;
    if (names.has(o.name)) return 'an override names a setting twice';
    names.add(o.name);
  }
  if (!Array.isArray(st.locks) || !st.locks.every((k) => KINDS.includes(k)) || new Set(st.locks).size !== st.locks.length) return 'locks is not a list of distinct kinds';
  if (!Number.isInteger(st.formsLeft) || st.formsLeft < 0 || st.formsLeft > 3) return 'formsLeft is not an integer from 0 to 3';
  return null;
}

const refuse = (code, message) => Object.assign(new Error(message), {code});
const bad = (why) => refuse('CONTROL_BAD_RESTORE', `the restore was refused: ${why}`);
const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const keysAre = (o, keys) => { const k = Object.keys(o).sort(); return k.length === keys.length && k.every((x, i) => x === keys[i]); };

function validate(msg) {
  if (!isObject(msg) || !keysAre(msg, ['declines', 'id', 'sessions', 'type'])) throw bad('its keys are not id, type, sessions and declines');
  const {sessions, declines} = msg;
  if (!Array.isArray(sessions) || sessions.length > MAX_SESSIONS) throw bad(`sessions is not a list of at most ${MAX_SESSIONS}`);
  if (!Array.isArray(declines) || declines.length > MAX_DECLINES) throw bad(`declines is not a list of at most ${MAX_DECLINES}`);
  const seen = new Set();
  const hashes = new Set();
  for (const row of sessions) {
    if (!isObject(row) || !keysAre(row, ['resume', 'session', 'state'])) throw bad('a session row is not exactly {session, resume, state}');
    if (typeof(row.resume) !== 'string' || !RESUME.test(row.resume)) throw bad('a resume hash is not 64 lowercase hex characters');
    if (typeof(row.session) !== 'string' || !SESSION_ID.test(row.session)) throw bad('a session id is not 32 hex characters');
    if (seen.has(row.session)) throw bad('a session is named twice');
    seen.add(row.session);
    if (hashes.has(row.resume)) throw bad('two sessions share a resume hash');
    hashes.add(row.resume);
    const st = row.state;
    const problem = stateProblem(st);
    if (problem != null) throw bad(problem);
    let size = Infinity;
    try { size = Buffer.byteLength(JSON.stringify(st)); } catch (e) { /* not JSON */ }
    if (!(size <= MAX_STATE_BYTES)) throw bad(`a state is over ${MAX_STATE_BYTES} bytes`);
  }
  for (const d of declines) {
    if (!isObject(d) || !keysAre(d, ['at', 'kind'])) throw bad('a decline is not exactly {kind, at}');
    if (!KINDS.includes(d.kind)) throw bad('a decline\'s kind is not maxOutputBytes, requestTimeout or pack');
    // epoch ms, never in the future (a minute's slack): a future `at` would
    // keep a kind locked for good
    if (!Number.isSafeInteger(d.at) || d.at < 0 || d.at > Date.now() + 60000) throw bad('a decline\'s at is not a past time in epoch ms');
  }
  return {sessions, declines};
}

// importTable: B2's lib/sessions.js importTable, when it exists
function createRestore({importTable = null} = {}) {
  let isDone = false;
  return {
    handle(msg) {
      if (isDone) throw refuse('CONTROL_RESTORE_DONE', 'the session table was already restored, or the runtime is listening');
      const table = validate(msg);
      isDone = true;
      if (typeof(importTable) === 'function') importTable(table);
      return {sessions: table.sessions.length};
    },
    // the safety net fired, or the listen began: no restore after this
    close() { isDone = true; },
    done: () => isDone
  };
}

module.exports = {createRestore, validate, MAX_STATE_BYTES, MAX_DECLINES};

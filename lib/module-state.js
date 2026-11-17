'use strict';
// A module's state declaration (shared-runtime design #236, section 4a; R1).
// In its package.json: "countinghouse": {"state": "per-session"}. Absent, or
// "shared", means shared: one worker for every caller, as always. A module
// that keeps state per session gets, on the shared runtime, a worker of its
// own per session and its store and files partitioned by session (later R1
// tasks). Anything else refuses the load, naming the value.
//
// Where it applies (the profile):
// - the shared runtime (--sessionSocket): as declared;
// - --stdio: one session, no partition: a per-session module runs as a shared
//   one, on today's paths;
// - the HTTP hosting profile (neither): no sessions, many users, so a
//   per-session module's load is refused MODULE_NEEDS_SESSIONS.
//
// The main thread reads it from the package.json it pins (lib/manifest-pins.js
// keeps the whole file in memory: a supervised restart keeps the pin), never
// from what a worker says. A reload or an operator's restart that changes it
// is refused MODULE_STATE_CHANGED before anything is unloaded: a running
// module's workers and partitions can't change shape in place.
const {CountinghouseError} = require('./countinghouse-error');

const STATES = Object.freeze(['shared', 'per-session']);

// the declared value as given (undefined when absent)
const declared = (pkg) => (pkg != null && typeof(pkg) === 'object' && pkg.countinghouse != null && typeof(pkg.countinghouse) === 'object')
  ? pkg.countinghouse.state : undefined;

// a declared value as said in an error: JSON, cut short
const shown = (v) => {
  let s;
  try { s = JSON.stringify(v); } catch (e) { s = typeof(v); }
  if (typeof(s) !== 'string') s = typeof(v);
  return s.length > 64 ? `${s.slice(0, 64)}…` : s;
};

// -> 'shared' | 'per-session'; throws MODULE_STATE_INVALID for any other value
function stateOf(pkg, name) {
  const v = declared(pkg);
  if (v === undefined || v === 'shared') return 'shared';
  if (v === 'per-session') return 'per-session';
  throw CountinghouseError.withFields('MODULE_STATE_INVALID', {module: String(name), value: shown(v)});
}

// -> 'shared' | 'stdio' | 'http': where the runtime serves
function profileOf(options) {
  if (options != null && options.sessionSocket != null) return 'shared';
  if (options != null && options.stdio === true) return 'stdio';
  return 'http';
}

// The load's refusal, or null: an invalid value, or a per-session module on
// the HTTP profile.
function stateProblem(pkg, name, options) {
  let state;
  try {
    state = stateOf(pkg, name);
  } catch (e) {
    return e;
  }
  if (state === 'per-session' && profileOf(options) === 'http') return CountinghouseError.withFields('MODULE_NEEDS_SESSIONS', {module: String(name)});
  return null;
}

// A reload's or an operator restart's refusal when the state the module was
// loaded with (`loaded`, its pin) differs from the one it would take
// (`next`), or null. An invalid value on either side is stateProblem's to say.
function stateChanged(loaded, next, name) {
  let from;
  let to;
  try {
    from = stateOf(loaded, name);
    to = stateOf(next, name);
  } catch (e) {
    return null;
  }
  return from === to ? null : CountinghouseError.withFields('MODULE_STATE_CHANGED', {module: String(name), from, to});
}

// Whether module `name` keeps state per session where it runs now: declared
// so in its pin, on the shared runtime. False under --stdio (no partition).
function isPerSession(pkg, name, options) {
  if (profileOf(options) !== 'shared') return false;
  try { return stateOf(pkg, name) === 'per-session'; } catch (e) { return false; }
}

module.exports = {STATES, stateOf, profileOf, stateProblem, stateChanged, isPerSession};

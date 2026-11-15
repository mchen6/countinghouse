'use strict';
// Each session's own settings (the shared runtime, B2 Task 1:
// docs/superpowers/plans/2026-11-15-shared-runtime-b2-session-settings.md;
// the design, #236 section 3). Every change made in conversation in shared
// mode is the session's override, for that session's calls only, for the
// session's life; conversation never writes settings.json there. Main
// thread only; nothing here reaches a worker or a file.
//
// A session's effective value:
//   - a cap (maxOutputBytes, requestTimeout): the tighter of the ceiling and
//     the override, else of the ceiling and the global default. A ceiling
//     that cannot be trusted, or is not known at this read (the settings
//     tool's cache stale: never a file read on a call's path), bounds a cap
//     at the default: a loosening then waits, a tightening holds;
//   - a pack (pack.<name>): the override, else the global value.
// What counts as a loosening is judged against that value, not the default
// (so raising a session-tightened value back toward the default, and
// un-hiding a pack the session turned off, are loosenings). A terminal
// tightening drops every override looser than the new default (dropLooser).
//
// An override is stored clamped to the ceiling at the moment it is set, so a
// ceiling lowered and raised again never brings back a looser value (#252's
// review, 9); and only a live session's is set.
//
// The ceiling, the defaults, the packs' global values and liveness are given
// (configure); by default the settings tool's cached ceiling, the options and
// lib/sessions.js. locale is the terminal's only.
const {CountinghouseError} = require('./countinghouse-error');

const CAPS = ['maxOutputBytes', 'requestTimeout'];
const PACK = /^pack\.([a-z0-9][a-z0-9-]{0,63})$/;

const overrides = new Map();   // session id -> Map(name -> value)

const deps = {};
function defaultDeps() {
  return {
    // the cache only: a call's path never reads the file (or, on Windows,
    // spawns PowerShell); undefined when it is stale
    ceiling: () => require('./settings-tool').cachedCeiling(() => require('./settings-ceiling').readCeiling(), {cacheOnly: true}),
    defaultOf: (name) => require('./cli-options')[name],
    globalPack: () => null,
    isLive: (id) => require('./sessions').get(id) != null
  };
}
function configure(given = {}) {
  Object.assign(deps, defaultDeps(), given);
}
configure();

const isId = (v) => typeof(v) === 'string' && v.length > 0 && v.length <= 200;
const positiveInteger = (v) => Number.isInteger(v) && v > 0;

// the bound a ceiling puts on a cap: a number, Infinity (none), or null (one
// that bounds it at the default)
function ceilingOf(name) {
  const c = deps.ceiling();
  if (c != null && c.state === 'none') return Infinity;
  if (c != null && c.state === 'trusted') return (c.ceiling != null && positiveInteger(c.ceiling[name])) ? c.ceiling[name] : Infinity;
  return null;
}

function effective(id, name) {
  const own = overrides.get(id);
  const value = own != null && own.has(name) ? own.get(name) : undefined;
  if (PACK.test(name)) return value !== undefined ? value : deps.globalPack(name);
  const def = deps.defaultOf(name);
  const bound = ceilingOf(name);
  if (value === undefined) return bound == null ? def : Math.min(def, bound);
  return Math.min(value, bound == null ? def : bound);
}

function isLoosening(id, name, value) {
  const now = effective(id, name);
  if (PACK.test(name)) return value === true && now !== true;
  return value > now;
}

function checked(id, name, value) {
  if (!isId(id)) throw new Error('session-settings: a session is its id');
  if (!deps.isLive(id)) throw new Error('session-settings: a session that has ended (or never settled) sets nothing');
  if (name === 'locale') {
    throw CountinghouseError.withFields('SETTING_TERMINAL_ONLY_SHARED', {name: 'locale', command: `ch-local settings set locale ${String(value).slice(0, 40)}`});
  }
  const cap = CAPS.includes(name);
  if (!cap && !PACK.test(String(name))) throw CountinghouseError.withFields('SETTING_UNKNOWN', {name: String(name).slice(0, 80)});
  if (cap ? !positiveInteger(value) : typeof(value) !== 'boolean') {
    throw CountinghouseError.withFields('SETTING_OUT_OF_BOUNDS', {name: name, value: String(value).slice(0, 80), bounds: cap ? 'a positive whole number' : 'on or off'});
  }
}

// -> {old, new}: the session's effective value before and after
function set(id, name, value) {
  checked(id, name, value);
  const old = effective(id, name);
  // a cap is kept as the ceiling bounds it now: never looser than that later
  let kept = value;
  if (CAPS.includes(name)) {
    const bound = ceilingOf(name);
    kept = Math.min(value, bound == null ? deps.defaultOf(name) : bound);
  }
  if (!overrides.has(id)) overrides.set(id, new Map());
  overrides.get(id).set(name, kept);
  return {old, new: effective(id, name)};
}

// the session's caps for a call: frozen, or null when it has no cap override
function limitsOf(id) {
  const own = overrides.get(id);
  if (own == null || !CAPS.some((c) => own.has(c))) return null;
  return Object.freeze({maxOutputBytes: effective(id, 'maxOutputBytes'), requestTimeout: effective(id, 'requestTimeout')});
}

// A terminal tightening of `name` to newDefault: every override looser than
// it is dropped. -> the ids whose override was.
function dropLooser(name, newDefault) {
  const dropped = [];
  for (const [id, own] of overrides) {
    if (own.has(name) && own.get(name) > newDefault) {
      own.delete(name);
      if (own.size === 0) overrides.delete(id);
      dropped.push(id);
    }
  }
  return dropped;
}

function forget(id) { overrides.delete(id); }

module.exports = {configure, set, effective, isLoosening, limitsOf, dropLooser, forget,
  resetForTests: () => { overrides.clear(); configure(); }};

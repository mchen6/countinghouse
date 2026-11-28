'use strict';
// Each session's own settings (the shared runtime, B2 Task 1:
// docs/superpowers/plans/2026-11-15-shared-runtime-b2-session-settings.md;
// the design, #236 section 3). Every change made in conversation in shared
// mode is the session's override, for that session's calls only, for the
// session's life; conversation never writes settings.json there. Main
// thread only; nothing here reaches a worker or a file.
//
// An override names one of the two caps (M5a, #413 rev 3 section 5.4: a
// pack's or a module's on/off is never a session's own). It is {value,
// loosening, over, version}, the shape a session's export carries (Task 6)
// and the daemon validates (C's #255), version always null:
//   - its value is a safe integer within the settings tool's own bounds;
//   - loosening: true only for a value its session confirmed above the then
//     global default, `over` (Task 5). Any other override is a tightening,
//     held to the default as well: it never lets a session above it.
//
// A loosening is stored at most at the ceiling in force when it is set, and
// is refused while there's no usable one (untrusted, not known, forbidding
// it, or conversation off); its `over` is the default in force, never above.
//
// A session's effective value:
//   - a cap: the override, bounded by the ceiling (and an unmarked one by
//     the default too), else the tighter of the ceiling and the default. A
//     ceiling that can't be trusted, one not known at this read (the
//     settings tool's cache, never a file read on a call's path), one that
//     forbids the setting or turns conversation off, bounds it at the
//     default; a loosening confirmed over a default since lowered is bounded
//     by the default (a terminal tightening also drops it: dropLooser).
//     A read only bounds: the store changes only when a changed ceiling is
//     actually seen (ceilingSeen: by any read, or by the settings tool's
//     re-read), and then every session's stored loosenings are clamped to
//     it, idle ones included, so a ceiling lowered and raised again never
//     brings a value back (#268's re-check, a). A stale or unknown ceiling
//     changes nothing stored.
// What counts as a loosening is judged against that effective value (so
// raising a session-tightened value back toward the default is one, here).
// The settings tool lets a session undo its own lowering in conversation,
// with no form, up to what a session with no value of its own runs at
// (underCeiling), under the ceiling's rules (lib/settings-tool.js
// setForSession; the dry run, walk step 15a).
//
// Bad input throws: the store never guesses. The ceiling, the defaults, the
// bounds and liveness are given (configure); by
// default the settings tool's cached ceiling and allowlist, the options and
// lib/sessions.js. onChange(fn) hears every
// change of a session's overrides (Task 6's export).
const {CountinghouseError} = require('./countinghouse-error');

const CAPS = ['maxOutputBytes', 'requestTimeout'];
const ID = /^[0-9a-f]{32}$/;
const MAX_OVERRIDES = CAPS.length;   // per session: one per cap, as the daemon keeps a session's state

const overrides = new Map();   // session id -> Map(name -> {value, loosening, over, version})
const listeners = [];
let lastCeiling;   // the ceiling value last seen (the settings tool's cache hands the same object until it changes)
let memo = null;   // {value, at}: the ceiling as last read here

const deps = {};
function defaultDeps() {
  return {
    // the cache only: a call's path never reads the file (or, on Windows,
    // spawns PowerShell); undefined when it is stale
    ceiling: () => require('./settings-tool').cachedCeiling(() => require('./settings-ceiling').readCeiling(), {cacheOnly: true}),
    defaultOf: (name) => require('./cli-options')[name],
    boundsOf: (name) => { const e = require('./settings-tool').ALLOWLIST[name]; return {min: e.min, max: e.max}; },
    isLive: (id) => require('./sessions').get(id) != null,
    // how long a ceiling read is taken again without asking (#271's review,
    // 5): the cache check lstats the file and each directory above it, and
    // every check of a call with a session override reads it. A ceiling
    // seen changed (ceilingSeen) replaces it at once; a change on disk not
    // yet re-read is seen within this, as unknown (bounded at the default)
    ceilingMemoMs: 1000,
    // a monotonic clock, in ms: a wall clock stepped back would keep a memo
    // far past its window (#271's re-check)
    nowMs: () => Number(process.hrtime.bigint() / 1000000n)
  };
}
function configure(given = {}) {
  Object.assign(deps, defaultDeps(), given);
  memo = null;
}
configure();

const safePositive = (v) => Number.isSafeInteger(v) && v > 0;
const isCap = (name) => typeof(name) === 'string' && CAPS.includes(name);

function changed(id) {
  for (const fn of listeners) {
    try { fn(id); } catch (e) { /* a listener's problem is its own */ }
  }
}

// What a ceiling value lets a cap be loosened to: a number, Infinity (no
// bound), or null (no loosening: bounded at the default).
function boundOf(c, name) {
  if (c != null && c.state === 'none') return Infinity;
  if (c == null || c.state !== 'trusted' || c.ceiling == null) return null;
  if (c.ceiling.conversation === false) return null;
  if (Array.isArray(c.ceiling.forbid) && c.ceiling.forbid.includes(name)) return null;
  return safePositive(c.ceiling[name]) ? c.ceiling[name] : Infinity;
}
function currentCeiling() {
  const now = deps.nowMs();
  // a negative age (a clock that went back) is expired too
  const age = memo != null ? now - memo.at : -1;
  if (age >= 0 && age < deps.ceilingMemoMs) return memo.value;
  const c = deps.ceiling();
  memo = {value: c, at: now};
  return c;
}

function ceilingOf(name) {
  const c = currentCeiling();
  if (c !== undefined && c !== lastCeiling) ceilingSeen(c);
  return boundOf(c, name);
}
// The bound a trusted ceiling puts on a cap whatever else it says: one that
// turns conversation off, or forbids changing the setting, still bounds
// what a call is held to (boundOf is what a cap may be LOOSENED to, and
// answers "no loosening" for those). Infinity when it names none, or cannot
// be trusted or is not known: nothing that can be read bounds it.
//
// A ceiling not known at this read (its file changed and has not been read
// again: the settings tool's watch reads it within its interval) leaves the
// one last seen in force. So a change on disk never opens a window at the
// default alone; a lowered one bounds within that interval, and until then
// calls are held to the previous ceiling.
function hardCeilingOf(name) {
  const c = currentCeiling();
  if (c !== undefined && c !== lastCeiling) ceilingSeen(c);
  const known = c !== undefined ? c : lastCeiling;
  return (known != null && known.state === 'trusted' && known.ceiling != null && safePositive(known.ceiling[name])) ? known.ceiling[name] : Infinity;
}
// What a call with no override of its own is held to: each cap the tighter
// of the default and the ceiling (lib/call-limits.js of; the reviewer's
// ruling on #284). ch-local's start clamps the defaults to the ceiling; a
// runtime started another way, with a default above it, must not serve
// above it. Never throws (a call's path): a default that is not set is
// bounded by the ceiling alone.
function underCeiling() {
  const out = {};
  for (const name of CAPS) {
    const d = deps.defaultOf(name);
    const hard = hardCeilingOf(name);
    out[name] = safePositive(d) ? Math.min(d, hard) : (hard === Infinity ? d : hard);
  }
  return Object.freeze(out);
}

// A changed ceiling is seen (a read's, or the settings tool's re-read): every
// session's stored loosenings are clamped to it, idle sessions too, and each
// changed one is said. An unknown ceiling (undefined: a stale cache) is no
// change.
function ceilingSeen(c) {
  if (c === undefined) return;
  memo = {value: c, at: deps.nowMs()};
  if (c === lastCeiling) return;
  // marked seen only once every session is clamped (#268's re-check, 3): one
  // that throws midway is retried in full at the next read
  for (const [id, own] of overrides) {
    let moved = false;
    for (const name of CAPS) {
      const e = own.get(name);
      if (e == null || e.loosening !== true) continue;
      const b = boundOf(c, name);
      const limit = b == null ? defaultNow(name) : b;
      if (e.value > limit) { e.value = limit; moved = true; }
    }
    if (moved) changed(id);
  }
  recount();
  lastCeiling = c;
}

function defaultNow(name) {
  const d = deps.defaultOf(name);
  if (!safePositive(d)) throw new Error(`session-settings: no default for ${name}`);
  return d;
}
function checkName(name) {
  if (typeof(name) !== 'string') throw new Error('session-settings: a setting is named by a string');
  if (!isCap(name)) throw CountinghouseError.withFields('SETTING_UNKNOWN', {name: name.slice(0, 80)});
  return name;
}
function checkValue(name, value) {
  const b = deps.boundsOf(name);
  if (!safePositive(value) || value < b.min || value > b.max) {
    throw CountinghouseError.withFields('SETTING_OUT_OF_BOUNDS', {name: name, value: String(value).slice(0, 80), bounds: `${b.min} to ${b.max}`});
  }
}
function checkId(id) {
  if (typeof(id) !== 'string' || !ID.test(id)) throw new Error('session-settings: a session is its 32-hex id');
}

// The session's effective value; clamps or drops a stored cap a bound has
// passed (and says so).
function effective(id, name) {
  checkId(id);
  checkName(name);
  const own = overrides.get(id);
  const e = own != null ? own.get(name) : undefined;
  const def = defaultNow(name);
  const ceiling = ceilingOf(name);
  const bound = ceiling == null ? def : ceiling;
  // the ceiling's own number bounds every value, an override's or the
  // default's, also where it lets nothing be loosened (hardCeilingOf)
  const hard = hardCeilingOf(name);
  if (e === undefined) return Math.min(def, bound, hard);
  // a read only bounds: an unmarked override, or a loosening confirmed over
  // a default since lowered, by the default too
  const limit = (e.loosening === true && def >= e.over) ? bound : Math.min(def, bound);
  return Math.min(e.value, limit, hard);
}

function isLoosening(id, name, value) {
  checkName(name);
  checkValue(name, value);
  return value > effective(id, name);
}

// Sets a session's override. A value looser than the session's effective
// one needs {loosening: true, over: <the global default it was confirmed
// over>}. -> {old, new}
function set(id, name, value, {loosening = false, over = null} = {}) {
  checkId(id);
  if (!deps.isLive(id)) throw new Error('session-settings: a session that has ended (or never settled) sets nothing');
  checkName(name);
  checkValue(name, value);
  const looser = isLoosening(id, name, value);
  if (looser && loosening !== true) throw new Error('session-settings: a looser value needs {loosening: true, over}');
  if (looser && !safePositive(over)) throw new Error('session-settings: a loosening names the default it was confirmed over');
  // a loosening confirmed over a default above today's would lie dormant and
  // come back when the default rises: refused, as Task 6's import refuses it
  // (#268's re-check, 2)
  if (looser && over > defaultNow(name)) throw new Error('session-settings: a loosening is confirmed over the default in force, never a higher one');
  // stored at most at the bound now, so a ceiling raised later never lets a
  // value past the one in force when it was set (#268's re-check, 1); with
  // no usable bound (an untrusted or stale ceiling, one that forbids it or
  // turns conversation off) a loosening is refused
  let stored = value;
  if (looser) {
    const bound = ceilingOf(name);
    if (bound == null) throw new Error('session-settings: no loosening without a usable ceiling now (it is untrusted, not known, or forbids it)');
    stored = Math.min(value, bound);
  }
  const own = overrides.get(id) || new Map();
  if (!own.has(name) && own.size >= MAX_OVERRIDES) {
    throw CountinghouseError.withFields('SETTING_OUT_OF_BOUNDS', {name: name, value: String(value).slice(0, 80), bounds: `at most ${MAX_OVERRIDES} settings per session`});
  }
  const old = effective(id, name);
  // A value lowered from the session's own confirmed loosening and still
  // above the default keeps that loosening's mark: unmarked, it would read
  // as the default while the change said the value asked for (the final
  // pass's gateway part, A4). To the default or below, it is unmarked.
  const prev = own.get(name);
  const keep = !looser && prev != null && prev.loosening === true && value > defaultNow(name);
  // over: never below the default now (#268's re-check, b): one passed lower
  // would keep a loosening alive past a lowered default
  own.set(name, {value: stored, loosening: looser || keep, over: looser ? Math.max(over, defaultNow(name)) : keep ? prev.over : null, version: null});
  overrides.set(id, own);
  recount();
  const now = effective(id, name);
  changed(id);
  return {old, new: now};
}

// the session's caps for a call: frozen, or null when it has no cap override
function limitsOf(id) {
  if (typeof(id) !== 'string' || !overrides.has(id)) return null;
  const own = overrides.get(id);
  if (!CAPS.some((c) => own.has(c))) return null;
  return Object.freeze({maxOutputBytes: effective(id, 'maxOutputBytes'), requestTimeout: effective(id, 'requestTimeout')});
}

// A tightening of a cap's default to newDefault (a terminal change, or one
// a session made for all sessions): every confirmed LOOSENING above it is
// dropped. -> the ids whose override was. A session's own tightening is
// never dropped, though it be above the new default: it is that session's
// choice, held to the default while the default is lower (effective), and
// in force again when the default rises (#296's review).
function dropLooser(name, newDefault) {
  if (!isCap(name)) throw new Error('session-settings: only a cap is dropped');
  if (!safePositive(newDefault)) throw new Error('session-settings: a new default is a positive whole number');
  const dropped = [];
  for (const [id, own] of [...overrides]) {
    const e = own.get(name);
    if (e != null && e.loosening === true && e.value > newDefault) {
      own.delete(name);
      if (own.size === 0) overrides.delete(id);
      dropped.push(id);
      changed(id);
    }
  }
  recount();
  return dropped;
}

// a session's overrides as they are stored (Task 6's export)
function overridesOf(id) {
  const own = overrides.get(id);
  return own == null ? [] : [...own].map(([name, e]) => Object.assign({name}, e));
}

function forget(id) { overrides.delete(id); recount(); }

// The largest stored value of a cap among the sessions (B3 Task 7: the
// broker's held-input total follows the largest active cap), or null when
// no session has one. Counted again on every change of an override (set,
// clear, ceilingSeen, dropLooser, forget), never at a reader's call.
let largestNow = Object.create(null);
let largestScans = 0;
function recount() {
  largestScans += 1;
  const next = Object.create(null);
  for (const own of overrides.values()) {
    for (const name of CAPS) {
      const e = own.get(name);
      if (e != null && Number.isInteger(e.value) && (next[name] == null || e.value > next[name])) next[name] = e.value;
    }
  }
  largestNow = next;
}
function largest(name) {
  return largestNow[name] != null ? largestNow[name] : null;
}

// One session's own value for a setting, gone: it runs under the default
// again. -> the value it had, or null. (B2 Task 5b: a session that had a
// change confirmed for all sessions, itself included.)
function clear(id, name) {
  const own = overrides.get(id);
  const e = own != null ? own.get(name) : null;
  if (e == null) return null;
  own.delete(name);
  if (own.size === 0) overrides.delete(id);
  recount();
  changed(id);
  return e.value;
}
// heard once, however often it is given (lib/sessions.js gives its own at every attach)
function onChange(fn) { if (typeof(fn) === 'function' && !listeners.includes(fn)) listeners.push(fn); }

module.exports = {configure, set, effective, isLoosening, defaultNow, limitsOf, underCeiling, dropLooser, overridesOf, forget, clear, onChange, ceilingSeen, largest, largestScansForTests: () => largestScans, MAX_OVERRIDES, CAPS,
  resetForTests: () => { overrides.clear(); listeners.length = 0; lastCeiling = undefined; memo = null; largestNow = Object.create(null); configure(); }};

'use strict';
// Each session's own settings (the shared runtime, B2 Task 1:
// docs/superpowers/plans/2026-11-15-shared-runtime-b2-session-settings.md;
// the design, #236 section 3). Every change made in conversation in shared
// mode is the session's override, for that session's calls only, for the
// session's life; conversation never writes settings.json there. Main
// thread only; nothing here reaches a worker or a file.
//
// An override is {value, loosening, over, version}, the shape a session's
// export carries (Task 6) and the daemon validates (C's #255):
//   - a cap's value is a safe integer within the settings tool's own bounds;
//     a pack's is a boolean, and a pack override always names the pack's
//     version (its form named it, or the version installed now);
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
//     changes nothing stored;
//   - a pack: the override (an "on" only where the ceiling allows the
//     pack), else the global value.
// What counts as a loosening is judged against that effective value (so
// raising a session-tightened value back toward the default, or un-hiding a
// pack the session turned off, is one).
//
// Bad input throws: the store never guesses. The ceiling, the defaults, the
// bounds, the packs' global values and liveness are given (configure); by
// default the settings tool's cached ceiling and allowlist, the options and
// lib/sessions.js. locale is the terminal's only. onChange(fn) hears every
// change of a session's overrides (Task 6's export).
const {CountinghouseError} = require('./countinghouse-error');

const CAPS = ['maxOutputBytes', 'requestTimeout'];
const PACK = /^pack\.([a-z0-9][a-z0-9-]{0,63})$/;
const ID = /^[0-9a-f]{32}$/;
const MAX_OVERRIDES = 64;   // per session, as the daemon keeps a session's state (C's #255)
// a pack override's version: a plain one, as restore and the daemon's table
// require it (C's #255 and ch-local's session-table.js)
const PLAIN_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,64})?$/;

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
    // a pack's value for a session with no override of its own: whether it
    // is on for everyone (B3, lib/session-packs.js)
    globalPack: (name) => require('./session-packs').isGlobal(PACK.exec(name)[1]),
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
const isPack = (name) => typeof(name) === 'string' && PACK.test(name);

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
    // a pack this ceiling no longer lets conversation turn on: the
    // session's "on" is dropped for good, so a ceiling raised again brings
    // nothing back without a new confirmation (B3 Task 2). An "off" stays.
    for (const [name, e] of [...own]) {
      if (isPack(name) && e.value === true && !packAllowedBy(c, name)) { own.delete(name); moved = true; }
    }
    if (own.size === 0) overrides.delete(id);
    if (moved) changed(id);
  }
  lastCeiling = c;
}

function defaultNow(name) {
  const d = deps.defaultOf(name);
  if (!safePositive(d)) throw new Error(`session-settings: no default for ${name}`);
  return d;
}
// whether the ceiling lets conversation turn a pack on
function ceilingAllowsPack(name) {
  return packAllowedBy(currentCeiling(), name);
}
// the same, by the pack's own name, for lib/session-packs.js: an "on" lists
// the pack only while this is true, as effective() says (B3, #340's review)
function packOnAllowed(pack) {
  return typeof(pack) === 'string' && ceilingAllowsPack(`pack.${pack}`);
}
function packAllowedBy(c, name) {
  if (c != null && c.state === 'none') return true;
  if (c == null || c.state !== 'trusted' || c.ceiling == null || c.ceiling.conversation === false) return false;
  return !Array.isArray(c.ceiling.packs) || c.ceiling.packs.includes(PACK.exec(name)[1]);
}

function checkName(name) {
  if (typeof(name) !== 'string') throw new Error('session-settings: a setting is named by a string');
  if (name === 'locale') return 'locale';
  if (!isCap(name) && !isPack(name)) throw CountinghouseError.withFields('SETTING_UNKNOWN', {name: name.slice(0, 80)});
  return name;
}
function checkValue(name, value) {
  if (isCap(name)) {
    const b = deps.boundsOf(name);
    if (!safePositive(value) || value < b.min || value > b.max) {
      throw CountinghouseError.withFields('SETTING_OUT_OF_BOUNDS', {name: name, value: String(value).slice(0, 80), bounds: `${b.min} to ${b.max}`});
    }
  } else if (typeof(value) !== 'boolean') {
    throw CountinghouseError.withFields('SETTING_OUT_OF_BOUNDS', {name: name, value: String(value).slice(0, 80), bounds: 'on or off'});
  }
}
function checkId(id) {
  if (typeof(id) !== 'string' || !ID.test(id)) throw new Error('session-settings: a session is its 32-hex id');
}

// The session's effective value; clamps or drops a stored cap a bound has
// passed (and says so).
function effective(id, name) {
  checkId(id);
  if (checkName(name) === 'locale') throw new Error('session-settings: locale is not a session\'s');
  const own = overrides.get(id);
  const e = own != null ? own.get(name) : undefined;
  if (isPack(name)) {
    if (e === undefined) return deps.globalPack(name);
    return (e.value === true && !ceilingAllowsPack(name)) ? deps.globalPack(name) : e.value;
  }
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
  if (name === 'locale') throw new Error('session-settings: locale is not a session\'s');
  checkValue(name, value);
  const now = effective(id, name);
  if (isPack(name)) return value === true && now !== true;
  return value > now;
}

// Sets a session's override. A value looser than the session's effective
// one needs {loosening: true, over: <the global default it was confirmed
// over>}; a pack's always needs {version}. -> {old, new}
function set(id, name, value, {loosening = false, over = null, version = null} = {}) {
  checkId(id);
  if (!deps.isLive(id)) throw new Error('session-settings: a session that has ended (or never settled) sets nothing');
  if (checkName(name) === 'locale') {
    throw CountinghouseError.withFields('SETTING_TERMINAL_ONLY_SHARED', {name: 'locale', command: `ch-local settings set locale ${String(value).slice(0, 40)}`});
  }
  checkValue(name, value);
  if (isPack(name) && (typeof(version) !== 'string' || !PLAIN_VERSION.test(version))) throw new Error('session-settings: a pack override names its plain version');
  const looser = isLoosening(id, name, value);
  if (looser && loosening !== true) throw new Error('session-settings: a looser value needs {loosening: true, over}');
  if (looser && isCap(name) && !safePositive(over)) throw new Error('session-settings: a loosening names the default it was confirmed over');
  // a loosening confirmed over a default above today's would lie dormant and
  // come back when the default rises: refused, as Task 6's import refuses it
  // (#268's re-check, 2)
  if (looser && isCap(name) && over > defaultNow(name)) throw new Error('session-settings: a loosening is confirmed over the default in force, never a higher one');
  // stored at most at the bound now, so a ceiling raised later never lets a
  // value past the one in force when it was set (#268's re-check, 1); with
  // no usable bound (an untrusted or stale ceiling, one that forbids it or
  // turns conversation off) a loosening is refused
  let stored = value;
  if (looser && isCap(name)) {
    const bound = ceilingOf(name);
    if (bound == null) throw new Error('session-settings: no loosening without a usable ceiling now (it is untrusted, not known, or forbids it)');
    stored = Math.min(value, bound);
  }
  const own = overrides.get(id) || new Map();
  if (!own.has(name) && own.size >= MAX_OVERRIDES) {
    throw CountinghouseError.withFields('SETTING_OUT_OF_BOUNDS', {name: name, value: String(value).slice(0, 80), bounds: `at most ${MAX_OVERRIDES} settings per session`});
  }
  const old = effective(id, name);
  // over: never below the default now (#268's re-check, b): one passed lower
  // would keep a loosening alive past a lowered default
  own.set(name, {value: stored, loosening: looser, over: looser && isCap(name) ? Math.max(over, defaultNow(name)) : null, version: isPack(name) ? version : null});
  overrides.set(id, own);
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
  return dropped;
}

// a session's overrides as they are stored (Task 6's export)
function overridesOf(id) {
  const own = overrides.get(id);
  return own == null ? [] : [...own].map(([name, e]) => Object.assign({name}, e));
}

function forget(id) { overrides.delete(id); }

// ch-local unloaded the pack (a terminal off included): every session's
// own "on" ends; a session's own "off" stays. -> the ids whose "on" was
// dropped (B3 Task 2).
function dropPack(name) {
  if (!isPack(name)) throw new Error('session-settings: dropPack takes a pack.<n>');
  const dropped = [];
  for (const [id, own] of [...overrides]) {
    const e = own.get(name);
    if (e != null && e.value === true) {
      own.delete(name);
      if (own.size === 0) overrides.delete(id);
      dropped.push(id);
      changed(id);
    }
  }
  return dropped;
}

// A session's stored pack overrides: pack (the <n>) -> true or false
// (lib/session-packs.js overridesOf).
function packOverridesOf(id) {
  const out = new Map();
  const own = overrides.get(id);
  if (own == null) return out;
  for (const [name, e] of own) if (isPack(name)) out.set(PACK.exec(name)[1], e.value === true);
  return out;
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
  changed(id);
  return e.value;
}
// heard once, however often it is given (lib/sessions.js gives its own at every attach)
function onChange(fn) { if (typeof(fn) === 'function' && !listeners.includes(fn)) listeners.push(fn); }

module.exports = {configure, set, effective, isLoosening, limitsOf, underCeiling, dropLooser, overridesOf, forget, clear, onChange, ceilingSeen, dropPack, packOnAllowed, packOverridesOf, MAX_OVERRIDES, CAPS,
  resetForTests: () => { overrides.clear(); listeners.length = 0; lastCeiling = undefined; memo = null; configure(); }};

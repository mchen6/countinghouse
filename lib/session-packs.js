'use strict';
// Which packs a shared runtime's session lists (shared runtime B3, Task 1:
// docs/superpowers/plans/2026-11-16-shared-runtime-b3-session-packs.md), on
// the main thread only. The session never reaches a worker (B1).
//
// A pack (ch-local's name, the <n> of the setting pack.<n>) is global (on
// for everyone, from the terminal's settings: ch-local says so on each load,
// and the runtime never infers it) or not. A session lists a pack by its own
// stored override when it has one (lib/session-settings.js), else by the
// pack being global.
//
// Membership follows the stored override: on every onOverrideChange(id) the
// session is reconciled, and it is in a pack's set exactly when its stored
// override for that pack is on. There is no join or leave for other files
// to call, so every road an override goes (set to off, clear, a ceiling that
// no longer allows it, an unload's dropPack) makes the session leave, here.
//
// A module is listed to a session when any pack that owns it is (a part two
// packs share is one module at one version). A module no pack owns (loaded
// another way at start), and a device whose module is not known, is listed
// to every session.
//
// Outside shared mode every question answers "listed" without looking, and
// none() is true. With no pack override anywhere and every loaded pack
// global, a call's check is one boolean (none()): the sessions with an
// override are counted as they change, never walked. A loaded pack that is
// not global and no session's (its unload asked, or one that failed) keeps
// none() false, so it stays hidden: fail closed.
//
// An "on" lists the pack only while the ceiling in force allows it
// (deps.allowsOn, the settings store's packOnAllowed), as effective() says;
// membership follows the stored value, so a ceiling read alone unloads
// nothing (ceilingSeen drops the stored "on", and that is the change).

let deps = null;
function configure(given = {}) {
  deps = Object.assign({
    records: () => [],                 // [{pack, modules: [module name]}]
    moduleOf: () => null,              // deviceID -> module name, or null
    overridesOf: () => new Map(),      // session -> Map(pack -> boolean)
    onOverrideChange: () => {},        // (fn(session)) the settings store's onChange
    openSessions: () => [],            // the ids of the sessions open now
    shared: () => false,
    // (pack, ceiling) whether that ceiling lets an "on" count: false until
    // wired, so a missed wiring can't skip the ceiling (the reviewer's #340
    // review, 4)
    allowsOn: () => false,
    ceilingNow: () => undefined,       // the ceiling in force, read once per view (the settings store's ceilingNow)
    ceilingKey: () => '',              // (ceiling) what allowsOn hangs on (the settings store's ceilingKey)
    isOpen: null,                      // (session) whether it is live; by openSessions when not given
    endedPacksOff: () => null          // (session) an ended session's "off"s, kept for its jobs (lib/job-sessions.js packsOffFor), or null
  }, given);
  if (typeof(deps.isOpen) !== 'function') deps.isOpen = (id) => deps.openSessions().includes(id);
  owners = null;
  deps.onOverrideChange((id) => reconcile(id));
}

const globals = new Set();            // packs on for everyone
const sets = new Map();               // pack -> Set of sessions with their own "on"
const hidden = new Map();             // session (or '' for null) -> Set of module names it does not list (built on first use)
const withOverrides = new Set();      // sessions whose stored overrides name a pack (none()'s count)
let owners = null;                    // module name -> Set of packs, from the records (built on first use, until a pack changes)
let someNotGlobal = false;            // beside owners: whether a loaded pack isn't global (none()'s other half)
const emptyListeners = [];
const changeListeners = [];

const shared = () => deps != null && deps.shared() === true;
const keyOf = (session) => (session == null ? '' : session);

function told(list, value) {
  for (const fn of list) { try { fn(value); } catch (e) { /* the change stands */ } }
}
function changed(session) {
  if (session == null) { hidden.clear(); owners = null; } else hidden.delete(keyOf(session));
  told(changeListeners, session);
}

// The session's stored override decides its place in every pack's set.
function reconcile(id) {
  if (id == null) return;
  const own = deps.overridesOf(id);
  if (own.size > 0) withOverrides.add(id); else withOverrides.delete(id);
  const emptied = [];
  for (const [pack, value] of own) {
    if (value === true) {
      if (!sets.has(pack)) sets.set(pack, new Set());
      sets.get(pack).add(id);
    }
  }
  for (const [pack, members] of sets) {
    if (members.has(id) && own.get(pack) !== true) {
      members.delete(id);
      if (members.size === 0 && !globals.has(pack)) emptied.push(pack);
    }
  }
  changed(id);
  for (const pack of emptied) told(emptyListeners, pack);
}

function setGlobal(pack, on) {
  if (on === true) globals.add(pack); else globals.delete(pack);
  changed(null);
}
const isGlobal = (pack) => globals.has(pack);

function lists(session, pack) {
  if (!shared()) return true;
  return listedBy(session == null ? null : deps.overridesOf(session), pack, deps.ceilingNow());
}
// own: the session's stored overrides, and ceiling the ceiling in force,
// each read once by the caller (own may be null)
function listedBy(own, pack, ceiling) {
  if (own != null && own.has(pack)) {
    if (own.get(pack) === false) return false;
    if (deps.allowsOn(pack, ceiling) === true) return true;
  }
  return isGlobal(pack);
}

// module name -> the packs that own it, read from the records once, until a
// pack changes (packChanged, packGone, setGlobal)
function ownersOf() {
  if (owners != null) return owners;
  const built = new Map();
  let notGlobal = false;
  for (const r of deps.records()) {
    if (!globals.has(r.pack)) notGlobal = true;
    for (const m of r.modules) {
      if (!built.has(m)) built.set(m, new Set());
      built.get(m).add(r.pack);
    }
  }
  owners = built;
  someNotGlobal = notGlobal;
  return owners;
}

// the session's hidden modules, built once and kept until its view changes,
// or the ceiling's word on an "on" does
function hiddenOf(session) {
  const key = keyOf(session);
  // the ceiling read once, for its key and every "on" below, so the view
  // and its key can't come from two reads
  const ceiling = deps.ceilingNow();
  const ceilingKey = deps.ceilingKey(ceiling);
  let h = hidden.get(key);
  if (h == null || h.ceiling !== ceilingKey) {
    h = new Set();
    h.ceiling = ceilingKey;
    const own = session == null ? null : deps.overridesOf(session);
    for (const [m, of] of ownersOf()) {
      if (![...of].some((p) => listedBy(own, p, ceiling))) h.add(m);
    }
    hidden.set(key, h);
  }
  return h;
}

function listsModule(session, moduleName) {
  if (!shared()) return true;
  return !hiddenOf(session).has(moduleName);
}

function listsDevice(session, deviceID) {
  if (!shared()) return true;
  const m = deps.moduleOf(deviceID);
  return m == null ? true : listsModule(session, m);
}

// A run whose session has ended: the global packs, minus the ones it had
// turned off, and no this-session pack.
function listsDeviceFor({packsOff = []} = {}, deviceID) {
  if (!shared()) return true;
  const m = deps.moduleOf(deviceID);
  if (m == null) return true;
  const of = ownersOf().get(m);
  if (of == null) return true;
  const off = new Set(packsOff);
  return [...of].some((p) => isGlobal(p) && !off.has(p));
}

// A hop's or a run's (B3 Task 4): by the session its token or run carries.
// A live session: its own view. No session (shared mode only): the global
// packs. An ended one: the global packs minus the ones it had turned off,
// and none of its this-session packs; one whose "off"s are not kept (it had
// no job) lists no pack at all, fail closed: a module no pack owns, still.
function listsDeviceOfSession(session, deviceID) {
  if (!shared()) return true;
  if (session == null) return listsDevice(null, deviceID);
  if (deps.isOpen(session) === true) return listsDevice(session, deviceID);
  const off = deps.endedPacksOff(session);
  if (Array.isArray(off)) return listsDeviceFor({packsOff: off}, deviceID);
  const m = deps.moduleOf(deviceID);
  return m == null || !ownersOf().has(m);
}

function packsOffOf(session) {
  const out = [];
  for (const [pack, value] of deps.overridesOf(session)) if (value === false) out.push(pack);
  return out;
}

function none() {
  if (!shared()) return true;
  if (withOverrides.size > 0) return false;
  ownersOf();
  return !someNotGlobal;
}

// The sessions that list the pack now, a copy: a global pack's every open
// session without its own "off"; another's set.
function audienceOf(pack) {
  if (isGlobal(pack)) {
    return new Set(deps.openSessions().filter((id) => deps.overridesOf(id).get(pack) !== false));
  }
  // a session's own "on" counts only while the ceiling in force allows it
  if (deps.allowsOn(pack, deps.ceilingNow()) !== true) return new Set();
  return new Set(sets.get(pack) || []);
}

// The session's end (lib/sessions.js close; the settings store's forget
// calls no listener).
function forget(session) {
  withOverrides.delete(session);
  const emptied = [];
  for (const [pack, members] of sets) {
    if (members.delete(session) && members.size === 0 && !globals.has(pack)) emptied.push(pack);
  }
  changed(session);
  for (const pack of emptied) told(emptyListeners, pack);
}

// A load or a reload changed what the pack holds; an unload ended it.
function packChanged() { changed(null); }
function packGone(pack) {
  globals.delete(pack);
  sets.delete(pack);
  changed(null);
}

function onEmpty(fn) { if (typeof(fn) === 'function') emptyListeners.push(fn); }
function onChange(fn) { if (typeof(fn) === 'function') changeListeners.push(fn); }

configure();

module.exports = {configure, setGlobal, isGlobal, lists, listsModule, listsDevice, listsDeviceFor, listsDeviceOfSession, packsOffOf, none, audienceOf, forget, packChanged, packGone, onEmpty, onChange,
  resetForTests: () => { globals.clear(); sets.clear(); hidden.clear(); withOverrides.clear(); emptyListeners.length = 0; changeListeners.length = 0; configure(); }};

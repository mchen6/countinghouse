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
// none() is true. With no pack override anywhere, a call's check is one
// boolean (none()).

let deps = null;
function configure(given = {}) {
  deps = Object.assign({
    records: () => [],                 // [{pack, modules: [module name]}]
    moduleOf: () => null,              // deviceID -> module name, or null
    overridesOf: () => new Map(),      // session -> Map(pack -> boolean)
    onOverrideChange: () => {},        // (fn(session)) the settings store's onChange
    openSessions: () => [],            // the ids of the sessions open now
    shared: () => false
  }, given);
  deps.onOverrideChange((id) => reconcile(id));
}

const globals = new Set();            // packs on for everyone
const sets = new Map();               // pack -> Set of sessions with their own "on"
const hidden = new Map();             // session (or '' for null) -> Set of module names it does not list (built on first use)
const emptyListeners = [];
const changeListeners = [];

const shared = () => deps != null && deps.shared() === true;
const keyOf = (session) => (session == null ? '' : session);

function told(list, value) {
  for (const fn of list) { try { fn(value); } catch (e) { /* the change stands */ } }
}
function changed(session) {
  if (session == null) hidden.clear(); else hidden.delete(keyOf(session));
  told(changeListeners, session);
}

// The session's stored override decides its place in every pack's set.
function reconcile(id) {
  if (id == null) return;
  const own = deps.overridesOf(id);
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
  if (session != null) {
    const own = deps.overridesOf(session);
    if (own.has(pack)) return own.get(pack) === true;
  }
  return isGlobal(pack);
}

// module name -> the packs that own it, from the records as they are now
function ownersOf() {
  const owners = new Map();
  for (const r of deps.records()) {
    for (const m of r.modules) {
      if (!owners.has(m)) owners.set(m, new Set());
      owners.get(m).add(r.pack);
    }
  }
  return owners;
}

// the session's hidden modules, built once and kept until its view changes
function hiddenOf(session) {
  const key = keyOf(session);
  let h = hidden.get(key);
  if (h == null) {
    h = new Set();
    for (const [m, owners] of ownersOf()) {
      if (![...owners].some((p) => lists(session, p))) h.add(m);
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
  const owners = ownersOf().get(m);
  if (owners == null) return true;
  const off = new Set(packsOff);
  return [...owners].some((p) => isGlobal(p) && !off.has(p));
}

function packsOffOf(session) {
  const out = [];
  for (const [pack, value] of deps.overridesOf(session)) if (value === false) out.push(pack);
  return out;
}

function none() {
  if (!shared()) return true;
  for (const members of sets.values()) if (members.size > 0) return false;
  for (const id of deps.openSessions()) if (deps.overridesOf(id).size > 0) return false;
  return true;
}

// The sessions that list the pack now, a copy: a global pack's every open
// session without its own "off"; another's set.
function audienceOf(pack) {
  if (isGlobal(pack)) {
    return new Set(deps.openSessions().filter((id) => deps.overridesOf(id).get(pack) !== false));
  }
  return new Set(sets.get(pack) || []);
}

// The session's end (lib/sessions.js close; the settings store's forget
// calls no listener).
function forget(session) {
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

module.exports = {configure, setGlobal, isGlobal, lists, listsModule, listsDevice, listsDeviceFor, packsOffOf, none, audienceOf, forget, packChanged, packGone, onEmpty, onChange,
  resetForTests: () => { globals.clear(); sets.clear(); hidden.clear(); emptyListeners.length = 0; changeListeners.length = 0; configure(); }};

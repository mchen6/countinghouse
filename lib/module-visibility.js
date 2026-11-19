'use strict';
// A module that is going on or off is hidden (module-level configuration,
// #413 rev 3, section 5.5): the main thread's one set of module names no
// list shows and no call, hop, direct peer channel or job run reaches.
//
// Two windows need it:
// - while a module and the parts it newly brings in load: the top-level
//   module registers first, and listed at once its tool could be called
//   before its parts are there;
// - from the start of an unload, and after one that failed: a module turned
//   off must not be callable because its worker is slow to end.
//
// hide(names) at the start of a load (what it newly brings in) or of an
// unload (what it takes away); show(names) once that load has completed;
// gone(names) once that unload has: a name leaves the set only when the
// module is out of the module map and nothing of it can come back (no
// supervisor record), read from the module manager, never from the
// unload's answer. One still there stays hidden until the runtime ends: it
// failed to unload. A part another module holds is never hidden by someone
// else's load or unload (the caller passes only what it brings or takes).
//
// none() is true while the set is empty, which it is on every call's path
// outside a load or an unload: the check costs one boolean.
//
// No session has a view of its own (M5a, section 5.4): every reader asks
// this set directly, with no session (the tools, prompts and resources
// lists, the device manager's call and hop paths, the peer channel broker,
// the job runs, the per-session workers). Main thread only.

const hidden = new Set();
const listeners = [];
let deps = {moduleOf: () => null, isGone: () => true, changed: () => {}};

// deps: moduleOf(deviceID) -> the module that hosts it (or null);
// isGone(name) -> whether the module is out of the module map and nothing
// of it can come back; changed() -> what the lists show changed (one,
// replaced at each configure: a test process starts many runtimes).
function configure(given = {}) {
  deps = Object.assign({}, deps, given);
}

function told() {
  try { deps.changed(); } catch (e) { /* the change stands */ }
  for (const fn of listeners) { try { fn(); } catch (e) { /* the change stands */ } }
}

function hide(names) {
  let changed = false;
  for (const n of names) if (typeof(n) === 'string' && !hidden.has(n)) { hidden.add(n); changed = true; }
  if (changed) told();
}

function show(names) {
  let changed = false;
  for (const n of names) if (hidden.delete(n)) changed = true;
  if (changed) told();
}

// -> the names that stay hidden (failed to unload)
function gone(names) {
  const stay = [];
  let changed = false;
  for (const n of names) {
    if (!hidden.has(n)) continue;
    if (deps.isGone(n) === true) { hidden.delete(n); changed = true; } else stay.push(n);
  }
  if (changed) told();
  return stay;
}

const none = () => hidden.size === 0;
const isHidden = (name) => hidden.has(name);
const listsModule = (name) => hidden.size === 0 || !hidden.has(name);
function listsDevice(deviceID) {
  if (hidden.size === 0) return true;
  const m = deps.moduleOf(deviceID);
  return m == null || !hidden.has(m);
}
// [names] of `names` that are hidden now
const hiddenOf = (names) => [...names].filter((n) => hidden.has(n));

function onChange(fn) { if (typeof(fn) === 'function') listeners.push(fn); }

function resetForTests() {
  hidden.clear();
  listeners.length = 0;
  deps = {moduleOf: () => null, isGone: () => true, changed: () => {}};
}

module.exports = {configure, hide, show, gone, none, isHidden, hiddenOf, listsModule, listsDevice, onChange, resetForTests};

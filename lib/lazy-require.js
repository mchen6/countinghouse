'use strict';
// A library countinghouse loads on first use, not in every worker's boot
// (reviewer, 2026-11-12: postman-request, with soap since removed, was about
// a fifth of each module worker's boot). Loaded once per thread and kept,
// whichever file asks for it first: after its first use, what require.cache
// holds for it no longer matters to the runtime.
//
// In a lean worker nothing of the runtime's loads after the lockdown (#194's
// PR 1): what a worker's runtime takes through here is warmed at its boot or
// set-options (warm, below; lib/lean-worker.js), and test/sandbox/66 and 67
// hold that. postman-request is warmed only for a module that declares net;
// under audit a module with none loads it on its request (the spec's
// Revision 6, item 11). On the main thread and in single-thread mode it is
// still loaded on first use.

// One holder per library name in this thread, shared by every lazy(name).
// (read and written with Map's methods as they were when this file loaded:
// module code that replaces them later never chooses what the runtime gets)
const uncurry = (fn) => Function.prototype.call.bind(fn);
const MapHas = uncurry(Map.prototype.has);
const MapGet = uncurry(Map.prototype.get);
const MapSet = uncurry(Map.prototype.set);
const held = new Map();

// -> a function returning the library, required on its first call only.
function lazy(name) {
  return () => {
    if (!MapHas(held, name)) MapSet(held, name, require(name));
    return MapGet(held, name);
  };
}

// -> the library, or null when it cannot be loaded, after handing that error
// to callback on the next tick: a helper with a callback answers through it,
// never by a throw out of the call. With no callback (allowed by
// postman-request), the error is thrown from the call instead.
function orCallback(get, callback) {
  try {
    return get();
  } catch (e) {
    if (typeof(callback) !== 'function') throw e;
    process.nextTick(() => callback(e));
    return null;
  }
}

// Loads it now, so every later lazy(name) takes it from the holder and never
// reaches Node's loader (#194's PR 1: a worker warms what it will need
// before its lockdown, and loads nothing of the runtime's after).
function warm(name) {
  lazy(name)();
}

module.exports = {lazy, orCallback, warm};

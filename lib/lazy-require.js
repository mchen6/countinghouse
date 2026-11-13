// A library countinghouse loads on first use, not in every worker's boot
// (reviewer, 2026-11-12: postman-request, with soap since removed, was about
// a fifth of each module worker's boot). Loaded once per thread and kept,
// whichever file asks for it first: after its first use, what require.cache
// holds for it no longer matters to the runtime.
//
// Loaded after the lockdown, it is countinghouse's own code, which the
// identity loader resolves under countinghouse's code roots
// (lib/fs-broker/identity.js). The built-ins it needs are checked against the
// lockdown's allowed list on that first load; test/sandbox/40 makes a first
// call under enforce (a plain GET), so a dependency that starts to need
// another built-in on that path fails there, not in a module's first call. A
// built-in needed only on another path is not covered.

// One holder per library name in this thread, shared by every lazy(name).
const held = new Map();

// -> a function returning the library, required on its first call only.
function lazy(name) {
  return () => {
    if (!held.has(name)) held.set(name, require(name));
    return held.get(name);
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

module.exports = {lazy, orCallback};

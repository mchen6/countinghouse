// A library countinghouse loads on first use, not in every worker's boot
// (reviewer, 2026-11-12: postman-request and soap were about a fifth of each
// module worker's boot). Loaded once and kept: after its first use, what
// require.cache holds for it no longer matters to the runtime.
//
// Loaded after the lockdown, it is countinghouse's own code, which the
// identity loader resolves under countinghouse's code roots
// (lib/fs-broker/identity.js). The built-ins it needs are checked against the
// lockdown's allowed list on that first load; test/sandbox/40 loads each one
// under enforce, so a dependency that starts to need another built-in fails
// there, not in a module's first call.

// -> a function returning the library, required on its first call only.
function lazy(name) {
  let lib = null;
  return () => {
    if (lib == null) lib = require(name);
    return lib;
  };
}

// -> the library, or null when it cannot be loaded, after handing that error
// to callback on the next tick: a helper with a callback answers through it,
// never by a throw out of the call.
function orCallback(get, callback) {
  try {
    return get();
  } catch (e) {
    process.nextTick(() => callback(e));
    return null;
  }
}

module.exports = {lazy, orCallback};

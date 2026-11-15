'use strict';
// A module required on first use, then kept: (load) -> () => the module.
// For require() calls on a call path. In the runtime's main thread a
// require() of a module already loaded costs 5-8 us (0.37 us in a bare
// process; measured 2026-11-15, cause not yet found), and a warm tools/call
// made 12 of them. Still lazy, so a call site that is lazy to avoid a
// require cycle stays so. `load` is the caller's own `() => require('...')`,
// so the path resolves from the caller's file. Main-thread files only: a
// worker loads a fixed list of files (test/sandbox/43), and this is not one;
// a file every worker loads keeps an inline memo instead (lib/handler-ctx.js).
function requireOnce(load) {
  let held = null;
  return () => (held != null ? held : (held = load()));
}

module.exports = requireOnce;

// Preload (node -r) that makes require('sqlite3') fail, so a server can be
// started in a genuinely sqlite3-less environment without touching
// node_modules on disk.
//
// Simulates the *load* failure, not the missing-package one: the observed
// real-world case is that sqlite3 installs fine and then its prebuilt native
// binding refuses to load because it needs a newer glibc than the host has
// (ERR_DLOPEN_FAILED). That is the case worth testing, because it is the one
// optionalDependencies alone does NOT cover.
var Module = require('module');
var original = Module._resolveFilename;

Module._resolveFilename = function(request) {
  if (request === 'sqlite3') {
    var err = new Error("/lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found " +
                        '(required by .../node_sqlite3.node) [simulated by test/fixtures/no-sqlite3-preload.js]');
    err.code = 'ERR_DLOPEN_FAILED';
    throw err;
  }
  return original.apply(this, arguments);
};

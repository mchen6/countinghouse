// sqlite3 is an optionalDependency (see package.json). It is genuinely
// optional -- only three things need it:
//
//   --authProvider sqlite       lib/auth/sqlite-provider.js
//   the module registry DB      lib/device-db.js  (framework.js skips
//                               requiring it entirely whenever --loadModule
//                               was given, which is the documented path)
//   the user-management CLI     bin/countinghouse-auth-sqlite.js
//
// ...and it fails to load on hosts that are otherwise perfectly fine. The
// package ships a prebuilt native binding linked against glibc 2.38; a
// distro with an older glibc (Ubuntu 22.04 LTS ships 2.35) gets
// ERR_DLOPEN_FAILED at *require* time, not at install time -- which is why
// marking it optional is necessary but not sufficient. optionalDependencies
// only tolerates an install that fails; here the install succeeds and the
// binding still won't load.
//
// So every call site goes through this module, which turns that into one
// actionable message instead of a native-loader stack trace. Same shape as
// requireNano() in lib/couchdb-adapter/couchdb-auth-provider.js.
//
// The two causes get different advice on purpose: "not installed" and
// "installed but unloadable" have different fixes, and telling someone to
// reinstall a package they already have is how a diagnostic wastes an hour.

// Node exposes the runtime glibc in its diagnostic report header. Absent on
// musl (Alpine) and non-Linux, hence the guard -- the message just omits the
// version rather than asserting a wrong one.
function runtimeGlibc() {
  try {
    var header = process.report.getReport().header;
    return header.glibcVersionRuntime || null;
  } catch (e) {
    return null;
  }
}

function isMissingModule(err) {
  return err.code === 'MODULE_NOT_FOUND' && /'sqlite3'/.test(err.message);
}

// Builds the "what happened, why, and what you can do" text shared by every
// caller. `what` names the thing the caller was trying to use, so the first
// line reads as a statement about the user's actual command.
function explain(err, what, alternative) {
  var lines = [];

  if (isMissingModule(err)) {
    lines.push(what + ' requires the optional "sqlite3" package, which is not installed.');
    lines.push('  Cause:   sqlite3 is an optionalDependency, so npm skips it when it cannot be installed.');
    lines.push('  Fix:     npm install sqlite3');
  } else {
    var glibc = runtimeGlibc();
    lines.push(what + ' requires the optional "sqlite3" package, which is installed but cannot be loaded on this host.');
    lines.push('  Cause:   sqlite3 ships a prebuilt native binding that requires glibc >= 2.38' +
               (glibc != null ? '; this system has glibc ' + glibc + '.' : '.'));
    lines.push('  Detail:  ' + String(err.message).split('\n')[0]);
    lines.push('  Fix (a): rebuild sqlite3 from source against this system\'s glibc:');
    lines.push('             npm install sqlite3 --build-from-source');
    lines.push('           (needs a C++ toolchain: build-essential and python3)');
  }

  lines.push('  Fix (b): ' + alternative);
  return lines.join('\n');
}

// Returns the sqlite3 module, or throws an Error whose message explains the
// failure and the ways out. `what` is a human name for the caller's feature;
// `alternative` is the way to proceed WITHOUT sqlite3 at all, which is
// usually the answer the reader actually wants.
function requireSqlite3(what, alternative) {
  try {
    return require('sqlite3');
  } catch (e) {
    throw new Error(explain(e, what, alternative));
  }
}

module.exports = {
  requireSqlite3: requireSqlite3,
  runtimeGlibc:   runtimeGlibc
};

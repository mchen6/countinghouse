'use strict';
// The spelling a lean worker is started by (#272's sequel; ch-local's Windows
// acceptance). Once the file broker is installed in a worker, the loader's
// realpath is the native one (lib/fs-broker/patch.js, FB3), which on Windows
// expands an 8.3 short name (C:\Users\RUNNER~1 -> C:\Users\runneradmin). A
// worker started by the short spelling loaded its first files by it and the
// rest by the long one, so a file required both before the broker and after
// it had two instances: the second fs-broker/identity.js was never
// installed, and every module file was then required by its bare /app path
// (Cannot find module '/app/handlers/...'). Started by its native real path,
// the worker gives every file the one spelling from the first. Under
// --preserve-symlinks the loader realpaths nothing, so the spelling as given
// is already the one it keeps everywhere, and stays.
//
//   entryFor(dir, file, {preserve, onFallback}) -> the path to start the
//     worker by; onFallback(err) when the real path can't be had (the given
//     spelling is used, and the runtime says so)
//   preservesSymlinks(execArgv, env) -> whether this process's loader keeps
//     spellings, read as Node reads it: NODE_PRESERVE_SYMLINKS (its first
//     character 1), then NODE_OPTIONS, then the process's own flags, the
//     last of --preserve-symlinks and --no-preserve-symlinks deciding;
//     --preserve-symlinks-main keeps only the main file's, so it does not
//     count. Read once, as the process starts (lib/module-manager.js): the
//     loader's options are fixed then, whatever process.env says later.
const fs = require('fs');
const path = require('path');

// NODE_OPTIONS' words, a quoted one unquoted (Node accepts "--flag")
const words = (text) => (text.match(/"[^"]*"|\S+/g) || []).map((w) => (w.length >= 2 && w.startsWith('"') && w.endsWith('"') ? w.slice(1, -1) : w));
function preservesSymlinks(execArgv, env) {
  let preserve = env != null && typeof(env.NODE_PRESERVE_SYMLINKS) === 'string' && env.NODE_PRESERVE_SYMLINKS[0] === '1';
  const nodeOptions = (env != null && typeof(env.NODE_OPTIONS) === 'string') ? words(env.NODE_OPTIONS) : [];
  for (const flag of nodeOptions.concat(execArgv || [])) {
    if (flag === '--preserve-symlinks') preserve = true;
    else if (flag === '--no-preserve-symlinks') preserve = false;
  }
  return preserve;
}

function entryFor(dir, file, {preserve, onFallback} = {}) {
  const given = path.join(dir, file);
  if (preserve) return given;
  try {
    return fs.realpathSync.native(given);
  } catch (e) {
    if (typeof(onFallback) === 'function') onFallback(e);
    return given;
  }
}

module.exports = {entryFor, preservesSymlinks};

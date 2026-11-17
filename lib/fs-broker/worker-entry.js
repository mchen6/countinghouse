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
//   entryFor(dir, file, {preserve}) -> the path to start the worker by
//   preservesSymlinks(execArgv, env) -> whether this process's loader keeps
//     spellings (--preserve-symlinks, in its flags or NODE_OPTIONS, or
//     NODE_PRESERVE_SYMLINKS=1); --preserve-symlinks-main keeps only the
//     main file's, so it does not count
const fs = require('fs');
const path = require('path');

function preservesSymlinks(execArgv, env) {
  if ((execArgv || []).includes('--preserve-symlinks')) return true;
  const nodeOptions = (env != null && typeof(env.NODE_OPTIONS) === 'string') ? env.NODE_OPTIONS.split(/\s+/) : [];
  if (nodeOptions.includes('--preserve-symlinks')) return true;
  return env != null && env.NODE_PRESERVE_SYMLINKS === '1';
}

function entryFor(dir, file, {preserve} = {}) {
  const given = path.join(dir, file);
  if (preserve) return given;
  try { return fs.realpathSync.native(given); } catch (e) { return given; }
}

module.exports = {entryFor, preservesSymlinks};

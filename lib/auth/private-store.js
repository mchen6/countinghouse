'use strict';
// An auth store that is a file the runtime opens itself (the sqlite
// provider's database; bin/countinghouse-auth-sqlite.js): it holds API keys
// in the clear, so it is used only when it is this user's own, a regular
// file, never a link, owner-only -- mode 0600 on POSIX, this user's ACL
// alone on Windows (lib/win-acl.js) -- and is made so when it is created
// (B-meter-keys 4r). auth.json, a text file, is read through
// lib/private-file.js instead (lib/auth/file-provider.js).
//
// SQLite's own files beside it (-journal, -wal) take its mode.
const fs = require('fs');

const WIN = process.platform === 'win32';
const isFilePath = (p) => typeof(p) === 'string' && p !== '' && p !== ':memory:' && !p.startsWith('file:');

// -> null when the file is fine (or is no file: SQLite's in-memory and URI
// names), or a refusal's text naming the fix; never a key.
function storeProblem(file, what) {
  if (!isFilePath(file)) return null;
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return e.code === 'ENOENT' ? null : `${file} could not be checked (${e.code || e.message})`; }
  const fix = WIN ? '' : `; it holds API keys, so it is used only as this user's own file, mode 0600: chmod 600 ${file}`;
  if (st.isSymbolicLink()) return `${file} is a symbolic link; ${what} is never opened through a link`;
  if (!st.isFile()) return `${file} is not a regular file`;
  if (WIN) {
    // (under --hardened no PowerShell can run, so the ACL can't be read:
    // refused, never opened unchecked)
    if (process.permission != null) return `${file}'s permissions cannot be checked under --hardened on Windows; ${what} is not opened unchecked`;
    const winAcl = require('../win-acl');
    let acl;
    try { acl = winAcl.fileAcl(file); } catch (e) { return `${file}'s ACL could not be read (${e.code || 'PowerShell failed'})`; }
    const problem = winAcl.privateProblem(file, acl);
    if (problem == null) return null;
    const hint = winAcl.fixHint(file, acl);
    return `${problem}; ${what} must be readable by this user only${hint != null ? `; to make it so, run:\n  ${hint}` : ''}`;
  }
  if (typeof(process.getuid) === 'function' && st.uid !== process.getuid()) return `${file} is not this user's own${fix}`;
  if ((st.mode & 0o077) !== 0) return `${file} is accessible by group or others (mode ${(st.mode & 0o777).toString(8)})${fix}`;
  return null;
}

// The file checked, or made owner-only when it is not there (an exclusive
// create, mode 0600 -- on Windows with this user's ACL alone). -> null, or a
// refusal's text.
function preparedStore(file, what) {
  if (!isFilePath(file)) return null;
  const problem = storeProblem(file, what);
  if (problem != null) return problem;
  if (fs.existsSync(file)) return null;
  try {
    if (WIN) require('../win-acl').createPrivate(file, '');
    else { fs.closeSync(fs.openSync(file, 'wx', 0o600)); fs.chmodSync(file, 0o600); }
  } catch (e) {
    if (e.code !== 'EEXIST') return `${file} could not be created (${e.code || e.message})`;
    return storeProblem(file, what);
  }
  return null;
}

module.exports = {storeProblem, preparedStore, isFilePath};

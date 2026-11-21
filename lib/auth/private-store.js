'use strict';
// An auth store that is a file the runtime opens itself (the sqlite
// provider's database; bin/countinghouse-auth-sqlite.js): it holds API keys
// in the clear, so it is used only when it is this user's own, a regular
// file, never a link, owner-only -- mode 0600 on POSIX, this user's ACL
// alone on Windows (lib/win-acl.js) -- and is made so when it is created
// (B-meter-keys 4r). Its side files (-journal, -wal, -shm) are held to the
// same rule, and its directory must be one only this user can write in:
// SQLite plays back a side file at open, whoever made it. auth.json, a text
// file, is read through lib/private-file.js instead
// (lib/auth/file-provider.js).
//
// SQLite's own side files take the database's mode.
const fs = require('fs');

const path = require('path');

const WIN = process.platform === 'win32';
// (SQLite's in-memory database and its anonymous temporary one are no file;
// a `file:` name is a file to node-sqlite3, taken literally)
const isFilePath = (p) => typeof(p) === 'string' && p !== '' && p !== ':memory:';
// the files SQLite keeps beside the database, which it plays back at open
const SIDE_FILES = ['-journal', '-wal', '-shm'];

// The fix a POSIX refusal names, by what it is about ('mode', 'owner'); none
// for a link or anything else, nor on Windows, whose refusal names its own
// icacls fix. Shared by both auth stores (lib/auth/file-provider.js gets the
// kind from lib/private-file.js's refusal), so their refusals read alike.
function fixFor(kind, file) {
  if (WIN) return '';
  if (kind === 'mode') return `, as it holds API keys: chmod 600 ${file}`;
  if (kind === 'owner') return `; it holds API keys: chown it to this user, then chmod 600 ${file}`;
  return '';
}

// One file of the store (the database or a side file): -> null when it is
// not there or is this user's own regular file, under one name, never a
// link, owner-only; else a refusal's text.
function fileProblem(file, what) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return e.code === 'ENOENT' ? null : `${file} could not be checked (${e.code || e.message})`; }
  if (st.isSymbolicLink()) return `${file} is a symbolic link; ${what} is never opened through a link`;
  if (!st.isFile()) return `${file} is not a regular file`;
  if (st.nlink !== 1) return `${file} has ${st.nlink} names (hard links); ${what} is kept under one name only`;
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
  if (typeof(process.getuid) === 'function' && st.uid !== process.getuid()) return `${file} is not this user's own; ${what} is used only from a file this user owns${fixFor('owner', file)}`;
  if ((st.mode & 0o077) !== 0) return `${file} is accessible by group or others (mode ${(st.mode & 0o777).toString(8)}); it must be 0600${fixFor('mode', file)}`;
  return null;
}

// The directory the store is in (POSIX): SQLite plays back a hot -journal
// beside the database at open, whoever made it, so a directory another user
// can write in lets them rewrite the store (the high on #520, M1). It must
// be this user's own (or root's) and writable by no group or other, sticky
// or not. That also leaves no one else able to swap a file in between this
// check and SQLite's open.
function dirProblem(file, what) {
  if (WIN) return null;
  const dir = path.dirname(path.resolve(file));
  let st;
  try { st = fs.statSync(dir); } catch (e) { return `${dir}, the directory of ${what}, could not be checked (${e.code || e.message})`; }
  if (typeof(process.getuid) === 'function' && st.uid !== process.getuid() && st.uid !== 0) {
    return `${file} is in ${dir}, which is not this user's own (nor root's); SQLite plays back a file planted beside ${what}, so keep it in a directory only this user can write in`;
  }
  if ((st.mode & 0o022) !== 0) {
    return `${file} is in ${dir}, and group or others can write in it (mode ${(st.mode & 0o7777).toString(8)}); SQLite plays back a file planted beside ${what}, so keep it in a directory only this user can write in: chmod go-w ${dir}`;
  }
  return null;
}

// -> null when the store is fine (or is no file), or a refusal's text naming
// the fix; never a key: its directory, the database, then each side file.
function storeProblem(file, what) {
  if (!isFilePath(file)) return null;
  const inDir = dirProblem(file, what);
  if (inDir != null) return inDir;
  const own = fileProblem(file, what);
  if (own != null) return own;
  for (let i = 0; i < SIDE_FILES.length; i++) {
    const side = fileProblem(file + SIDE_FILES[i], what);
    if (side != null) return side;
  }
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

module.exports = {storeProblem, preparedStore, isFilePath, fixFor};

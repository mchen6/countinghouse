'use strict';
// A small file the runtime keeps for itself beside its data, readable and
// writable by its own user only (lib/identity.js's identity secret, and
// lib/server-id.js's server id): never read through a link, never a file
// others can reach (mode 0600; on Windows its owner and ACL, by SID, through
// lib/win-acl.js), written whole under a temporary name and renamed into
// place, and under --hardened on Windows checked by the parent before the
// relaunch (prepareForHardened), the child taking the file as checked only
// if it is that same file, unchanged (checkedByParent).
//
// spec: {what, form, formText, variable, refuse}
//   what      the file's content in a message ('the identity secret')
//   form      a RegExp its content must match
//   formText  that form in words ('64 hex characters (32 bytes)')
//   variable  the environment variable the --hardened parent hands the
//             file's identity on in (COUNTINGHOUSE_..., so it is kept out of
//             every module worker's environment)
//   refuse    message -> the Error a refusal throws (its own code)
const fs     = require('fs');
const winAcl = require('./win-acl');

// file -> its content, trimmed, or null when there is none. Throws spec.refuse
// on a link, a file that is not regular, one others can reach, or content not
// in spec.form.
function readChecked(file, spec) {
  const {what, refuse} = spec;
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw refuse(`${file}: ${e.message}`);
    return null;
  }
  if (st.isSymbolicLink()) throw refuse(`${file} is a symbolic link; ${what} is never read through a link`);
  if (!st.isFile()) throw refuse(`${file} is not a regular file`);
  let content = null;
  if (process.platform === 'win32' && process.permission != null) {
    // under --hardened no PowerShell can run (the permission model refuses
    // child processes): the parent checked the file before relaunching,
    // and this is that same file, unchanged (checkedByParent)
    content = checkedByParent(file, spec);
  } else if (process.platform === 'win32') {
    // no mode bits on Windows (every file reports 0666): its owner and ACL,
    // by SID (lib/win-acl.js), failing closed
    let acl = null;
    try { acl = winAcl.fileAcl(file); } catch (e) {
      throw refuse(e.code === 'ETIMEDOUT'
        ? `${file}'s permissions could not be checked in time (PowerShell took over 10 s); start again`
        : `${file}'s ACL could not be read (${e.code || 'PowerShell failed'})`);
    }
    const problem = winAcl.privateProblem(file, acl);
    if (problem != null) {
      const hint = winAcl.fixHint(file, acl);
      throw refuse(`${problem}; ${what} must be readable by this user only${hint != null ? `; to make it so, run:\n  ${hint}` : ''}`);
    }
  } else if ((st.mode & 0o077) !== 0) {
    throw refuse(`${file} is accessible by group or others (mode ${(st.mode & 0o777).toString(8)}); it must be 0600`);
  }
  if (content == null) content = fs.readFileSync(file, 'utf8').trim();
  if (!spec.form.test(content)) throw refuse(`${file} must hold ${what} as ${spec.formText}`);
  return content;
}

// Writes content to dir/<file>: whole, under a temporary name, then renamed
// into place, so no reader ever sees a partial file. flag: the option dir
// came from, for the refusal ('--moduleDataPath').
function createPrivate(dir, file, content, spec, flag) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    if (process.platform === 'win32') {
      // created with its DACL (this user and SYSTEM, nothing inherited) in
      // one call, never with the directory's: lib/win-acl.js createPrivate;
      // a rename on the same volume keeps the DACL
      winAcl.createPrivate(tmp, content);
    } else {
      fs.writeFileSync(tmp, content, {mode: 0o600, flag: 'wx'});
      fs.chmodSync(tmp, 0o600);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* never written */ }
    if (e.code === 'ETIMEDOUT') throw spec.refuse(`${spec.what} in ${dir} could not be written in time (PowerShell took over 10 s); start again`);
    throw spec.refuse(`${flag} ${dir} cannot be created or is not writable: set it to a writable directory (${e.code || e.message})`);
  }
}

// Under --hardened on Windows the child cannot create the file (no
// PowerShell for its DACL): its start is refused, naming the way that works.
function refuseAbsentUnderHardened(file, spec) {
  delete process.env[spec.variable];
  return spec.refuse(`${file} does not exist, and under --hardened on Windows it is created before the relaunch: start countinghouse with --hardened itself, not under --permission directly`);
}

// --hardened on Windows (the review of #197): the child runs under the
// permission model, which refuses the PowerShell the ACL check and the
// creation need. The parent, before it relaunches, creates the file if there
// is none (create), checks it as the child would (check), and hands on the
// file's identity: its path, volume (dev), file index (ino), size and mtime,
// in spec.variable. The file is opened first and its identity taken from
// that descriptor (the review of #208); then the checks, which look at the
// path; then the path must still name that same file, unchanged, or the
// start is refused: a swap during the check is never handed on as checked.
// create: () -> nothing, or false when no file is to be made (lib/identity.js:
// a secret given in the environment); check: () -> nothing, throws.
// hooks.afterOpen: a test's, between the open and the check.
const identityOf = (file, st) => ({path: file, dev: String(st.dev), ino: String(st.ino), size: String(st.size), mtimeNs: String(st.mtimeNs)});
function prepareForHardened(file, spec, {create, check}, hooks = {}) {
  let st = null;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw spec.refuse(`${file}: ${e.message}`); }
  if (st == null && create() === false) return;
  const fd = fs.openSync(file, 'r');
  try {
    const before = identityOf(file, fs.fstatSync(fd, {bigint: true}));
    if (typeof(hooks.afterOpen) === 'function') hooks.afterOpen(file);
    check();
    const atPath = identityOf(file, fs.lstatSync(file, {bigint: true}));
    const still = identityOf(file, fs.fstatSync(fd, {bigint: true}));
    if (['dev', 'ino'].some((k) => atPath[k] !== before[k]) || ['size', 'mtimeNs'].some((k) => still[k] !== before[k])) {
      throw spec.refuse(`${file} was changed or replaced while its permissions were checked: start again`);
    }
    process.env[spec.variable] = JSON.stringify(before);
  } finally {
    fs.closeSync(fd);
  }
}

// The child's side: the file the parent checked, unchanged, read from the
// same descriptor; the variable is removed as soon as it is read.
function checkedByParent(file, spec) {
  const given = process.env[spec.variable];
  delete process.env[spec.variable];
  let want = null;
  try { want = JSON.parse(String(given)); } catch (e) { want = null; }
  const unchecked = () => spec.refuse(`${file}'s permissions cannot be checked under --hardened on Windows here, and were not checked before the relaunch for this file: start countinghouse with --hardened itself`);
  if (want == null || typeof(want) !== 'object' || want.path !== file) throw unchecked();
  const fd = fs.openSync(file, 'r');
  try {
    const now = identityOf(file, fs.fstatSync(fd, {bigint: true}));
    if (['dev', 'ino', 'size', 'mtimeNs'].some((k) => now[k] !== want[k])) {
      throw spec.refuse(`${file} is not the file checked before the relaunch (it was changed or replaced since): start again`);
    }
    return fs.readFileSync(fd, 'utf8').trim();
  } finally {
    fs.closeSync(fd);
  }
}

// The directory the runtime keeps its own files in: <storePath> in the
// single-identity profile (the launcher's home, outside every module's
// namespace; LM1 spec section 4), else <moduleDataPath>, so a multi-tenant
// server keeps them when it moves to --store local (review of B4).
function ownDir(options) {
  return (options.singleIdentity === true && options.storePath != null) ? options.storePath : options.moduleDataPath;
}
const flagOf = (dir, options) => ((dir === options.moduleDataPath) ? '--moduleDataPath' : '--storePath');

module.exports = {readChecked, createPrivate, refuseAbsentUnderHardened, prepareForHardened, checkedByParent, ownDir, flagOf};

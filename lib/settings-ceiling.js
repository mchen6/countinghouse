'use strict';
// The operator's ceiling (part 3, section 4 of
// docs/superpowers/specs/2026-11-14-guarding-settings-by-conversation-design.md):
// an optional, machine-wide file that lowers the hard bounds of the guarding
// settings, forbids a loosening outright, or forbids conversational
// loosening entirely. It binds every path that loosens: conversation (the
// settings tool), the CLI and ch-local's start, which requires this file from
// the runtime it installed (one source).
//
// It is trusted only when an ordinary user cannot have written it, and a
// file that exists but fails any check fails closed: every loosening is then
// refused (SETTING_CEILING_UNTRUSTED). No file: the hard bounds apply.
// - Linux and macOS: /etc/countinghouse/ceiling.json. The file itself is not
//   a symbolic link; its directory's real path (macOS's /etc is a link) and
//   every directory above it are owned by root and not writable by group or
//   others; the file is opened with O_NOFOLLOW and checked by fstat the same
//   way, and read from that descriptor.
// - Windows: %ProgramData%\countinghouse\ceiling.json. The directory and the
//   file are not links, and their owner and every rule that grants a write
//   are Administrators, SYSTEM or TrustedInstaller, read by well-known SID
//   (PowerShell's Get-Acl as JSON, so no localized names); anything
//   unrecognized, a timeout or a missing PowerShell fails closed.
//
// The file: {"version": 1, "maxOutputBytes": <bytes>, "requestTimeout": <ms>,
// "forbid": ["moduleSandbox" | "autoUpgrade", ...], "packs": ["<name>", ...],
// "conversation": false}, every key but version optional; anything else in it
// fails closed.
const fs = require('fs');
const path = require('path');

const POSIX_FILE = '/etc/countinghouse/ceiling.json';
// packs: the operator's allowlist of packs (the reviewer's ruling on ch-local
// #18): when present, only those ever load, whatever settings.json or the
// user-writable history say; absent, no pack is restricted.
const FORBIDDABLE = ['moduleSandbox', 'autoUpgrade'];
const PACK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEYS = ['version', 'maxOutputBytes', 'requestTimeout', 'forbid', 'packs', 'conversation'];

// Administrators, SYSTEM, TrustedInstaller.
const TRUSTED_SIDS = new Set(['S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464']);
// FileSystemRights that let a holder change the file or what is in the
// directory: WriteData/CreateFiles, AppendData/CreateDirectories,
// WriteExtendedAttributes, DeleteSubdirectoriesAndFiles, WriteAttributes,
// Delete, ChangePermissions, TakeOwnership; GENERIC_ALL, GENERIC_WRITE.
const WRITE_MASK = (0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000) >>> 0;

// On Windows, ProgramData as the system knows it (the CommonApplicationData
// known folder), not the caller's %ProgramData%, which an ordinary user
// sets: pointed elsewhere, it would make the ceiling disappear. Asked once
// per process. (A user who controls their own processes, their code or
// their PowerShell, is beyond any ceiling: the user's own terminal is the
// user's, spec section 3.) opts.programData: a test's.
// PowerShell and the ACL script: lib/win-acl.js (by its full path, a minimal
// environment, no cmdlet).
const {windowsDir, runPowershell, DRIVE_PATH, PRELUDE, ACL_FN} = require('./win-acl');
const PROGRAMDATA_SCRIPT = "[Environment]::GetFolderPath('CommonApplicationData'); [Environment]::GetFolderPath('Windows')";
let knownProgramData = null;
function programDataFolder() {
  if (knownProgramData == null) {
    const [pd, win] = runPowershell(PROGRAMDATA_SCRIPT).split(/\r?\n/).map((s) => s.trim());
    if (String(win).toLowerCase() !== windowsDir().toLowerCase()) throw new Error(`the Windows directory is ${String(win).slice(0, 80)}, not SystemRoot`);
    knownProgramData = pd;
  }
  if (!DRIVE_PATH.test(knownProgramData)) throw new Error(`ProgramData is not a drive path (${knownProgramData.slice(0, 80)})`);
  return knownProgramData;
}
function ceilingFile(platform = process.platform, programData) {
  if (platform !== 'win32') return POSIX_FILE;
  return path.win32.join(programData != null ? programData : programDataFolder(), 'countinghouse', 'ceiling.json');
}

// {dir, file} -> {dir: {owner, rules}, file: {owner, rules}}, each rule
// {sid, rights, type, inheritOnly}, by PowerShell; throws on any failure.
const ACL_SCRIPT = PRELUDE.concat(ACL_FN, [
  "'{\"dir\":' + (A $env:CH_CEILING_DIR) + ',\"file\":' + (A $env:CH_CEILING_FILE) + '}'"
]).join('\n');
function powershellAcl(dir, file) {
  return JSON.parse(runPowershell(ACL_SCRIPT, {CH_CEILING_DIR: dir, CH_CEILING_FILE: file}));
}

// One object's ACL, as powershellAcl gives it -> a problem, or null.
function aclProblem(what, acl) {
  if (acl == null || typeof(acl) !== 'object' || typeof(acl.owner) !== 'string') return `${what}'s ACL could not be read`;
  if (!TRUSTED_SIDS.has(acl.owner)) return `${what} is owned by ${acl.owner}, not Administrators, SYSTEM or TrustedInstaller`;
  // only plain allow and deny rules are understood (lib/win-acl.js ACL_FN)
  if (acl.otherAces !== false) return `${what} has an access rule other than a plain allow or deny, or its rules could not all be read`;
  const rules = Array.isArray(acl.rules) ? acl.rules : (acl.rules != null ? [acl.rules] : []);
  for (const r of rules) {
    if (r == null || typeof(r.sid) !== 'string' || typeof(r.type) !== 'string' || !Number.isFinite(Number(r.rights))) return `${what} has an access rule that could not be read`;
    if (r.type === 'Deny' || r.inheritOnly === true) continue;
    if (r.type !== 'Allow') return `${what} has an access rule of type ${r.type}`;
    if ((Number(r.rights) >>> 0) & WRITE_MASK && !TRUSTED_SIDS.has(r.sid)) return `${what} is writable by ${r.sid}`;
  }
  return null;
}

// The file's text -> {ceiling} or {problem}.
function parse(text) {
  let v;
  try { v = JSON.parse(text); } catch (e) { return {problem: 'it is not JSON'}; }
  if (v == null || typeof(v) !== 'object' || Array.isArray(v) || v.version !== 1) return {problem: 'it is not a version 1 ceiling'};
  const unknown = Object.keys(v).find((k) => !KEYS.includes(k));
  if (unknown != null) return {problem: `it holds ${JSON.stringify(unknown).slice(0, 40)}, which a ceiling does not`};
  for (const k of ['maxOutputBytes', 'requestTimeout']) {
    if (v[k] !== undefined && !(Number.isInteger(v[k]) && v[k] > 0)) return {problem: `${k} is not a positive integer`};
  }
  // the runtime takes whole seconds: a ceiling it could only exceed fails closed
  if (v.requestTimeout !== undefined && (v.requestTimeout < 1000 || v.requestTimeout % 1000 !== 0)) {
    return {problem: 'requestTimeout is not a whole number of seconds (in milliseconds, at least 1000)'};
  }
  if (v.packs !== undefined && !(Array.isArray(v.packs) && v.packs.every((p) => typeof(p) === 'string' && PACK_NAME.test(p)))) {
    return {problem: 'packs is not a list of pack names'};
  }
  if (v.forbid !== undefined && !(Array.isArray(v.forbid) && v.forbid.every((f) => FORBIDDABLE.includes(f)))) {
    return {problem: `forbid may hold only ${FORBIDDABLE.join(', ')}`};
  }
  if (v.conversation !== undefined && typeof(v.conversation) !== 'boolean') return {problem: 'conversation is not true or false'};
  return {ceiling: {maxOutputBytes: v.maxOutputBytes, requestTimeout: v.requestTimeout, forbid: v.forbid || [],
    packs: v.packs !== undefined ? v.packs.slice() : null, conversation: v.conversation !== false}};
}

const posixProblem = (what, st) => {
  if (st.uid !== 0) return `${what} is not owned by root`;
  if ((st.mode & 0o022) !== 0) return `${what} is writable by group or others`;
  return null;
};

// -> {state: 'none'} | {state: 'trusted', file, ceiling} | {state: 'untrusted', file, problem}
// opts: platform, env, file, fs (the calls below), acl (Windows: (dir, file) -> ACLs).
function readCeiling(opts = {}) {
  const platform = opts.platform || process.platform;
  let file;
  try { file = opts.file || ceilingFile(platform, opts.programData); } catch (e) {
    return {state: 'untrusted', file: '%ProgramData%\\countinghouse\\ceiling.json', problem: `ProgramData could not be found (${e.code || e.message})`};
  }
  const f = opts.fs || fs;
  const untrusted = (problem) => ({state: 'untrusted', file, problem});
  const P = platform === 'win32' ? path.win32 : path.posix;
  let lst;
  try { lst = f.lstatSync(file); } catch (e) {
    if (e != null && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      // No file: the hard bounds, unless its directory exists and an
      // ordinary user could have made it (who could then remove the
      // operator's file): that fails closed too.
      const dirProblem = directoryProblem(platform, f, P.dirname(file), opts.acl);
      return dirProblem == null ? {state: 'none'} : untrusted(dirProblem);
    }
    return untrusted(`it cannot be examined (${e && e.code ? e.code : 'error'}); it and its directory must be readable by every user`);
  }
  if (lst.isSymbolicLink()) return untrusted('it is a symbolic link');
  if (!lst.isFile()) return untrusted('it is not a regular file');
  try {
    if (platform === 'win32') {
      const dir = P.dirname(file);
      if (f.lstatSync(dir).isSymbolicLink()) return untrusted('its directory is a link');
      let acl;
      try { acl = (opts.acl || powershellAcl)(dir, file); } catch (e) { return untrusted(`its ACL could not be read (${e && e.code ? e.code : 'PowerShell failed'})`); }
      const problem = aclProblem('its directory', acl && acl.dir) || aclProblem('the file', acl && acl.file);
      if (problem != null) return untrusted(problem);
      const read = parse(f.readFileSync(file, 'utf8'));
      return read.problem != null ? untrusted(read.problem) : {state: 'trusted', file, ceiling: read.ceiling};
    }
    // POSIX: the directory's real path, and every directory above it
    const dirReal = f.realpathSync.native(P.dirname(file));
    for (let d = dirReal; ; d = P.dirname(d)) {
      const problem = posixProblem(d, f.lstatSync(d));
      if (problem != null) return untrusted(problem);
      if (d === P.dirname(d)) break;
    }
    const fd = f.openSync(P.join(dirReal, P.basename(file)), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = f.fstatSync(fd);
      if (!st.isFile()) return untrusted('it is not a regular file');
      const problem = posixProblem('the file', st);
      if (problem != null) return untrusted(problem);
      const read = parse(f.readFileSync(fd, 'utf8'));
      return read.problem != null ? untrusted(read.problem) : {state: 'trusted', file, ceiling: read.ceiling};
    } finally {
      f.closeSync(fd);
    }
  } catch (e) {
    return untrusted(`it cannot be examined (${e && e.code ? e.code : 'error'})`);
  }
}

// A directory that holds no ceiling file: null when it does not exist or is
// one an ordinary user cannot have made, else why not.
function directoryProblem(platform, f, dir, acl) {
  let st;
  try { st = f.lstatSync(dir); } catch (e) {
    return (e != null && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) ? null : `its directory cannot be examined (${e && e.code ? e.code : 'error'})`;
  }
  if (st.isSymbolicLink()) return 'its directory is a link';
  if (platform !== 'win32') return posixProblem(dir, st);
  let a;
  try { a = (acl || powershellAcl)(dir, dir); } catch (e) { return `its directory's ACL could not be read (${e && e.code ? e.code : 'PowerShell failed'})`; }
  return aclProblem('its directory', a && a.dir);
}

module.exports = {readCeiling, ceilingFile, windowsDir, ACL_SCRIPT, PROGRAMDATA_SCRIPT, aclProblem, parse, TRUSTED_SIDS, WRITE_MASK, POSIX_FILE};

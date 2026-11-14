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
// "forbid": ["moduleSandbox" | "autoUpgrade" | "packs", ...],
// "conversation": false}, every key but version optional; anything else in it
// fails closed.
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const POSIX_FILE = '/etc/countinghouse/ceiling.json';
const FORBIDDABLE = ['moduleSandbox', 'autoUpgrade', 'packs'];
const KEYS = ['version', 'maxOutputBytes', 'requestTimeout', 'forbid', 'conversation'];

// Administrators, SYSTEM, TrustedInstaller.
const TRUSTED_SIDS = new Set(['S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464']);
// FileSystemRights that let a holder change the file or what is in the
// directory: WriteData/CreateFiles, AppendData/CreateDirectories,
// WriteExtendedAttributes, DeleteSubdirectoriesAndFiles, WriteAttributes,
// Delete, ChangePermissions, TakeOwnership; GENERIC_ALL, GENERIC_WRITE.
const WRITE_MASK = (0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000) >>> 0;

function ceilingFile(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return POSIX_FILE;
  return path.win32.join(env.ProgramData || 'C:\\ProgramData', 'countinghouse', 'ceiling.json');
}

// {dir, file} -> {dir: {owner, rules}, file: {owner, rules}}, each rule
// {sid, rights, type, inheritOnly}, by PowerShell; throws on any failure.
const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'function A($p) {',
  '  $a = Get-Acl -LiteralPath $p',
  '  $sid = [System.Security.Principal.SecurityIdentifier]',
  '  $rules = @($a.GetAccessRules($true, $true, $sid) | ForEach-Object { @{sid = $_.IdentityReference.Value; rights = [int64]$_.FileSystemRights; type = [string]$_.AccessControlType; inheritOnly = (($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)} })',
  '  @{owner = $a.GetOwner($sid).Value; rules = $rules}',
  '}',
  '@{dir = (A $env:CH_CEILING_DIR); file = (A $env:CH_CEILING_FILE)} | ConvertTo-Json -Depth 5 -Compress'
].join('\n');
function powershellAcl(dir, file) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT],
    {env: Object.assign({}, process.env, {CH_CEILING_DIR: dir, CH_CEILING_FILE: file}), timeout: 15000, encoding: 'utf8', windowsHide: true});
  return JSON.parse(out);
}

// One object's ACL, as powershellAcl gives it -> a problem, or null.
function aclProblem(what, acl) {
  if (acl == null || typeof(acl) !== 'object' || typeof(acl.owner) !== 'string') return `${what}'s ACL could not be read`;
  if (!TRUSTED_SIDS.has(acl.owner)) return `${what} is owned by ${acl.owner}, not Administrators or SYSTEM`;
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
  if (v.forbid !== undefined && !(Array.isArray(v.forbid) && v.forbid.every((f) => FORBIDDABLE.includes(f)))) {
    return {problem: `forbid may hold only ${FORBIDDABLE.join(', ')}`};
  }
  if (v.conversation !== undefined && typeof(v.conversation) !== 'boolean') return {problem: 'conversation is not true or false'};
  return {ceiling: {maxOutputBytes: v.maxOutputBytes, requestTimeout: v.requestTimeout, forbid: v.forbid || [], conversation: v.conversation !== false}};
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
  const file = opts.file || ceilingFile(platform, opts.env || process.env);
  const f = opts.fs || fs;
  const untrusted = (problem) => ({state: 'untrusted', file, problem});
  const P = platform === 'win32' ? path.win32 : path.posix;
  let lst;
  try { lst = f.lstatSync(file); } catch (e) {
    if (e != null && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return {state: 'none'};
    return untrusted(`it cannot be examined (${e && e.code ? e.code : 'error'})`);
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

module.exports = {readCeiling, ceilingFile, aclProblem, parse, TRUSTED_SIDS, WRITE_MASK, POSIX_FILE};

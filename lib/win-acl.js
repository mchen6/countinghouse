'use strict';
// Windows access control by well-known SID, read and set with the PowerShell
// in the Windows directory (no localized names, no icacls text). Shared by
// the operator's ceiling (lib/settings-ceiling.js) and the identity secret
// (lib/identity.js), where POSIX has mode bits and Windows has none (every
// file reports 0666 there).
//
// PowerShell is started by its absolute path under the Windows directory,
// never by name (Windows looks in the current directory first, where an
// agent could have put a powershell.exe), with its working directory there
// and a minimal environment: no PSModulePath, no profile; the security
// module is imported from beside that powershell.exe. Every caller fails
// closed on a throw.
const path = require('path');
const {execFileSync} = require('child_process');

const DRIVE_PATH = /^[A-Za-z]:\\[^"<>|?*\r\n]*$/;
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';

// The process's SystemRoot (the user's own environment: spec #169 section 3),
// which a caller may check against the Windows known folder.
function windowsDir() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  if (!DRIVE_PATH.test(root)) throw new Error(`SystemRoot is not a drive path (${String(root).slice(0, 80)})`);
  return root.replace(/\\+$/, '');
}

function runPowershell(script, extraEnv = {}) {
  const root = windowsDir();
  const system32 = path.win32.join(root, 'System32');
  return execFileSync(path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {cwd: system32, env: Object.assign({SystemRoot: root, windir: root}, extraEnv), timeout: 10000, encoding: 'utf8', windowsHide: true});
}

// Pure .NET, and no cmdlet from a module (Get-Acl, ConvertTo-Json,
// Join-Path, New-Object ...): calling one makes PowerShell look commands up,
// which without the caller's PSModuleAnalysisCachePath rebuilds its module
// analysis cache, some 20 s a call on the CI runner, and would load code
// from whatever module path it has. test/stdio/17 and test/auth/51 check
// none is named. The JSON is built by hand: a SID, a rights number and
// Allow or Deny hold no quote.
const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  '$sid = [System.Security.Principal.SecurityIdentifier]',
  '$inheritOnly = [System.Security.AccessControl.PropagationFlags]::InheritOnly'
];
// A $p's ACL as JSON: {"owner", "rules": [{sid, rights, type, inheritOnly}]}
// (inherited rules included: they are evaluated like any other).
const ACL_FN = [
  'function A($p) {',
  '  if ([System.IO.Directory]::Exists($p)) { $a = [System.IO.Directory]::GetAccessControl($p) } else { $a = [System.IO.File]::GetAccessControl($p) }',
  '  $r = @()',
  '  foreach ($x in $a.GetAccessRules($true, $true, $sid)) {',
  '    $io = (($x.PropagationFlags -band $inheritOnly) -ne 0)',
  "    $r += ('{\"sid\":\"' + $x.IdentityReference.Value + '\",\"rights\":' + [int64]$x.FileSystemRights + ',\"type\":\"' + [string]$x.AccessControlType + '\",\"inheritOnly\":' + ([string]$io).ToLower() + '}')",
  '  }',
  '  $o = $a.GetOwner($sid)',
  "  $ov = ''",
  '  if ($o -ne $null) { $ov = $o.Value }',
  "  '{\"owner\":\"' + $ov + '\",\"rules\":[' + ($r -join ',') + ']}'",
  '}'
];

// file -> {user: the current user's SID, owner, rules}; throws on any failure.
const FILE_ACL_SCRIPT = PRELUDE.concat(ACL_FN, [
  '$u = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  "(A $env:CH_ACL_FILE).Replace('{\"owner\"', '{\"user\":\"' + $u + '\",\"owner\"')"
]).join('\n');
function fileAcl(file) {
  return JSON.parse(runPowershell(FILE_ACL_SCRIPT, {CH_ACL_FILE: file}));
}

// Gives file a protected DACL (nothing inherited): full control for the
// current user and SYSTEM, no one else. Only the DACL is written (a fresh
// FileSecurity), so no privilege to set an owner is needed. Throws on any
// failure.
const RESTRICT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$a = [System.Security.AccessControl.FileSecurity]::new()',
  '$a.SetAccessRuleProtection($true, $false)',
  '$full = [System.Security.AccessControl.FileSystemRights]::FullControl',
  '$allow = [System.Security.AccessControl.AccessControlType]::Allow',
  '$u = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
  '$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($u, $full, $allow))',
  `$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('${SYSTEM}'), $full, $allow))`,
  '[System.IO.File]::SetAccessControl($env:CH_ACL_FILE, $a)'
].join('\n');
function restrictToUser(file) {
  runPowershell(RESTRICT_SCRIPT, {CH_ACL_FILE: file});
}

// Rights a rule may grant someone other than the file's people without
// letting them read or change it: Synchronize, ReadPermissions,
// ReadAttributes.
const HARMLESS = (0x100000 | 0x20000 | 0x80) >>> 0;

// A secret's ACL (fileAcl) -> a problem, or null. Owned by the current user,
// Administrators or SYSTEM; no allow rule grants anyone else more than
// HARMLESS; anything unrecognised fails closed.
function privateProblem(what, acl) {
  if (acl == null || typeof(acl) !== 'object' || typeof(acl.owner) !== 'string' || typeof(acl.user) !== 'string') return `${what}'s ACL could not be read`;
  const own = new Set([acl.user, SYSTEM, ADMINISTRATORS]);
  if (!own.has(acl.owner)) return `${what} is owned by ${acl.owner}, not this user, Administrators or SYSTEM`;
  const rules = Array.isArray(acl.rules) ? acl.rules : (acl.rules != null ? [acl.rules] : []);
  for (const r of rules) {
    if (r == null || typeof(r.sid) !== 'string' || typeof(r.type) !== 'string' || !Number.isFinite(Number(r.rights))) return `${what} has an access rule that could not be read`;
    if (r.type === 'Deny' || r.inheritOnly === true) continue;
    if (r.type !== 'Allow') return `${what} has an access rule of type ${r.type}`;
    if (!own.has(r.sid) && ((Number(r.rights) >>> 0) & ~HARMLESS) !== 0) return `${what} is accessible by ${r.sid}`;
  }
  return null;
}

module.exports = {windowsDir, runPowershell, fileAcl, restrictToUser, privateProblem, PRELUDE, ACL_FN, FILE_ACL_SCRIPT, RESTRICT_SCRIPT, SYSTEM, ADMINISTRATORS, DRIVE_PATH};

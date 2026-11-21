'use strict';
// A small file the runtime keeps for itself beside its data, readable and
// writable by its own user only (lib/identity.js's identity secret, and
// lib/server-id.js's server id): never read through a link, never a file
// others can reach (mode 0600; on Windows its owner and ACL, by SID, through
// lib/win-acl.js), never a file with a second name (a hard link), read from
// the descriptor its checks were made on; written whole under a temporary
// name and published under its own with a hard link (or an exclusive
// create where there are none), never over a file already there; and under
// --hardened on Windows checked by the parent before the relaunch
// (prepareForHardened), the child taking the file as checked only if it is
// that same file, unchanged (checkedByParent).
//
// spec: {what, form, formText, variable, refuse}
//   what      the file's content in a message ('the identity secret')
//   form      a RegExp its content must match
//   formText  that form in words ('64 hex characters (32 bytes)')
//   variable  the environment variable the --hardened parent hands the
//             file's identity on in (COUNTINGHOUSE_..., so it is kept out of
//             every module worker's environment)
//   refuse    (message, kind) -> the Error a refusal throws (its own code);
//             kind says what the refusal is about: 'owner', 'mode' (others
//             may read it), 'mode-w' (others may write it) or 'acl' (this
//             user's own, but its ACL lets others in, or can't be read), else
//             undefined, so a caller can name its fix
//             (lib/auth/private-store.js fixFor)
//   ownerUnchecked  true: read without the owner, mode and ACL checks (the
//             others all made), for a caller that applies only what
//             tightens from it
const fs     = require('fs');
const winAcl = require('./win-acl');
const log    = require('./lazy-require').lazy('./logger');

const WIN = process.platform === 'win32';
// open() that refuses a link at the last component (POSIX; Windows has none,
// and compares the file's identity before and after instead)
const NOFOLLOW = (fs.constants.O_NOFOLLOW != null) ? fs.constants.O_NOFOLLOW : 0;

// A file another start is publishing this moment (its temporary name still
// there beside it, or a create still writing it) reads as not settled: a
// reader that just lost the race to make it waits for it, briefly
// (readChecked's settle), rather than refuse a file about to be whole.
const UNSETTLED = Symbol('countinghouse.privateFileUnsettled');
const SETTLE_TRIES = 50;
const SETTLE_MS = 20;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// On Windows each owner and ACL read is a PowerShell run (1 to 10 s on a CI
// runner): prefetchAcls reads every file a start checks in one run, and the
// check takes a file's from here when it is that same file (its volume and
// index, before and after the read), else reads its own.
const prefetched = new Map();   // path -> {acl, dev, ino}
function prefetchAcls(files) {
  if (!WIN || process.permission != null) return;
  const there = files.map((f) => { try { return [f, fs.lstatSync(f, {bigint: true})]; } catch (e) { return null; } })
    .filter((x) => x != null && x[1].isFile());
  if (there.length === 0) return;
  let acls;
  try { acls = winAcl.fileAcls(there.map((x) => x[0])); } catch (e) { return; }   // each check reads its own, and refuses as it should
  there.forEach(([f, before], i) => {
    let after = null;
    try { after = fs.lstatSync(f, {bigint: true}); } catch (e) { return; }
    if (after.dev === before.dev && after.ino === before.ino) prefetched.set(f, {acl: acls[i], dev: before.dev, ino: before.ino});
  });
}

// One file's ACL read ahead off the main thread (an async PowerShell
// child), handed to its caller, which passes it to readChecked as
// spec.ahead (no shared state: the read takes that one, of that same file,
// or refuses). -> Promise of {acl, dev, ino}, or null when it could not be
// read, or the file changed meanwhile; undefined off Windows (nothing to
// read ahead: spec.ahead undefined is the ordinary check).
async function aclAhead(file) {
  if (!WIN || process.permission != null) return undefined;
  const stat = () => { try { return fs.lstatSync(file, {bigint: true}); } catch (e) { return null; } };
  const before = stat();
  if (before == null || !before.isFile()) return null;
  let acl;
  try { acl = await winAcl.fileAclAsync(file); } catch (e) { return null; }
  const after = stat();
  return (after != null && after.dev === before.dev && after.ino === before.ino) ? {acl, dev: before.dev, ino: before.ino} : null;
}

// file -> its content, trimmed, or null when there is none. Throws spec.refuse
// on a link, a file that is not regular or has a second name, one others can
// reach, or content not in spec.form. A file another start is publishing
// this moment is given that moment to finish (UNSETTLED, about a second),
// whichever start read first (the medium review of #463's round 2, 1);
// settle: false refuses at once.
function readChecked(file, spec, {settle = true} = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return readOnce(file, spec);
    } catch (e) {
      if (!settle || e[UNSETTLED] !== true || attempt >= SETTLE_TRIES) throw e;
      sleepSync(SETTLE_MS);
    }
  }
}

function readOnce(file, spec) {
  const {what, refuse} = spec;
  const unsettled = (message) => Object.assign(refuse(message), {[UNSETTLED]: true});
  let st = null;
  try {
    st = fs.lstatSync(file, {bigint: true});
  } catch (e) {
    if (e.code !== 'ENOENT') throw refuse(`${file}: ${e.message}`);
    return null;
  }
  if (st.isSymbolicLink()) throw refuse(`${file} is a symbolic link; ${what} is never read through a link`);
  if (!st.isFile()) throw refuse(`${file} is not a regular file`);
  // spec.ownerUnchecked: read without the owner, mode and ACL checks -- the
  // link, regular-file, one-name and size checks all still made, of the
  // descriptor -- for a caller that applies only what tightens from what it
  // reads (lib/auth/file-provider.js reload)
  const unchecked = spec.ownerUnchecked === true;
  // under --hardened no PowerShell can run (the permission model refuses
  // child processes): the parent checked the file before relaunching, and
  // this is that same file, unchanged (checkedByParent)
  if (WIN && process.permission != null && !unchecked) return formed(checkedByParent(file, spec), file, spec, unsettled);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    if (e.code === 'ELOOP') throw refuse(`${file} is a symbolic link; ${what} is never read through a link`);
    throw refuse(`${file}: ${e.message}`);
  }
  try {
    // the checks are of the file this descriptor holds, never of the path
    // read again: a link or a file swapped in after the lstat is not read
    const held = fs.fstatSync(fd, {bigint: true});
    if (!held.isFile()) throw refuse(`${file} is not a regular file`);
    // (opt-in, of this same descriptor: spec.maxBytes, its size; spec.ownOnly,
    // this user's own on POSIX -- Windows' ACL check names the owner)
    if (spec.maxBytes != null && held.size > BigInt(spec.maxBytes)) throw refuse(`${file} is larger than ${spec.maxBytes} bytes`);
    if (spec.ownOnly === true && !unchecked && !WIN && typeof(process.getuid) === 'function' && Number(held.uid) !== process.getuid()) {
      throw refuse(`${file} is not this user's own; ${what} is read only from a file this user owns`, 'owner');
    }
    if (held.nlink !== 1n && strayTmpsGone(file, held) !== 1n) {
      throw unsettled(`${file} has ${held.nlink} names (hard links); ${what} is kept under one name only`);
    }
    if (WIN) {
      // no O_NOFOLLOW and no mode bits on Windows (every file reports 0666):
      // the path named this file when it was opened, its owner and ACL are
      // read by SID (lib/win-acl.js) failing closed, and the path still names
      // it after that read
      const same = (s) => s.dev === held.dev && s.ino === held.ino;
      if (!same(st)) throw refuse(`${file} was changed or replaced while it was opened: start again`);
      // (spec.ahead given, from aclAhead: that one or none, never a
      // PowerShell run on this thread; else the start's prefetch, or its own)
      const given = spec.ahead !== undefined;
      const ahead = given ? spec.ahead : prefetched.get(file);
      if (!given) prefetched.delete(file);
      if (unchecked) return formed(fs.readFileSync(fd, 'utf8').trim(), file, spec, unsettled);
      let acl = (ahead != null && ahead.dev === held.dev && ahead.ino === held.ino) ? ahead.acl : null;
      if (acl == null && given) throw Object.assign(refuse(`${file}'s permissions could not be checked ahead of the read: try again`, 'acl'), {aclAhead: true});
      if (acl == null) {
        try { acl = winAcl.fileAcl(file); } catch (e) {
          // (either way the check could not be made: 'acl', as one that can't
          // run)
          throw refuse(e.code === 'ETIMEDOUT'
            ? `${file}'s permissions could not be checked in time (PowerShell took over 10 s); start again`
            : `${file}'s ACL could not be read (${e.code || 'PowerShell failed'})`, 'acl');
        }
      }
      let now = null;
      try { now = fs.lstatSync(file, {bigint: true}); } catch (e) { now = null; }
      if (now == null || !same(now)) throw refuse(`${file} was changed or replaced while its permissions were checked: start again`);
      const problem = winAcl.privateProblem(file, acl);
      if (problem != null) {
        const hint = winAcl.fixHint(file, acl);
        // ('owner' when another account owns it: never read unchecked)
        throw refuse(`${problem}; ${what} must be readable by this user only${hint != null ? `; to make it so, run:\n  ${hint}` : ''}`, acl.owner === acl.user ? 'acl' : 'owner');
      }
    } else if (!unchecked && (Number(held.mode) & 0o077) !== 0) {
      // ('mode' when others may only read it; 'mode-w' when they may write
      // it: a file they could have written is never read unchecked)
      throw refuse(`${file} is accessible by group or others (mode ${(Number(held.mode) & 0o777).toString(8)}); it must be 0600`, (Number(held.mode) & 0o022) !== 0 ? 'mode-w' : 'mode');
    }
    return formed(fs.readFileSync(fd, 'utf8').trim(), file, spec, unsettled);
  } finally {
    fs.closeSync(fd);
  }
}

// A publish cut short between its link and its temporary name's removal (a
// crash, a kill) leaves the file under a second name, <file>.<pid>.tmp, and
// every later read would refuse it: such a name, of this very file, in its
// own directory, is removed (a publish still under way loses nothing: its
// own removal finds it gone). -> the file's name count after.
function strayTmpsGone(file, held) {
  const dir = require('path').dirname(file);
  const stray = new RegExp(`^${require('path').basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.tmp$`);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return held.nlink; }
  for (const name of names) {
    if (!stray.test(name)) continue;
    const p = require('path').join(dir, name);
    try {
      const st = fs.lstatSync(p, {bigint: true});
      if (st.isFile() && st.dev === held.dev && st.ino === held.ino) {
        fs.unlinkSync(p);
        try { log().W(`${p} was a second name of ${file}, left by a publish cut short: removed`); } catch (logErr) { /* no logger yet */ }
      }
    } catch (e) { /* gone already, or not ours to remove: counted below */ }
  }
  try { return fs.lstatSync(file, {bigint: true}).nlink; } catch (e) { return held.nlink; }
}

// (a file not in its form may be one an exclusive create is still writing)
function formed(content, file, spec, unsettled) {
  if (!spec.form.test(content)) throw unsettled(`${file} must hold ${spec.what} as ${spec.formText}`);
  return content;
}

// A link that fails for want of hard links on this file system (vfat, some
// network shares): the file is then made by an exclusive create. EPERM is
// that on POSIX (Linux on vfat), never on Windows, where it is a refusal.
const NO_LINK_CODES = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
const noLinks = (e) => NO_LINK_CODES.has(e.code) || (!WIN && e.code === 'EPERM');

// Writes content to dir/<file> as this user's alone, never over a file
// already there: two starts on one directory making it at once keep one
// file, and the one that lost reads the winner's (readChecked with settle).
// Whole under a temporary name, then published with a hard link, so no
// reader sees a partial file; on a file system without hard links, by an
// exclusive create of the file itself (a reader may then meet it partial,
// and settles). -> true when this content is the file's, false when another
// was there first. flag: the option dir came from, for the refusal
// ('--moduleDataPath').
function createPrivate(dir, file, content, spec, flag) {
  const tmp = `${file}.${process.pid}.tmp`;
  const writeNew = (where) => {
    if (WIN) {
      // created with its DACL (this user and SYSTEM, nothing inherited) in
      // one call, never with the directory's, and never over a name that
      // exists (CreateNew): lib/win-acl.js createPrivate
      winAcl.createPrivate(where, content);
    } else {
      fs.writeFileSync(where, content, {mode: 0o600, flag: 'wx'});
      fs.chmodSync(where, 0o600);
    }
  };
  const refused = (e) => {
    if (e.code === 'ETIMEDOUT') return spec.refuse(`${spec.what} in ${dir} could not be written in time (PowerShell took over 10 s); start again`);
    return spec.refuse(`${flag} ${dir} cannot be created or is not writable: set it to a writable directory (${e.code || e.message})`);
  };
  try {
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    writeNew(tmp);
  } catch (e) {
    removeTmp(tmp, false);
    throw refused(e);
  }
  try {
    fs.linkSync(tmp, file);
  } catch (e) {
    removeTmp(tmp, false);
    if (e.code === 'EEXIST') return false;
    if (!noLinks(e)) throw refused(e);
    try {
      writeNew(file);
    } catch (e2) {
      // (a name that exists now is another start's: its file stands)
      if (e2.code === 'EEXIST' || exists(file)) return false;
      throw refused(e2);
    }
    return true;
  }
  removeTmp(tmp, true);
  return true;
}

const exists = (file) => { try { fs.lstatSync(file); return true; } catch (e) { return false; } };

// The temporary name goes once the file is published (or was never): a
// failure to remove it is logged, never the start's end. Published, it is a
// second name of the file itself: tried again, and its path logged if it
// stays (the file then reads as unsettled, and is refused, until it goes).
function removeTmp(tmp, published) {
  for (let i = 0; i < 3; i++) {
    try { fs.unlinkSync(tmp); return; } catch (e) {
      if (e.code === 'ENOENT') return;
      if (i === 2) {
        try {
          log().W(published
            ? `${tmp} could not be removed (${e.code}): it is a second name of the file published beside it; remove it`
            : `${tmp} could not be removed (${e.code}); remove it`);
        } catch (logErr) { /* no logger yet */ }
        return;
      }
      sleepSync(SETTLE_MS);
    }
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

// The child's side: the file the parent checked, unchanged and still under
// one name, read from the same descriptor; the variable is removed as soon
// as it is read.
function checkedByParent(file, spec) {
  const given = process.env[spec.variable];
  delete process.env[spec.variable];
  let want = null;
  try { want = JSON.parse(String(given)); } catch (e) { want = null; }
  const unchecked = () => spec.refuse(`${file}'s permissions cannot be checked under --hardened on Windows here, and were not checked before the relaunch for this file: start countinghouse with --hardened itself`);
  if (want == null || typeof(want) !== 'object' || want.path !== file) throw unchecked();
  const fd = fs.openSync(file, 'r');
  try {
    const held = fs.fstatSync(fd, {bigint: true});
    const now = identityOf(file, held);
    if (['dev', 'ino', 'size', 'mtimeNs'].some((k) => now[k] !== want[k])) {
      throw spec.refuse(`${file} is not the file checked before the relaunch (it was changed or replaced since): start again`);
    }
    if (held.nlink !== 1n) throw spec.refuse(`${file} has ${held.nlink} names (hard links); ${spec.what} is kept under one name only`);
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

module.exports = {readChecked, createPrivate, refuseAbsentUnderHardened, prepareForHardened, checkedByParent, prefetchAcls, aclAhead, ownDir, flagOf};

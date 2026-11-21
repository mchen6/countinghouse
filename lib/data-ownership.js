'use strict';
// Which data directories the runtime may delete recursively (A-overlap-rm;
// the reviewer's ruling, split out of #452 round 3): only those it MADE.
// That covers /tmp emptied at every spawn (worker, session, single-thread),
// a module's data purged by an uninstall, and a session's partition removed.
//
// - When ensureDirs or ensureSessionDirs creates a data or tmp directory, it
//   records that directory's identity in an ownership marker, MARKER, in the
//   directory that holds them: <name>/ for a module, <name>/sessions/<id>/
//   for a session. No worker sees that directory: a worker's /data and /tmp
//   are data/ and tmp/ themselves.
// - Every read of a marker, and every ownership check, is made only through
//   real directories: from just below --moduleDataPath down to the
//   directory, none a link (module-data notRealBelow; the reviewer's high on
//   #467, 3). A <name>/ or @scope that is a link to another module's
//   leads to that module's marker, which must never vouch for it.
// - Before a recursive delete, ownedDir: the directory, as it is now (a real
//   directory), must be the one the marker names. Otherwise it was not made
//   here, or was changed since: it is never emptied or removed, and that is
//   said once per process for that directory as it is (unowned).
// - A directory made before markers existed (an install before this
//   version) is adopted (adopt) only at the path the runtime would have made
//   it, through real directories only, and only when the overlap judgement
//   passed for it. Where: a module's first spawn and a session worker's
//   spawn (the broker's own judgement, lib/fs-broker/index.js), single-
//   thread mode, an uninstall, a session's end and the start's sweep
//   (codeInside). No package name or file layout is ever read to decide.
//
// The marker: JSON {v: 1, dirs: {data?: {dev, ino, birth}, tmp?: {...}}},
// each a decimal string; owner-only (0600; on Windows a mode is only the
// read-only attribute, so it is not checked there); written to a fresh name
// with O_EXCL, then renamed over the marker (atomic on POSIX, and on
// Windows, where rename replaces). A marker that is not a regular file, not
// owner-only, larger than MAX_BYTES, or not that shape is no marker: every
// directory it would name is unowned.
//
// birth is the directory's creation time in ns (statx on Linux, the creation
// time on Windows): an inode number is reused at once after a removal (ext4
// hands a directory made right after an rm -r the same one), and birth tells
// that new directory from the one recorded. It is '0' where the file system's
// birth times aren't real (birthIsReal), and a '0' on either side is not
// compared: then only dev and ino are.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const {BIG} = require('./file-identity');

const MARKER = '.countinghouse-owned';
const MAX_BYTES = 4096;
const WHICH = ['data', 'tmp'];
const DIGITS = /^[0-9]{1,40}$/;

const isId = (e) => e != null && typeof(e) === 'object' && ['dev', 'ino', 'birth'].every((k) => typeof(e[k]) === 'string' && DIGITS.test(e[k]));

// Whether p is reached from base (--moduleDataPath) through real directories
// only, itself one too (module-data's one walk)
async function realFrom(base, p) {
  return (await require('./module-data').notRealBelow(base, p, {missing: 'refuse'})) == null;
}

// -> {data?: {dev, ino, birth}, tmp?: {...}}: what the marker in `holder`
// names ({} for none, one that is no marker, or a holder not reached through
// real directories from `base`)
async function readMarker(holder, base) {
  if (!(await realFrom(base, holder))) return {};
  const file = path.join(holder, MARKER);
  let st;
  try { st = await fsp.lstat(file); } catch (e) { return {}; }
  if (!st.isFile() || st.size > MAX_BYTES) return {};
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return {};
  let doc;
  try { doc = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { return {}; }
  if (doc == null || doc.v !== 1 || doc.dirs == null || typeof(doc.dirs) !== 'object') return {};
  const out = {};
  for (const which of WHICH) if (isId(doc.dirs[which])) out[which] = {dev: doc.dirs[which].dev, ino: doc.dirs[which].ino, birth: doc.dirs[which].birth};
  return out;
}

// Whether a file system's birth times are real, per device. Where statx is
// refused (a container's seccomp filter, say), libuv reports a directory's
// ctime as its birth time, which moves with every entry made in it. Decided
// by comparison, not by time passing (the reviewer's high on #467, 2): a
// probe directory of the runtime's own is made in `where` -- the directory
// being judged itself, so the probe answers for its own device, never in a
// session's root, whose rmdir it could race (the high's round 3, 5 and 7) --
// then an entry
// written in it, which must move its ctime (on any file system the holder is
// writable on, and on NTFS: a chmod is refused on some, CIFS or vfat, and
// changes nothing on Windows -- the medium on the high round, 1 and 3),
// until its ctime is past its birth time or PROBE_MS have gone by (a coarse
// clock's tick); its birth is real when it did not move with the entry and
// the ctime moved past it. Never past: not real. A probe that fails (ENOSPC,
// EMFILE, a read-only holder) is not remembered (its high, 1): null for this
// call, and asked again the next. One probe per device at a time: callers
// share it while it runs (the medium, 5).
const PROBE_MS = 100;
const birthReal = new Map();   // dev -> Promise of boolean (null: failed, dropped)
// every probe still running (each removes its own directory when it ends):
// probesSettled waits for them, so a test's cleanup never races one
const probesInFlight = new Set();
function birthIsReal(where, dev) {
  if (!birthReal.has(dev)) {
    const p = probeBirth(where).then((real) => {
      if (real == null) birthReal.delete(dev);
      return real;
    });
    probesInFlight.add(p);
    p.finally(() => probesInFlight.delete(p)).catch(() => {});
    birthReal.set(dev, p);
  }
  return birthReal.get(dev);
}
async function probeBirth(where) {
  let probe = null;
  try {
    probe = await fsp.mkdtemp(path.join(where, `${MARKER}-probe-`));
    const born = (await fsp.lstat(probe, BIG)).birthtimeNs;
    for (let i = 0, until = Date.now() + PROBE_MS; ; i++) {
      await fsp.writeFile(path.join(probe, String(i)), '');
      const st = await fsp.lstat(probe, BIG);
      if (st.birthtimeNs !== born) return false;   // it moved with the entry: a ctime
      if (born !== 0n && st.ctimeNs > born) return true;
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } catch (e) {
    return null;
  } finally {
    if (probe != null) await fsp.rm(probe, {recursive: true, force: true}).catch(() => {});
  }
}

// A real directory's identity, as the marker keeps it; null for anything
// else (missing, a link, a file). birth: null when its probe failed this
// time (nothing is recorded from it, and it owns nothing); '0' where this
// host's birth times aren't real. The probe, when one runs, runs in `dir`
// (its own device); one that can't run there (a module made its /data
// 0500, say) runs in `base`, --moduleDataPath, when that is on the same
// device (the medium on the high's round 3, 2). match: {dev, ino} to read
// the birth for only when the directory is that one, so nothing is written
// into a directory not already known to be this one.
async function identityOf(dir, base = null, match = null) {
  let st;
  try { st = await fsp.lstat(dir, BIG); } catch (e) { return null; }
  if (!st.isDirectory()) return null;
  const id = {dev: String(st.dev), ino: String(st.ino)};
  if (match != null && (id.dev !== match.dev || id.ino !== match.ino)) return Object.assign(id, {birth: null});
  let real = await birthIsReal(dir, id.dev);
  if (real == null && base != null) {
    const b = await fsp.lstat(base, BIG).catch(() => null);
    if (b != null && b.isDirectory() && String(b.dev) === id.dev) real = await birthIsReal(base, id.dev);
  }
  return Object.assign(id, {birth: real == null ? null : (real ? String(st.birthtimeNs) : '0')});
}
// -> 'owned', 'unmarked' (another directory), 'unknown' (can't be told
// now: this call's probe failed), or 'unreadable' (a birth was recorded, and
// this host's birth times aren't real: never dropped to dev and ino alone,
// the medium on the high round, 4). An entry recorded '0' is accepted by dev
// and ino only on a device whose birth times are not real; where they are,
// it is 'unknown', never owned, so a stale '0' entry can't claim a new
// directory with a reused inode (the high's round 3, 6).
// (a '0' entry on a host whose birth times are real, and a real birth on one
// whose aren't, are both 'unreadable': lasting, so said with the recovery,
// never "checked again": the medium on the high's round 3, 1)
function compareId(id, named) {
  if (id == null) return 'unmarked';
  if (id.dev !== named.dev || id.ino !== named.ino) return 'unmarked';
  if (id.birth == null) return 'unknown';
  if ((named.birth === '0') !== (id.birth === '0')) return 'unreadable';
  return id.birth === named.birth ? 'owned' : 'unmarked';
}

// Records `dirs` ({data?: path, tmp?: path}), each as it is now, in the
// marker in `holder`; the marker's other entries are kept. A directory that
// is not a real one, one whose identity can't be read whole this time, or
// a holder not reached through real directories from `base`, is not
// recorded.
async function record(holder, dirs, base) {
  if (!(await realFrom(base, holder))) return;
  const current = await readMarker(holder, base);
  let changed = false;
  for (const which of WHICH) {
    if (dirs[which] == null) continue;
    const id = await identityOf(dirs[which], base);
    if (id != null && id.birth != null) { current[which] = id; changed = true; }
  }
  if (!changed) return;
  await writeMarker(holder, current);
}

// The marker in `holder`, written whole: to a fresh O_EXCL name, then
// renamed over it (the caller has checked the holder is reached through
// real directories).
async function writeMarker(holder, dirs) {
  const fresh = path.join(holder, `${MARKER}.${crypto.randomBytes(6).toString('hex')}`);
  try {
    const fh = await fsp.open(fresh, 'wx', 0o600);
    try { await fh.writeFile(`${JSON.stringify({v: 1, dirs})}\n`); } finally { await fh.close(); }
    await fsp.rename(fresh, path.join(holder, MARKER));
  } catch (e) {
    await fsp.unlink(fresh).catch(() => {});
    throw e;
  }
}

// Whether `dir`, as it is now, is the `which` the marker in `holder` names,
// both reached from `base` through real directories only. marks: the
// marker as already read (readMarker, adopt), or read here.
// -> {state: 'owned' | 'unmarked' | 'link' | 'unknown', at?: the link}
async function ownership(holder, which, dir, base, marks = null) {
  const bad = await require('./module-data').notRealBelow(base, dir, {missing: 'refuse'});
  if (bad != null) return bad.why === 'a link' ? {state: 'link', at: bad.path} : {state: 'unmarked'};
  const named = (marks != null ? marks : await readMarker(holder, base))[which];
  if (named == null) return {state: 'unmarked'};
  return {state: compareId(await identityOf(dir, base, named), named)};
}
const ownedDir = async (holder, which, dir, base, marks = null) => (await ownership(holder, which, dir, base, marks)).state === 'owned';

// What is said of a directory kept, once per process for it as it is
// (the medium on the high round, 2, 7, 8, 9: each its own advice):
//   unmarked: not made here, or changed since (the recovery for a restored
//     --moduleDataPath)
//   link: reached through a link, which the runtime never deletes through
//   unknown: couldn't be checked now
//   unreadable: recorded where birth times read differently from here
//   foreign: a root holding files the runtime didn't make
function keptSaid(o, dir, action, say, holder = path.dirname(dir)) {
  if (o.state === 'unmarked') return unowned(dir, action, say, holder);
  const key = `${o.state}\0${path.resolve(dir)}`;
  if (said.has(key)) return;
  said.add(key);
  if (typeof(say) !== 'function') return;
  if (o.state === 'link') say(`${dir} is reached through a link (${o.at}): a module's data directory can't be a symlink (use a bind mount), and the runtime never empties or removes anything through one, so it is not ${action}`);
  else if (o.state === 'unknown') say(`${dir} could not be checked now (its identity could not be read whole), so it is not ${action} this time; it is checked again at the next start`);
  else if (o.state === 'unreadable') say(`${dir} can't be checked on this host (it was recorded where birth times read differently), so it is not ${action} -- stop the runtime and delete ${path.join(holder, MARKER)} to have it adopted again`);
  else if (o.state === 'foreign') say(`${dir} holds files the runtime did not make, so it is not ${action} -- clear them by hand`);
}

// The marker itself, removed with the directories it named (a purge, a
// partition's removal); a link or a file of that name goes too, and a fresh
// one a crash left mid-write (record's), so the holder can then be rmdir'd
// (the medium on A-overlap-rm, 7). Files only, never a directory (no probe
// runs here: the high's round 3, 7). Called only on a holder reached through
// real directories (removeOwned).
async function removeMarker(holder) {
  const entries = await fsp.readdir(holder, {withFileTypes: true}).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() && (e.name === MARKER || e.name.startsWith(`${MARKER}.`))) {
      await fsp.unlink(path.join(holder, e.name)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    }
  }
}

// Whether `dir` is where the runtime would have made it: below `base`
// (--moduleDataPath; an operator's link at or above it is theirs and
// allowed), through real directories only, itself one (module-data's walk:
// no realpath, which --hardened's permission model may refuse).
const atExpectedPath = (dir, base) => realFrom(base, dir);

// Said once per process for each directory as it is (its path and
// identity): a directory not made here is kept, never emptied or removed.
const said = new Set();
// action: what is not done to it ('emptied', 'removed'); holder: where its
// marker is, named in the recovery the line ends with (a --moduleDataPath
// restored from a backup or moved names other directories: the reviewer,
// #467)
function unowned(dir, action, say, holder = path.dirname(dir)) {
  let key = `${path.resolve(dir)}`;
  try { const st = fs.lstatSync(dir, BIG); key += `\0${st.dev}:${st.ino}:${st.birthtimeNs}`; } catch (e) { /* missing: the path alone */ }
  if (said.has(key)) return;
  said.add(key);
  const text = `${dir} was not made by this runtime (no ownership mark for it), so it is not ${action}` +
    ' -- if it is yours to clear, clear it by hand; moved aside, the next start makes a new one' +
    ` -- if --moduleDataPath was restored from a backup or moved, stop the runtime and delete ${path.join(holder, MARKER)}: it is adopted again at its next start`;
  if (typeof(say) === 'function') say(text);
}
// ... and one that holds module code the runtime knows, once likewise
function holdsCode(dir, action, say) {
  const key = `code\0${path.resolve(dir)}`;
  if (said.has(key)) return;
  said.add(key);
  if (typeof(say) === 'function') say(`${dir} holds module code this runtime knows, so it is not ${action} -- move that module out of it`);
}

// u+rwx put back on every directory in the tree (lstat, never a link: a
// module can make one 0500 through its broker), then the tree removed by
// fs.rm, which walks no link inside it. Only for a directory ownedDir said
// is the runtime's.
async function writableTree(dir) {
  await fsp.chmod(dir, 0o700).catch(() => {});
  const entries = await fsp.readdir(dir, {withFileTypes: true}).catch(() => []);
  for (const e of entries) if (e.isDirectory()) await writableTree(path.join(dir, e.name));
}
async function removeOwnedTree(dir) {
  await writableTree(dir);
  await fsp.rm(dir, {recursive: true, force: true});
}

// The data and tmp a holder (<name>/, or a session's root) has, each removed
// when it is the runtime's own (ownedDir), and kept, said once, when not; a
// link or a file of that name is unlinked, never followed. The marker goes
// once nothing it named is kept. A holder not reached through real
// directories from `base` keeps everything. -> [path kept]
// code: what module code the runtime knows (knownCode): an owned directory
// holding some is kept too, said once. marks: the marker as adopt read it.
async function removeOwned(holder, d, base, say, code = null, marks = null) {
  const kept = [];
  const removed = [];
  const known = marks != null ? marks : await readMarker(holder, base);
  for (const which of WHICH) {
    const dir = d[which];
    let st;
    try { st = await fsp.lstat(dir); } catch (e) { continue; }
    if (!st.isDirectory()) {
      const bad = await require('./module-data').notRealBelow(base, holder, {missing: 'refuse'});
      if (bad == null) { await fsp.unlink(dir); continue; }
      keptSaid(bad.why === 'a link' ? {state: 'link', at: bad.path} : {state: 'unmarked'}, dir, 'removed', say, holder);
      kept.push(dir);
      continue;
    }
    const o = await ownership(holder, which, dir, base, known);
    if (o.state === 'owned') {
      if (code == null || !(await codeInside(dir, code))) { await removeOwnedTree(dir); removed.push(which); continue; }
      holdsCode(dir, 'removed', say);
    } else {
      keptSaid(o, dir, 'removed', say, holder);
    }
    kept.push(dir);
  }
  // (never through a link: the high's round 3, 1)
  if (!(await realFrom(base, holder))) return kept;
  if (kept.length === 0) {
    await removeMarker(holder);
  } else if (removed.length > 0) {
    // the marker rewritten without each entry whose directory went, so no
    // stale entry can later name a new directory with a reused inode (the
    // high's round 3, 6)
    const left = await readMarker(holder, base);
    for (const which of removed) delete left[which];
    await writeMarker(holder, left);
  }
  return kept;
}

// Whether module code the runtime knows is inside `dir` or around it, as
// the broker's overlap judgement asks it (lib/fs-broker/index.js), each path
// as given and as it really is NOW: a fresh realpath per judgement, so a
// link re-pointed since is seen at delete time (the reviewer's high on
// #467, round 3, 4). Where a fresh one is refused (--hardened's permission
// model refuses a granted root's), the startup's answer for it
// (lib/hardened-realpaths); a root it has none for, and can't resolve, may
// hold code (true: kept). One that doesn't exist holds none.
//   code.roots: module roots (knownModuleRoots, --loadModule's, the
//     module's own), inside the directory or holding it;
//   code.folders: --modulePath folders, inside the directory.
// Asked before adopting a directory where the broker's judgement doesn't
// run, and before every recursive delete, so a directory the runtime made,
// that a module was later loaded from, is still kept (the medium, 2).
// (A root under --hardened the parent didn't record and Node refuses: may
// hold code. Any other error: as given.)
const UNRESOLVED = Symbol('unresolved');
async function spellingsNow(p) {
  const given = path.resolve(p);
  try {
    const real = await fsp.realpath(given);
    return real === given ? [given] : [given, real];
  } catch (e) {
    if (e != null && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [given];
    const hardened = require('./hardened-realpaths');
    if (hardened.has(given)) { const real = hardened.realpathSync(given); return real === given ? [given] : [given, real]; }
    // (only --hardened's refusal leaves a root's place unknown; any other
    // error -- a loop, a directory it can't search -- leaves it as given, as
    // the broker spells one: the medium on the high's round 3, 3)
    return process.permission != null ? UNRESOLVED : [given];
  }
}
async function codeInside(dir, code) {
  const inside = require('./fs-broker/identity').insideHostFor(process.platform);
  const strings = (v) => [].concat(v || []).filter((p) => typeof(p) === 'string' && p !== '');
  const here = await spellingsNow(dir);
  if (here === UNRESOLVED) return true;
  for (const root of strings(code && code.roots)) {
    const r = await spellingsNow(root);
    if (r === UNRESOLVED || r.some((x) => here.some((h) => inside(h, x) || inside(x, h)))) return true;
  }
  for (const folder of strings(code && code.folders)) {
    const f = await spellingsNow(folder);
    if (f === UNRESOLVED || f.some((x) => here.some((h) => inside(x, h)))) return true;
  }
  return false;
}

// The code the runtime knows, for codeInside: a module manager's roots
// (knownModuleRoots), the --loadModule directories and the --modulePath
// folders from the options, and any `also` (a module's own code).
function knownCode(mm, options, also = []) {
  const roots = (mm != null && typeof(mm.knownModuleRoots) === 'function') ? mm.knownModuleRoots().map((k) => k.root) : [];
  return {roots: roots.concat([].concat((options && options.localModulePath) || []), also), folders: [].concat((options && options.modulePath) || [])};
}

// Adoption (the reviewer's ruling: an existing install's directories): each
// of d's data and tmp with no entry in the holder's marker is recorded as the
// runtime's own when it is at its expected path (atExpectedPath) and
// free(which, dir) says the overlap judgement passed for it: the broker's
// own judgement at a spawn; codeInside elsewhere. One its marker names as
// another directory is not (a mismatch is the sign something else changed
// it: the reviewer, #467). -> the marker as it is after (for ownedDir,
// removeOwned: read once per spawn, its high, 7)
async function adopt(holder, d, base, free) {
  const marks = await readMarker(holder, base);
  const take = {};
  for (const which of WHICH) {
    if (marks[which] != null || d[which] == null) continue;
    if (await atExpectedPath(d[which], base) && await free(which, d[which])) take[which] = d[which];
  }
  if (take.data == null && take.tmp == null) return marks;
  await record(holder, take, base);
  return readMarker(holder, base);
}
const adoptWhereFree = (holder, d, base, code) => adopt(holder, d, base, async (which, dir) => !(await codeInside(dir, code)));

// The marker's own names (the marker, a fresh one being written): no
// module's bytes, so no quota's
const isMarkerName = (name) => name === MARKER || name.startsWith(`${MARKER}.`);

module.exports = {writeMarker, ownership, keptSaid, isMarkerName, adopt, adoptWhereFree, codeInside, knownCode, holdsCode, removeOwned, removeOwnedTree, MARKER, MAX_BYTES,
  readMarker, identityOf, record, ownedDir, removeMarker, atExpectedPath, unowned, birthIsReal,
  resetForTests: () => { said.clear(); birthReal.clear(); },
  // (a test's cleanup: every probe in flight, settled -- the fs-broker 30 flake)
  probesSettled: () => Promise.allSettled([...probesInFlight]),
  // a device's probe answer, set (a test of what a host without real birth
  // times sees)
  setBirthRealForTests: (dev, real) => birthReal.set(String(dev), Promise.resolve(real))};

'use strict';
// Which data directories the runtime may delete recursively (A-overlap-rm;
// the reviewer's ruling, split out of #452 round 3): only those it MADE.
// That covers /tmp emptied at every spawn (worker, session, single-thread),
// a module's data purged by an uninstall, and a session's partition removed.
//
// - When ensureDirs or ensureSessionDirs creates a data or tmp directory, it
//   records that directory's identity (dev and ino, read exactly: lib/
//   file-identity.js) in an ownership marker, MARKER, in the directory that
//   holds them: <name>/ for a module, <name>/sessions/<id>/ for a session.
//   No worker sees that directory: a worker's /data and /tmp are data/ and
//   tmp/ themselves.
// - Before a recursive delete, ownedDir: the directory, as it is now (a real
//   directory, never a link), must be the one the marker names. Otherwise it
//   was not made here, or was swapped since: it is never emptied or removed,
//   and that is said once per process for that directory as it is (unowned).
// - A directory made before markers existed (an install before this
//   version) is adopted at its first spawn (lib/fs-broker/index.js), or a
//   session's at the start's sweep (lib/session-partition.js), only at the
//   path the runtime would have made it, with no link from --moduleDataPath
//   down to it (atExpectedPath), and only when the overlap judgement of #452
//   passed for it. No package name or file layout is ever read to decide.
//
// The marker: JSON {v: 1, dirs: {data?: {dev, ino, birth}, tmp?: {...}}},
// each a decimal string. birth is the directory's creation time in ns
// (statx on Linux, the creation time on Windows; 0 where the file system
// keeps none): an inode number is reused at once after a removal (ext4
// hands a directory made right after an rm -r the same one), and birth
// tells that new directory from the one recorded; owner-only (0600; on Windows a mode is only
// the read-only attribute, so it is not checked there); written to a fresh
// name with O_EXCL, then renamed over the marker (atomic on POSIX, and on
// Windows, where rename replaces). A marker that is not a regular file, not
// owner-only, larger than MAX_BYTES, or not that shape is no marker: every
// directory it would name is unowned.
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

// -> {data?: {dev, ino}, tmp?: {dev, ino}}: what the marker in `holder`
// names ({} for none, or one that is no marker)
async function readMarker(holder) {
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

// A real directory's identity, as the marker keeps it; null for anything
// else (missing, a link, a file).
async function identityOf(dir) {
  let st;
  try { st = await fsp.lstat(dir, BIG); } catch (e) { return null; }
  return st.isDirectory() ? {dev: String(st.dev), ino: String(st.ino), birth: String(st.birthtimeNs)} : null;
}

// Records `dirs` ({data?: path, tmp?: path}), each as it is now, in the
// marker in `holder`; the marker's other entries are kept. A directory that
// is not a real one is not recorded.
async function record(holder, dirs) {
  const current = await readMarker(holder);
  let changed = false;
  for (const which of WHICH) {
    if (dirs[which] == null) continue;
    const id = await identityOf(dirs[which]);
    if (id != null) { current[which] = id; changed = true; }
  }
  if (!changed) return;
  const fresh = path.join(holder, `${MARKER}.${crypto.randomBytes(6).toString('hex')}`);
  try {
    const fh = await fsp.open(fresh, 'wx', 0o600);
    try { await fh.writeFile(`${JSON.stringify({v: 1, dirs: current})}\n`); } finally { await fh.close(); }
    await fsp.rename(fresh, path.join(holder, MARKER));
  } catch (e) {
    await fsp.unlink(fresh).catch(() => {});
    throw e;
  }
}

// Whether `dir`, as it is now, is the `which` the marker in `holder` names.
async function ownedDir(holder, which, dir) {
  const named = (await readMarker(holder))[which];
  if (named == null) return false;
  const id = await identityOf(dir);
  return id != null && id.dev === named.dev && id.ino === named.ino && id.birth === named.birth;
}

// The marker itself, removed with the directories it named (a purge, a
// partition's removal); a link or a file of that name goes too.
async function removeMarker(holder) {
  await fsp.unlink(path.join(holder, MARKER)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
}

// Whether `dir` is where the runtime would have made it: inside `base`
// (--moduleDataPath; an operator's link at or above it is theirs and
// allowed), and every directory from `dir` up to `base` a real one, no link
// (an lstat walk: no realpath, which --hardened's permission model may
// refuse above the grant).
function atExpectedPath(dir, base) {
  const inside = require('./fs-broker/identity').insideHostFor(process.platform);
  const stop = path.resolve(base);
  let at = path.resolve(dir);
  if (at === stop || !inside(at, stop)) return false;
  try {
    while (at !== stop) {
      if (!fs.lstatSync(at).isDirectory()) return false;
      const up = path.dirname(at);
      if (up === at) return false;
      at = up;
    }
  } catch (e) {
    return false;
  }
  return true;
}

// Said once per process for each directory as it is (its path and
// identity): a directory not made here is kept, never emptied or removed.
const said = new Set();
// action: what is not done to it ('emptied', 'removed')
function unowned(dir, action, say) {
  let key = `${path.resolve(dir)}`;
  try { const st = fs.lstatSync(dir, BIG); key += `\0${st.dev}:${st.ino}:${st.birthtimeNs}`; } catch (e) { /* missing: the path alone */ }
  if (said.has(key)) return;
  said.add(key);
  const text = `${dir} was not made by this runtime (no ownership mark for it), so it is not ${action}` +
    ' -- if it is yours to clear, clear it by hand; moved aside, the next start makes a new one';
  if (typeof(say) === 'function') say(text);
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
// once nothing it named is kept. -> [path kept]
async function removeOwned(holder, d, say) {
  const kept = [];
  for (const which of WHICH) {
    const dir = d[which];
    let st;
    try { st = await fsp.lstat(dir); } catch (e) { continue; }
    if (!st.isDirectory()) { await fsp.unlink(dir); continue; }
    if (await ownedDir(holder, which, dir)) { await removeOwnedTree(dir); continue; }
    unowned(dir, 'removed', say);
    kept.push(dir);
  }
  if (kept.length === 0) await removeMarker(holder);
  return kept;
}

// Whether `dir` and any of `roots` (module roots the runtime knows) overlap,
// either inside the other, each as given and as it really is. For a
// session's partition adopted at the start's sweep (the broker's own
// judgement covers a spawn).
function overlapsAny(dir, roots) {
  const inside = require('./fs-broker/identity').insideHostFor(process.platform);
  const spell = (p) => { const r = path.resolve(p); try { const real = fs.realpathSync.native(r); return real === r ? [r] : [r, real]; } catch (e) { return [r]; } };
  const here = spell(dir);
  return roots.some((root) => spell(root).some((r) => here.some((h) => inside(h, r) || inside(r, h))));
}

// Adoption where the broker's judgement doesn't run (single-thread mode, the
// start's sweep of sessions' partitions): each of d's data and tmp with no
// entry in the holder's marker is recorded as the runtime's own when it is
// at its expected path (atExpectedPath) and no module root the runtime
// knows (`roots`, the module's own code included) overlaps it.
async function adoptWhereFree(holder, d, base, roots) {
  const marks = await readMarker(holder);
  const take = {};
  for (const which of WHICH) {
    if (marks[which] != null || d[which] == null) continue;
    if (atExpectedPath(d[which], base) && !overlapsAny(d[which], roots)) take[which] = d[which];
  }
  if (take.data != null || take.tmp != null) await record(holder, take);
}

// The marker's own names (the marker, and a fresh one being written): no
// module's bytes, so no quota's
const isMarkerName = (name) => name === MARKER || name.startsWith(`${MARKER}.`);

module.exports = {isMarkerName, adoptWhereFree, removeOwned, removeOwnedTree, overlapsAny, MARKER, MAX_BYTES, readMarker, identityOf, record, ownedDir, removeMarker, atExpectedPath, unowned, resetForTests: () => said.clear()};

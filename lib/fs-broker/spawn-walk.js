'use strict';
// The spawn walk (spec section 3, "Quota" and "Link rules"): before a module
// worker starts, /tmp is emptied and /data and /tmp are measured. Nothing
// here follows a link: lstat everywhere, and fs.rm removes a link, never its
// target. Runs on the main thread with the real fs, asynchronously; the spawn
// waits for it.
const fsp = require('fs/promises');
const path = require('path');

async function realDirectory(dir) {
  const st = await fsp.lstat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory (a link or a file); refusing to empty or measure it`);
}

// Never removes package code: whatever the layout, a /tmp that overlaps
// some module's code never deletes it (the reviewer's ruling on #452).
// - A /tmp that is a package, or sits inside one -- itself or a directory
//   above it, within `within` (the --moduleDataPath root, the --modulePath
//   folders, the --loadModule directories), holding a package.json or
//   named node_modules -- is not emptied at all.
// - Otherwise an entry whose subtree holds a package.json or a node_modules
//   directory (any letter case), or one that can't be looked through, or
//   one past the walk's bound, is kept.
// The walk is bounded in work and in memory (a directory read as a stream,
// WALK_BOUND entries in all, the /tmp's own listing included); a /tmp with
// more than that is emptied of the first ones this time and answered as
// kept itself. The kept host paths are answered,
// for the caller to say once. A link is never followed: removing one
// removes the link. -> Promise<[path]>
const WALK_BOUND = 100000;
const isPackageName = (name) => { const n = name.toLowerCase(); return n === 'package.json' || n === 'node_modules'; };
// (an error that says nothing is there; any other -- a denied read, the
// permission model's too -- keeps what it couldn't see)
const absent = (e) => e != null && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

async function holdsPackageCode(entry, budget) {
  if (isPackageName(path.basename(entry))) return true;
  let st;
  try { st = await fsp.lstat(entry); } catch (e) { return !absent(e); }
  if (!st.isDirectory()) return false;
  const dirs = [entry];
  for (let i = 0; i < dirs.length; i++) {
    let dir;
    try { dir = await fsp.opendir(dirs[i]); } catch (e) { if (absent(e)) continue; return true; }
    try {
      for await (const d of dir) {
        if (--budget.left < 0) return true;
        if (isPackageName(d.name)) return true;
        if (d.isDirectory()) dirs.push(path.join(dirs[i], d.name));
      }
    } catch (e) { if (!absent(e)) return true; }
  }
  return false;
}

async function insidePackage(tmpDir, within) {
  const insideHost = require('./identity').insideHostFor(process.platform);
  const roots = (within || []).filter((r) => typeof(r) === 'string').map((r) => path.resolve(r));
  // (a filesystem root holds everything)
  const under = (at, r) => r === path.parse(r).root || insideHost(at, r);
  for (let at = path.resolve(tmpDir); roots.some((r) => under(at, r)); at = path.dirname(at)) {
    if (isPackageName(path.basename(at))) return true;
    try { await fsp.lstat(path.join(at, 'package.json')); return true; } catch (e) { if (!absent(e)) return true; }
    if (path.dirname(at) === at) break;
  }
  return false;
}

async function emptyTmp(tmpDir, opts) {
  await realDirectory(tmpDir);
  if (await insidePackage(tmpDir, opts != null ? opts.within : null)) return [tmpDir];
  const names = [];
  const kept = [];
  const budget = {left: WALK_BOUND};
  const listing = await fsp.opendir(tmpDir);
  for await (const d of listing) {
    if (--budget.left < 0) { kept.push(tmpDir); break; }
    names.push(d.name);
  }
  for (const name of names) {
    const entry = path.join(tmpDir, name);
    if (await holdsPackageCode(entry, budget)) { kept.push(entry); continue; }
    await fsp.rm(entry, {recursive: true, force: true});
  }
  return kept;
}

// roots: [[hostDir, '/data'], [hostDir, '/tmp']]; links are reported as virtual paths.
// Hard links: bytes once per inode; names are tallied per inode so a file
// with more links than the walk found (st.nlink > tally) has a name
// elsewhere -- listed, since it can lead outside (review I4). whollyInside
// (rm's release, review I1): count a file's bytes only when all its links
// were found, so removing one name of a shared file gives nothing back.
async function measure(roots, opts) {
  const maxListed = (opts && opts.maxListed) || 10;
  const whollyInside = opts != null && opts.whollyInside === true;
  const inodes = new Map();   // dev:ino -> {size, nlink, names: [virtual]}
  const out = {bytes: 0, entries: 0, links: [], moreLinks: 0};
  // opts.stopAfter {entries, bytes}: the walk ends once past either (R1: a
  // module's partitions measured for its quota, where past the limit is over
  // quota whatever the rest holds), with out.truncated
  const stopAfter = (opts != null && opts.stopAfter != null) ? opts.stopAfter : null;
  let seenBytes = 0;
  const flag = (v) => { if (out.links.length < maxListed) out.links.push(v); else out.moreLinks++; };
  for (const [host, vroot] of roots) {
    await realDirectory(host);
    const queue = [[host, vroot]];
    while (queue.length > 0) {
      const [dir, vdir] = queue.shift();
      for (const d of await fsp.readdir(dir, {withFileTypes: true})) {
        const hp = path.join(dir, d.name);
        const vp = `${vdir}/${d.name}`;
        const st = await fsp.lstat(hp);
        out.entries++;
        if (st.isFile()) seenBytes += st.size;
        if (stopAfter != null && (out.entries > stopAfter.entries || seenBytes > stopAfter.bytes)) {
          out.truncated = true;
          out.bytes = seenBytes;
          return out;
        }
        if (st.isSymbolicLink()) {
          if (path.isAbsolute(await fsp.readlink(hp))) flag(vp);
        } else if (st.isDirectory()) {
          queue.push([hp, vp]);
        } else if (st.isFile()) {
          const key = `${st.dev}:${st.ino}`;
          const i = inodes.get(key) || {size: st.size, nlink: st.nlink, names: []};
          i.names.push(vp);
          inodes.set(key, i);
        }
      }
    }
  }
  for (const i of inodes.values()) {
    const allFound = i.names.length >= i.nlink;
    if (!allFound) flag(i.names[0]);
    if (!whollyInside || allFound) out.bytes += i.size;
  }
  return out;
}

module.exports = {emptyTmp, measure};

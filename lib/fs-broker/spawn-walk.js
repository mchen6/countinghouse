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
// - A /tmp inside a package -- a directory above it, within `within` (the
//   --moduleDataPath root, the --modulePath folders, the --loadModule
//   directories), holding a package.json or named node_modules -- is not
//   emptied at all.
// - Otherwise an entry whose subtree holds a package.json or a node_modules
//   directory (any letter case), or one that can't be looked through, or
//   one past the walk's bound, is kept.
// The kept host paths are answered, for the caller to say once. A link is
// never followed: removing one removes the link. -> Promise<[path]>
const WALK_BOUND = 100000;
const isPackageName = (name) => { const n = name.toLowerCase(); return n === 'package.json' || n === 'node_modules'; };

async function holdsPackageCode(entry, budget) {
  const queue = [entry];
  for (let i = 0; i < queue.length; i++) {
    if (--budget.left < 0) return true;
    const at = queue[i];
    if (isPackageName(path.basename(at))) return true;
    let st;
    try { st = await fsp.lstat(at); } catch (e) { if (e.code === 'ENOENT') continue; return true; }
    if (!st.isDirectory()) continue;
    let names;
    try { names = await fsp.readdir(at); } catch (e) { if (e.code === 'ENOENT') continue; return true; }
    for (const n of names) queue.push(path.join(at, n));
  }
  return false;
}

async function insidePackage(tmpDir, within) {
  const inside = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  const roots = (within || []).filter((r) => typeof(r) === 'string').map((r) => path.resolve(r));
  for (let at = path.dirname(path.resolve(tmpDir)); roots.some((r) => inside(at, r)); at = path.dirname(at)) {
    if (isPackageName(path.basename(at))) return true;
    try { await fsp.lstat(path.join(at, 'package.json')); return true; } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return true; }
    if (path.dirname(at) === at) break;
  }
  return false;
}

async function emptyTmp(tmpDir, opts) {
  await realDirectory(tmpDir);
  if (await insidePackage(tmpDir, opts != null ? opts.within : null)) return [tmpDir];
  const kept = [];
  const budget = {left: WALK_BOUND};
  for (const name of await fsp.readdir(tmpDir)) {
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

'use strict';
// The spawn walk (spec section 3, "Quota" and "Link rules"): before a module
// worker starts, /tmp is emptied and /data and /tmp are measured. Nothing
// here follows a link: lstat everywhere, and fs.rm removes a link, never its
// target. Runs on the main thread with the real fs, asynchronously; the spawn
// waits for it.
const fsp = require('fs/promises');
const {fileKey, identStat} = require('../file-identity');
const ownership = require('../data-ownership');
const path = require('path');

async function realDirectory(dir) {
  const st = await fsp.lstat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory (a link or a file); refusing to empty or measure it`);
}

// Only a /tmp the runtime made (lib/data-ownership.js): owner.holder, the
// directory holding its ownership marker (<name>/, or a session's root);
// owner.base, --moduleDataPath, from which both are reached through real
// directories only; owner.marks, the marker as adopt read it (else read
// here); owner.say, where a /tmp kept is said, once; owner.code, the module code
// the runtime knows (data-ownership knownCode), where no overlap judgement
// ran before (single-thread mode): a /tmp holding some is kept too.
// -> whether it was emptied
async function emptyTmp(tmpDir, owner) {
  if (owner == null || typeof(owner.holder) !== 'string' || typeof(owner.base) !== 'string') throw new TypeError('emptyTmp needs the directory holding its ownership marker, and the data root');
  await realDirectory(tmpDir);
  const o = await ownership.ownership(owner.holder, 'tmp', tmpDir, owner.base, owner.marks);
  if (o.state !== 'owned') {
    ownership.keptSaid(o, tmpDir, 'emptied', owner.say, owner.holder);
    return false;
  }
  if (owner.code != null && await ownership.codeInside(tmpDir, owner.code)) {
    ownership.holdsCode(tmpDir, 'emptied', owner.say);
    return false;
  }
  for (const name of await fsp.readdir(tmpDir)) {
    await fsp.rm(path.join(tmpDir, name), {recursive: true, force: true});
  }
  return true;
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
  // opts.skipTop(name): an entry at a root's top level that is not counted
  // (a session root's ownership marker: the runtime's, not the module's)
  const skipTop = (opts != null && typeof(opts.skipTop) === 'function') ? opts.skipTop : null;
  let seenBytes = 0;
  const flag = (v) => { if (out.links.length < maxListed) out.links.push(v); else out.moreLinks++; };
  for (const [host, vroot] of roots) {
    await realDirectory(host);
    const queue = [[host, vroot]];
    while (queue.length > 0) {
      const [dir, vdir] = queue.shift();
      for (const d of await fsp.readdir(dir, {withFileTypes: true})) {
        if (skipTop != null && dir === host && skipTop(d.name)) continue;
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
          // (a file with one link has no other name to meet: keyed by its
          // path; one with more by its exact identity, read as bigints only
          // for it -- lib/file-identity.js)
          const key = st.nlink > 1 ? fileKey(await identStat(hp)) : `\0${hp}`;
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

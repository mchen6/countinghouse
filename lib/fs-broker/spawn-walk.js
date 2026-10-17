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

async function emptyTmp(tmpDir) {
  await realDirectory(tmpDir);
  for (const name of await fsp.readdir(tmpDir)) {
    await fsp.rm(path.join(tmpDir, name), {recursive: true, force: true});
  }
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

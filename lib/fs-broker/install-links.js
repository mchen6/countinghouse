// The links an install is reached through (#280's follow-up). countinghouse
// may run by a spelling that isn't its real path (#272: a symlink or junction
// in the path, kept with --preserve-symlinks-main). Whoever can replace one
// of those links points the next start at other code, so each link's own
// place is a protected path (lib/fs-broker/index.js protectedPaths): no
// module may declare it or a directory above it.
//
// A link's place is its name in its parent's real path, the one spelling the
// declaration check can compare a declared root's real path with
// (lib/fs-broker/namespace.js). The walk follows the path as the host does:
// from the root down to the first link, then on through that link's target,
// so a link met only in another link's target is found as well.
const fs = require('fs');
const path = require('path');

// the host's own limit on links in one resolution (ELOOP) is about this
const MAX_HOPS = 40;

// The first component of p that is a link: {at: its path, rest: the names
// after it}; null when none is.
function firstLink(p, lstatSync) {
  const root = path.parse(p).root;
  const names = p.slice(root.length).split(path.sep).filter((n) => n !== '');
  let at = root;
  for (let i = 0; i < names.length; i++) {
    at = path.join(at, names[i]);
    if (lstatSync(at).isSymbolicLink()) return {at: at, rest: names.slice(i + 1)};
  }
  return null;
}

// hostFs ({lstatSync, readlinkSync, realpathSync}) is for the tests. A walk
// that is refused or finds a name gone keeps what it found: the relaunched
// --hardened server may not lstat above its grants, and takes the list from
// its parent instead (lib/hardened-realpaths.js installLinks).
function linkLocations(dir, hostFs) {
  const {lstatSync, readlinkSync, realpathSync} = hostFs || {lstatSync: fs.lstatSync, readlinkSync: fs.readlinkSync, realpathSync: fs.realpathSync.native};
  const found = [];
  let pending = path.resolve(dir);
  try {
    for (let hops = 0; hops < MAX_HOPS; hops++) {
      const link = firstLink(pending, lstatSync);
      if (link == null) break;
      // nothing above the first link is one, so this only gives the parent
      // its real spelling (on Windows, an 8.3 short name's long form)
      const parent = realpathSync(path.dirname(link.at));
      const place = path.join(parent, path.basename(link.at));
      if (!found.includes(place)) found.push(place);
      pending = path.resolve(parent, readlinkSync(link.at), ...link.rest);
    }
  } catch (e) { /* refused, or gone: what was found stands */ }
  return found;
}

module.exports = {linkLocations};

// The links an install is reached through (#280's follow-up). countinghouse
// may run by a spelling that isn't its real path (#272: a symlink or junction
// in the path, kept with --preserve-symlinks). Whoever can replace one of
// those links points the next start at other code, so no module is given a
// writable root that holds one (lib/fs-broker/namespace.js prepare).
//
// A link's place is its name in its parent's real path: the one spelling a
// declared root's real path can be compared with. The walk takes the path as
// the host does, a name at a time: a link's target is followed where the
// link stands, a ".." after a link leaves the directory the link led to, and
// a link met only in another link's target is found as well.
//
// Every other name the walk passes is on the host's path too, and is given
// as well (the reviewer's security review of #282, I1): a target such as
// ../data/x/../../opt/v1 goes into data/x and leaves it again, so whoever
// can replace x with a link decides where that ".." leaves. `left` is the
// names a ".." left; `passed` is every name that was no link. For a path
// with no such target the passed names are only the directories above the
// path or above what its links lead to.
const fs = require('fs');
const path = require('path');

// the host's own limit on links in one resolution (ELOOP) is about this
const MAX_LINKS = 40;

const namesOf = (p) => p.split(path.sep).filter((n) => n !== '');

// A name that ends a walk: one that is not there, or that this process may
// not reach (a directory it cannot search). The runtime reaches nothing
// through what comes after it.
const ENDS = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'];

// -> {places, passed, left, complete}: the links; every other name passed;
// the names a ".." left; each by its name in its parent's real path.
// complete: the whole path resolved; false when the
// walk stopped short (a name that ends it, or more links than a resolution
// may take), so the caller does not keep the answer as the path's last word:
// the name may appear later, as a link. Any other failure is thrown: a list
// cut short in silence would leave a link unprotected. (The relaunched
// --hardened server may not lstat above its grants, ERR_ACCESS_DENIED; it
// takes its parent's lists instead: lib/fs-broker/index.js linkPlacesOf.)
// hostFs ({lstatSync, readlinkSync, realpathSync}) is for the tests.
function walkLinks(dir, hostFs) {
  const {lstatSync, readlinkSync, realpathSync} = hostFs || {lstatSync: fs.lstatSync, readlinkSync: fs.readlinkSync, realpathSync: fs.realpathSync.native};
  const found = [];
  const passed = [];
  const left = [];
  const start = path.resolve(dir);
  // at: the directory reached so far, with no link in it; names: still to take
  let at = path.parse(start).root;
  let names = namesOf(start.slice(at.length));
  let links = 0;
  let complete = true;
  try {
    while (names.length > 0) {
      const name = names.shift();
      if (name === '.') continue;
      if (name === '..') {
        const above = path.dirname(at);
        // the directory left: replaced by a link, this ".." would leave
        // somewhere else
        if (above !== at) { const was = path.join(realpathSync(above), path.basename(at)); if (!left.includes(was)) left.push(was); }
        at = above;
        continue;
      }
      const next = path.join(at, name);
      const isLink = lstatSync(next).isSymbolicLink();
      // `at` holds no link, so this only gives it its real spelling (on
      // Windows, an 8.3 short name's long form)
      const place = path.join(realpathSync(at), name);
      if (!isLink) {
        if (!passed.includes(place)) passed.push(place);
        at = next;
        continue;
      }
      if (!found.includes(place)) found.push(place);
      if (++links > MAX_LINKS) { complete = false; break; }
      const target = readlinkSync(next);
      // an absolute target starts again from its root; a relative one
      // carries on from the directory the link is in
      if (path.isAbsolute(target)) {
        at = path.parse(target).root;
        names = namesOf(target.slice(at.length)).concat(names);
      } else {
        names = namesOf(target).concat(names);
      }
    }
  } catch (e) {
    if (!ENDS.includes(e.code)) throw e;
    complete = false;
  }
  return {places: found, passed, left, complete};
}

// the links alone
function linkLocations(dir, hostFs) {
  return walkLinks(dir, hostFs).places;
}

module.exports = {linkLocations, walkLinks};

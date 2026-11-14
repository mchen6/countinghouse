// Where each module's private /data and /tmp live on the host
// (docs/superpowers/specs/2026-10-17-module-sandbox-fs-broker-design.md,
// section 1): <moduleDataPath>/<name>/{data,tmp}, scoped names laid out as
// node_modules does (@scope/name), directories private to the service user.
const fs = require('fs');
const path = require('path');

// A name must map to exactly one directory under the data path and never
// leave it: one segment, or "@scope/name"; no empty, dot-leading or "@"-only
// segments; no backslash or NUL. Distinct names give distinct paths on a
// case-sensitive file system (Linux, the target); on macOS "Foo" and "foo"
// would share one, which npm's lowercase rule makes rare. Well-formed Unicode
// only (no lone surrogate): the name is also its Redis namespace's,
// URI-encoded (lib/redis-namespace.js).
function safeName(name) {
  if (typeof(name) !== 'string' || name.length === 0 || name.length > 214) return false;
  if (!name.isWellFormed()) return false;
  if (name.includes('\0') || name.includes('\\')) return false;
  const parts = name.split('/');
  if (parts.length > 2) return false;
  if (parts.length === 2 && !(parts[0].startsWith('@') && parts[0].length > 1)) return false;
  return parts.every((part, i) => {
    if (part.length === 0 || part.startsWith('.')) return false;
    const scope = (parts.length === 2 && i === 0);
    return scope || !part.startsWith('@');
  });
}

function dirsFor(dataRoot, name) {
  if (!safeName(name)) throw new Error(`module name ${JSON.stringify(name)} cannot be used as a data directory name`);
  const root = path.join(path.resolve(dataRoot), ...name.split('/'));
  return {root: root, data: path.join(root, 'data'), tmp: path.join(root, 'tmp')};
}

// A module's own data and tmp, private on every start. mkdir's mode is
// filtered by the umask, which can only clear bits, so every directory it
// makes here is at most 0700; then data and tmp themselves, by their known
// paths, are set to 0700, which puts back in those two what an unusual
// umask cleared and makes private a data or tmp left with other modes. The
// directories above them (--moduleDataPath, <name>, an operator's 0750 for
// a backup group, say) are left as mkdir made or found them. Issue #40: this used to chmod each directory mkdir
// reported creating, walking up to its answer as a string; on Windows the
// answer is namespaced (\\?\C:\...), the walk never met it and passed the
// root.
async function ensureDirs(dataRoot, name) {
  const d = dirsFor(dataRoot, name);
  for (const dir of [d.data, d.tmp]) {
    await fs.promises.mkdir(dir, {recursive: true, mode: 0o700});
    await makePrivate(dir);
  }
  return d;
}

// chmod 0700, never through a link at data or tmp itself: lstat first, and a
// data or tmp that is a symbolic link (an operator's, to anywhere) is left
// alone, as is what it leads to; otherwise chmod by path. A link higher up
// (--moduleDataPath or <name> pointing at other storage) moves the whole
// tree, and data and tmp under it are still the module's own, so those are
// made private.
//
// Not through a descriptor (open with O_NOFOLLOW, then fchmod), which would
// close the window between the lstat and the chmod: under --hardened the
// main thread runs in Node's permission model, which from Node 24.14
// refuses fchmod even with the write grant on --moduleDataPath ("fchmod API
// is disabled when Permission Model is enabled"). The window is safe to
// leave: this runs before the module's worker exists, under the module's
// lifecycle lock, and a link would have to be swapped in inside <name>/,
// the runtime user's own directory, so only that user or root could race
// it, and either could chmod data and tmp directly.
//
// One already 0700 is not chmod'ed again, so a data or tmp that is right
// on a read-only mount, or owned by another user, starts as before.
//
// On Windows a mode is only the read-only attribute, and mkdir made these
// writable, so nothing is done there.
async function makePrivate(dir) {
  if (process.platform === 'win32') return;
  const st = await fs.promises.lstat(dir);
  if (st.isSymbolicLink() || (st.mode & 0o7777) === 0o700) return;
  await fs.promises.chmod(dir, 0o700);
}

module.exports = {safeName, dirsFor, ensureDirs};

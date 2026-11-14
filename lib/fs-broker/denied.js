// The always-denied files (R2-1 spec, "The always-denied set"): the auth
// configuration -- the JSON file under --authProvider file, the database
// under sqlite with its -wal, -shm and -journal side files -- and the
// identity secret (under --moduleDataPath, or --storePath in the
// single-identity profile). Refused to a module in audit and
// enforce, EACCES, however the module names them: directly, through a
// symlink or `..`, or through a hard link in a declared directory. Off
// decides nothing, so off never consults this set.
//
// A file is known by its real path and, once it exists, by (dev, ino), so a
// hard link (a different path, the same inode) is refused like the file.
// The identities are re-taken at most once a second (REFRESH_MS), which
// bounds how long a file a provider rewrote in place (a new inode) is known
// by its path alone: a hard link to the new inode made inside that second
// is not recognised by inode until the next refresh. A path that does not
// exist yet (the secret before a first start, a sqlite side file) is matched
// by its real path, computed from its parent's, until it exists. An identity
// once seen stays denied for the server's life (sticky): a refresh that
// finds another file, or none, at the path adds, never drops, so a denied
// file moved away is still refused at its new name.
//
// Windows (issue #40): locations are computed with path.win32, and compared
// with "/" and "\" as one separator and case folded, as NTFS names compare
// (a wider match only refuses more). POSIX: as before, exact strings.
const fsp  = require('fs/promises');
const path = require('path');

const REFRESH_MS = 1000;
const SIDE_FILES = ['', '-wal', '-shm', '-journal'];

// The paths for a server's options: the auth configuration and its side
// files, and the identity secret.
function deniedPathsFor(options) {
  const cwd = process.cwd();
  const auth = path.resolve(cwd, options.authConfigPath || path.join(cwd, 'auth.json'));
  const out = SIDE_FILES.map((s) => auth + s);
  if (options.moduleDataPath != null) out.push(path.join(path.resolve(cwd, options.moduleDataPath), '.identity-secret'));
  // in the single-identity profile the secret lives in the store (LM1 spec
  // section 4)
  if (options.singleIdentity === true && options.storePath != null) out.push(path.join(path.resolve(cwd, options.storePath), '.identity-secret'));
  return out;
}

// A path's real location, or a missing leaf's by its name in its real
// parent; as given when neither resolves.
async function realOf(p, pathMod, hostFs) {
  try {
    return await hostFs.realpath(p);
  } catch (e) {
    return inParentOf(p, pathMod, hostFs);
  }
}

// A missing leaf by its name in its real parent; as given when the parent
// does not resolve either.
async function inParentOf(p, pathMod, hostFs) {
  try {
    return pathMod.join(await hostFs.realpath(pathMod.dirname(p)), pathMod.basename(p));
  } catch (e) {
    return p;
  }
}

const HOST_FS = {realpath: (p) => fsp.realpath(p), stat: (p) => fsp.stat(p), lstat: (p) => fsp.lstat(p)};

// Windows: a location's comparison key. "/" and "\" are one separator; a
// name's case is folded (upper, as NTFS's upcase table compares), and the
// spellings Windows opens as the same name are taken as that name: trailing
// dots and spaces, and a ":stream" suffix (".identity-secret:x" creates
// .identity-secret). A drive ("C:") is kept. A wider match only refuses more.
function win32Key(p) {
  return p.replace(/\//g, '\\').split('\\').map((c) => {
    if (/^[a-zA-Z]:$/.test(c) || c === '.' || c === '..') return c;
    const i = c.indexOf(':');
    return (i >= 0 ? c.slice(0, i) : c).replace(/[. ]+$/, '');
  }).join('\\').toUpperCase();
}

// A sticky identity must name one file: not ino 0 (some file systems report
// it for every file) and not an ino a Number cannot hold exactly.
const stickable = (st) => st.ino !== 0 && Number.isSafeInteger(st.ino);

class DeniedSet {
  // opts.platform and opts.hostFs ({realpath, stat, lstat}) are for the tests.
  constructor(paths, opts) {
    opts = opts || {};
    const win32 = (opts.platform || process.platform) === 'win32';
    this.pathMod = win32 ? path.win32 : path;
    this.key = win32 ? win32Key : (p) => p;
    this.hostFs = opts.hostFs || HOST_FS;
    this.paths = (paths || []).slice();
    this.reals = new Set();
    this.idents = new Set();   // "dev:ino" found by the last refresh
    this.sticky = new Set();   // "dev:ino" ever found, for the server's life
    this.at = 0;
    this.refreshing = null;
  }

  // Real paths and identities, at most once per REFRESH_MS; concurrent
  // callers share one refresh.
  refresh() {
    if (Date.now() - this.at < REFRESH_MS) return Promise.resolve();
    if (this.refreshing != null) return this.refreshing;
    this.refreshing = (async () => {
      const reals = new Set();
      const idents = new Set();
      for (const p of this.paths) {
        const real = await realOf(p, this.pathMod, this.hostFs);
        reals.add(this.key(real));
        const st = await this.hostFs.stat(real).catch(() => null);
        if (st == null) continue;
        idents.add(`${st.dev}:${st.ino}`);
        if (stickable(st)) this.sticky.add(`${st.dev}:${st.ino}`);
      }
      this.reals = reals;
      this.idents = idents;
      this.at = Date.now();
      this.refreshing = null;
    })();
    return this.refreshing;
  }

  // Whether the object at realLoc (its real path), with identity ident
  // ({dev, ino} when known), is one of the denied files.
  async matches(realLoc, ident) {
    if (this.paths.length === 0) return false;
    await this.refresh();
    if (realLoc != null && this.reals.has(this.key(realLoc))) return true;
    if (ident == null || ident.ino == null) return false;
    const k = `${ident.dev}:${ident.ino}`;
    return this.idents.has(k) || this.sticky.has(k);
  }

  // Whether an outside path v (the broker's "outside" kind) is one of the
  // denied files: its real location -- the leaf for a following operation,
  // the name in its real parent otherwise; a missing leaf by its name in the
  // real parent -- and its identity.
  async matchesOutside(v, follow) {
    if (this.paths.length === 0) return false;
    const loc = follow ? await realOf(v, this.pathMod, this.hostFs) : await inParentOf(v, this.pathMod, this.hostFs);
    const st = await this.hostFs.lstat(loc).catch(() => null);
    return this.matches(loc, st != null ? {dev: st.dev, ino: st.ino} : null);
  }
}

module.exports = {DeniedSet, deniedPathsFor, REFRESH_MS};

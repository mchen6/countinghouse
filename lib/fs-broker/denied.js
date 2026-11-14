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
// by its real path, computed from its parent's, until it exists. A main
// file's identity (the auth configuration, the sqlite database, the
// secret's) stays denied for the server's life (sticky): the last
// STICKY_PER_PATH seen at each path are kept, each by (dev, ino) and its
// birthtime where the file system gives one, so a denied file moved away is
// still refused at its new name, and an unrelated file given a freed inode
// later is not. The side files (-wal, -shm, -journal) are transient and
// churn inodes: matched while current, never kept.
//
// Windows (issue #40): locations are computed with path.win32, and compared
// with "/" and "\" as one separator and case folded, as NTFS names compare.
// macOS: case folded too (and Unicode-normalised), as default APFS
// compares. A wider match only refuses more. Linux: exact strings.
const fsp  = require('fs/promises');
const path = require('path');

const REFRESH_MS = 1000;
const SIDE_FILES = ['', '-wal', '-shm', '-journal'];
const STICKY_PER_PATH = 2;

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

// A side file: one of SIDE_FILES' suffixes on a path that is itself listed.
const isSide = (p, all) => SIDE_FILES.some((x) => x !== '' && p.endsWith(x) && all.includes(p.slice(0, -x.length)));

class DeniedSet {
  // opts.platform and opts.hostFs ({realpath, stat, lstat}) are for the tests.
  constructor(paths, opts) {
    opts = opts || {};
    const platform = opts.platform || process.platform;
    const win32 = platform === 'win32';
    this.pathMod = win32 ? path.win32 : path;
    this.key = win32 ? win32Key : (platform === 'darwin' ? (p) => p.toUpperCase().normalize('NFD') : (p) => p);
    this.hostFs = opts.hostFs || HOST_FS;
    this.paths = (paths || []).slice();
    this.main = this.paths.filter((p) => !isSide(p, this.paths));
    this.reals = new Set();
    this.idents = new Set();   // "dev:ino" found by the last refresh
    this.sticky = new Map();   // a main path -> its last {dev, ino, birth} (birth null when unknown)
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
        if (stickable(st) && this.main.includes(p)) this.keep(p, st);
      }
      this.reals = reals;
      this.idents = idents;
      this.at = Date.now();
      this.refreshing = null;
    })();
    return this.refreshing;
  }

  // A main path's identity, into its ring of the last STICKY_PER_PATH.
  keep(p, st) {
    const birth = st.birthtimeMs > 0 ? st.birthtimeMs : null;
    const ring = this.sticky.get(p) || [];
    const last = ring[ring.length - 1];
    if (last != null && last.dev === st.dev && last.ino === st.ino && last.birth === birth) return;
    ring.push({dev: st.dev, ino: st.ino, birth: birth});
    if (ring.length > STICKY_PER_PATH) ring.shift();
    this.sticky.set(p, ring);
  }

  // Whether the object at realLoc (its real path), with identity ident
  // ({dev, ino, birthtimeMs} when known), is one of the denied files.
  async matches(realLoc, ident) {
    if (this.paths.length === 0) return false;
    await this.refresh();
    if (realLoc != null && this.reals.has(this.key(realLoc))) return true;
    if (ident == null || ident.ino == null) return false;
    if (this.idents.has(`${ident.dev}:${ident.ino}`)) return true;
    for (const ring of this.sticky.values()) {
      if (ring.some((k) => k.dev === ident.dev && k.ino === ident.ino && (k.birth == null || k.birth === ident.birthtimeMs))) return true;
    }
    return false;
  }

  // Whether an outside path v (the broker's "outside" kind) is one of the
  // denied files: its real location -- the leaf for a following operation,
  // the name in its real parent otherwise; a missing leaf by its name in the
  // real parent -- and its identity.
  async matchesOutside(v, follow) {
    if (this.paths.length === 0) return false;
    const loc = follow ? await realOf(v, this.pathMod, this.hostFs) : await inParentOf(v, this.pathMod, this.hostFs);
    const st = await this.hostFs.lstat(loc).catch(() => null);
    return this.matches(loc, st != null ? {dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs} : null);
  }
}

module.exports = {DeniedSet, deniedPathsFor, REFRESH_MS};

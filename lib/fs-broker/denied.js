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
// birthtime, so a denied file moved away is still refused at its new name,
// and an unrelated file given a freed inode later is not. Identities are
// read as bigints (an NTFS file ID often passes 2^53) and keyed exactly. An
// identity with ino 0 or no birthtime is matched while current and never
// kept: it cannot tell a later file with that (dev, ino) from this one. The
// side files (-wal, -shm, -journal) are transient and churn inodes: matched
// while current, never kept.
//
// Two residuals, accepted (review of #119, rounds 5-6):
// - Where statx is unavailable (an old kernel, or a seccomp profile that
//   refuses it), libuv reports ctime as the birthtime. A rename or a link
//   changes ctime, so a main file moved away then no longer matches its
//   kept entry, and one inode can take both of a ring's places.
// - The ring keeps the last two identities per path: a provider that
//   rewrites a file twice by atomic rename evicts an inode a module
//   hard-linked to it inside one refresh window (REFRESH_MS).
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

const HOST_FS = {realpath: (p) => fsp.realpath(p), stat: (p, o) => fsp.stat(p, o), lstat: (p, o) => fsp.lstat(p, o)};

// Windows: a location's comparison key. "/" and "\" are one separator; a
// name's case is folded (upper, as NTFS's upcase table compares), and the
// spellings Windows opens as the same name are taken as that name: trailing
// dots and spaces, and a ":stream" suffix (".identity-secret:x" creates
// .identity-secret). A drive ("C:") is kept. A wider match only refuses more.
// A trailing separator is dropped but a drive's root's (C:\\).
function win32Key(p) {
  let k = p.replace(/\//g, '\\').split('\\').map((c) => {
    if (/^[a-zA-Z]:$/.test(c) || c === '.' || c === '..') return c;
    const i = c.indexOf(':');
    return (i >= 0 ? c.slice(0, i) : c).replace(/[. ]+$/, '');
  }).join('\\').toUpperCase();
  while (k.length > 3 && k.endsWith('\\') && !/^\\+$/.test(k)) k = k.slice(0, -1);
  return k;
}

// A platform's rules for host paths, one for the denied set and the write
// guards: the path functions, the comparison key, and the separator in a
// key. opts.platform and opts.hostFs ({realpath, stat, lstat}) are for the
// tests.
function hostRules(opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  const win32 = platform === 'win32';
  return {
    platform: platform,
    pathMod: win32 ? path.win32 : path,
    key: win32 ? win32Key : (platform === 'darwin' ? (p) => p.toUpperCase().normalize('NFD') : (p) => p),
    keySep: win32 ? '\\' : path.sep,
    hostFs: opts.hostFs || HOST_FS
  };
}

// An outside path's real location -- the leaf for a following operation,
// the name in its real parent otherwise; a missing leaf by its name in the
// real parent -- and its identity (bigints; birthtimeMs a Number), with the
// host's path rules (issue #40: path.win32 on Windows).
async function locateOutside(v, follow, rules) {
  const r = rules || hostRules();
  const loc = follow ? await realOf(v, r.pathMod, r.hostFs) : await inParentOf(v, r.pathMod, r.hostFs);
  const st = await r.hostFs.lstat(loc, {bigint: true}).catch(() => null);
  return {loc: loc, ident: st != null ? {dev: st.dev, ino: st.ino, birthtimeMs: birthOf(st)} : null};
}

// An identity's exact key: dev and ino as bigints read them (a Number
// prints the same digits while it holds the value exactly).
const idKey = (st) => `${st.dev}:${st.ino}`;
// A sticky identity must name one file: not ino 0 (some file systems report
// it for every file), and with a birthtime to tell a later file from it.
const birthOf = (st) => Number(st.birthtimeMs);
const stickable = (st) => BigInt(st.ino) !== 0n && birthOf(st) > 0;

// A side file: one of SIDE_FILES' suffixes on a path that is itself listed.
const isSide = (p, all) => SIDE_FILES.some((x) => x !== '' && p.endsWith(x) && all.includes(p.slice(0, -x.length)));

class DeniedSet {
  // opts: hostRules'.
  constructor(paths, opts) {
    this.rules = hostRules(opts);
    this.paths = (paths || []).slice();
    this.main = this.paths.filter((p) => !isSide(p, this.paths));
    this.reals = new Set();
    this.idents = new Set();   // "dev:ino" found by the last refresh
    this.sticky = new Map();   // a main path -> its last {key, birth}
    this.at = 0;
    this.refreshing = null;
  }

  // Real paths and identities, at most once per REFRESH_MS; concurrent
  // callers share one refresh. One that throws fails its callers and is
  // not kept: the next call runs another.
  refresh() {
    if (Date.now() - this.at < REFRESH_MS) return Promise.resolve();
    if (this.refreshing != null) return this.refreshing;
    this.refreshing = (async () => {
      const reals = new Set();
      const idents = new Set();
      const {pathMod, key, hostFs} = this.rules;
      for (const p of this.paths) {
        const real = await realOf(p, pathMod, hostFs);
        reals.add(key(real));
        const st = await hostFs.stat(real, {bigint: true}).catch(() => null);
        if (st == null) continue;
        idents.add(idKey(st));
        if (stickable(st) && this.main.includes(p)) this.keep(p, st);
      }
      this.reals = reals;
      this.idents = idents;
      this.at = Date.now();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  // A main path's identity, into its ring of the last STICKY_PER_PATH.
  keep(p, st) {
    const entry = {key: idKey(st), birth: birthOf(st)};
    const ring = this.sticky.get(p) || [];
    const last = ring[ring.length - 1];
    if (last != null && last.key === entry.key && last.birth === entry.birth) return;
    ring.push(entry);
    if (ring.length > STICKY_PER_PATH) ring.shift();
    this.sticky.set(p, ring);
  }

  // Whether the object at realLoc (its real path), with identity ident
  // ({dev, ino, birthtimeMs} when known; key, when given, is its exact
  // "dev:ino"), is one of the denied files.
  async matches(realLoc, ident) {
    if (this.paths.length === 0) return false;
    await this.refresh();
    if (realLoc != null && this.reals.has(this.rules.key(realLoc))) return true;
    if (ident == null || ident.ino == null) return false;
    const key = ident.key || idKey(ident);
    if (this.idents.has(key)) return true;
    const birth = Number(ident.birthtimeMs);
    for (const ring of this.sticky.values()) {
      if (ring.some((k) => k.key === key && k.birth === birth)) return true;
    }
    return false;
  }

  // An outside path's location and identity with this set's rules
  // (locateOutside).
  locate(v, follow) {
    return locateOutside(v, follow, this.rules);
  }

  // Whether an outside path v (the broker's "outside" kind) is one of the
  // denied files.
  async matchesOutside(v, follow) {
    if (this.paths.length === 0) return false;
    const at = await this.locate(v, follow);
    return this.matches(at.loc, at.ident);
  }
}

// A directory whose whole tree is refused to a module's writes (the pin
// records, lib/manifest-pins.js): a write whose real location is the
// directory or anything under it, by its real path (re-taken at most once a
// second) or the path as given.
//
// With the host's path rules (hostRules; issue #40): on Windows a case,
// separator or trailing-dot spelling of the directory is the directory.
class DeniedTree {
  constructor(dir, opts) {
    this.rules = hostRules(opts);
    this.dir = this.rules.pathMod.resolve(dir);
    this.real = this.dir;
    this.at = 0;
    this.refreshing = null;
  }

  // The real path, at most once per REFRESH_MS; concurrent callers share one.
  refresh() {
    if (Date.now() - this.at < REFRESH_MS) return Promise.resolve();
    if (this.refreshing == null) {
      this.refreshing = realOf(this.dir, this.rules.pathMod, this.rules.hostFs).then((real) => {
        this.real = real;
        this.at = Date.now();
      }).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async matches(realLoc) {
    if (realLoc == null) return false;
    await this.refresh();
    const {key, keySep} = this.rules;
    const k = key(realLoc);
    const under = (d) => { const kd = key(d); return k === kd || k.startsWith(kd.endsWith(keySep) ? kd : kd + keySep); };
    return under(this.real) || under(this.dir);
  }
}

// The directories above some paths, every one up to the root, refused to a
// module's writes (#151's final check): renaming one away, making a new one
// and moving the contents back would leave the paths where they were, but a
// restart would find none of them there in between (the pin records, the
// identity secret, the module's manifest). Matched by the real path of each
// directory and by the path as given, re-taken at most once a second; what
// is in the directories is not affected. With the host's path rules
// (hostRules; issue #40): on Windows C:\\CH\\MODDATA is C:\\ch\\moddata.
class AncestorGuard {
  constructor(paths, opts) {
    this.rules = hostRules(opts);
    this.paths = paths.map((p) => this.rules.pathMod.resolve(p));
    this.dirs = new Set();
    this.at = 0;
    this.refreshing = null;
  }

  refresh() {
    if (Date.now() - this.at < REFRESH_MS) return Promise.resolve();
    if (this.refreshing == null) {
      this.refreshing = (async () => {
        const dirs = new Set();
        const {pathMod, key, hostFs} = this.rules;
        const above = (p) => { for (let d = pathMod.dirname(p); ; d = pathMod.dirname(d)) { dirs.add(key(d)); if (pathMod.dirname(d) === d) break; } };
        for (const p of this.paths) {
          above(p);
          above(await realOf(p, pathMod, hostFs));
        }
        this.dirs = dirs;
        this.at = Date.now();
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async matches(realLoc) {
    if (realLoc == null || this.paths.length === 0) return false;
    await this.refresh();
    return this.dirs.has(this.rules.key(realLoc));
  }
}

module.exports = {DeniedSet, DeniedTree, AncestorGuard, deniedPathsFor, locateOutside, REFRESH_MS};

'use strict';
// One module worker's file broker on the main thread (docs/superpowers/
// specs/2026-10-17-module-sandbox-fs-broker-design.md, section 3). Each call
// runs one primitive operation: decide by mode, check on the host, run it
// with Node's async fs, verify after open, and answer with virtual paths.
const fsp = require('fs/promises');
const {BIG, fileKey, sameFile, differentFile, identStat} = require('../file-identity');
const fs = require('fs');
const posix = require('path').posix;
const {inside} = require('./namespace');
const spawnWalk = require('./spawn-walk');
const {nodeError, rewrite} = require('./errors');
const {RwLock} = require('./rwlock');

// readlink's answer: a relative target as it is; an absolute one the
// namespace's own (/app/...) when it is in a root, else as the host has it
// (D:\... on Windows, #195). On Windows a target rooted with no drive
// (\data\x or /data/x) is refused (EINVAL): as given it would read, or
// resolve, as the namespace's /app, /data or /tmp (the patch respells
// those, lib/fs-broker/roots.js seenFormFor, C-compat-win), and qualified
// with the link's drive it would name a part of a host path the module
// never saw -- so neither (the high on #505, 2: failing closed). POSIX as
// before.
function readlinkAnswer(ns, target) {
  const host = ns.hostPath || posix;
  if (!host.isAbsolute(target)) return target;
  let whole = target;
  if (ns.win32) {
    const unc = /^[\\/]{2}/.test(target);
    const drive = /^[a-zA-Z]:/.test(target);
    if (!unc && !drive) throw Object.assign(new Error('EINVAL: a link target rooted with no drive, readlink'), {code: 'EINVAL', syscall: 'readlink'});
    whole = whole.split('/').join('\\');
  }
  const v = ns.toVirtual(whole);
  return v != null ? v : whole;
}

const MAX_FDS = 256;
const RP_CACHE_MS = 1000;
const RP_CACHE_MAX = 1024;
// Tests only: delays each write so a test can hold the broker busy. Read once
// at load, and only under the test suite's own variable (review M1).
function testDelayMs(env) {
  if (env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG == null) return 0;
  return Number(env.COUNTINGHOUSE_TEST_BROKER_DELAY_MS) || 0;
}
const TEST_DELAY_MS = testDelayMs(process.env);
const MAX_IO = 16 * 1024 * 1024;
const MAX_REPORTS = 100;
const ANCESTOR_STATS = {dev: 0, ino: 0, mode: 0o040555, nlink: 1, uid: 0, gid: 0, rdev: 0, size: 0, blksize: 4096, blocks: 0,
  atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0};
const STAT_KEYS = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs'];

function statsOut(st, bigint) {
  const f = {};
  STAT_KEYS.forEach((k) => { f[k] = st[k]; });
  if (bigint) ['atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].forEach((k) => { f[k] = st[k]; });
  return {kind: 'stats', bigint: bigint === true, fields: f};
}

function direntType(d) {
  if (d.isFile()) return 'file';
  if (d.isDirectory()) return 'dir';
  if (d.isSymbolicLink()) return 'symlink';
  return 'other';
}

// Node's string flags (lib/internal/fs/utils.js stringToFlags), as a table.
const FLAG_TABLE = {
  r: 'O_RDONLY', rs: 'O_RDONLY|O_SYNC', sr: 'O_RDONLY|O_SYNC', 'r+': 'O_RDWR', 'rs+': 'O_RDWR|O_SYNC', 'sr+': 'O_RDWR|O_SYNC',
  w: 'O_TRUNC|O_CREAT|O_WRONLY', wx: 'O_TRUNC|O_CREAT|O_WRONLY|O_EXCL', xw: 'O_TRUNC|O_CREAT|O_WRONLY|O_EXCL',
  'w+': 'O_TRUNC|O_CREAT|O_RDWR', 'wx+': 'O_TRUNC|O_CREAT|O_RDWR|O_EXCL', 'xw+': 'O_TRUNC|O_CREAT|O_RDWR|O_EXCL',
  a: 'O_APPEND|O_CREAT|O_WRONLY', ax: 'O_APPEND|O_CREAT|O_WRONLY|O_EXCL', xa: 'O_APPEND|O_CREAT|O_WRONLY|O_EXCL',
  as: 'O_APPEND|O_CREAT|O_WRONLY|O_SYNC', sa: 'O_APPEND|O_CREAT|O_WRONLY|O_SYNC',
  'a+': 'O_APPEND|O_CREAT|O_RDWR', 'ax+': 'O_APPEND|O_CREAT|O_RDWR|O_EXCL', 'xa+': 'O_APPEND|O_CREAT|O_RDWR|O_EXCL',
  'as+': 'O_APPEND|O_CREAT|O_RDWR|O_SYNC', 'sa+': 'O_APPEND|O_CREAT|O_RDWR|O_SYNC'
};

// (the pre-work high on #513, F2) A numeric flags value holds only the bits
// a string flag maps to (FLAG_TABLE: access mode, O_CREAT, O_EXCL, O_TRUNC,
// O_APPEND, O_SYNC, O_DSYNC) and the module's own O_NOFOLLOW, by the
// platform's own constants; any other is EINVAL. Windows maps other bits to
// what POSIX bits can't judge -- 0x40 to delete-on-close, 0x10000000 to an
// exclusive lock -- so judged as a read, a 0x40 open deleted the file.
const ALLOWED_FLAGS = ['O_RDONLY', 'O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_EXCL', 'O_TRUNC', 'O_APPEND', 'O_SYNC', 'O_DSYNC', 'O_NOFOLLOW'];
function flagsAllowed(n, constants) {
  if (!Number.isInteger(n) || n < 0 || n > 0x7fffffff) return false;
  const mask = ALLOWED_FLAGS.reduce((m, k) => (typeof(constants[k]) === 'number' ? m | constants[k] : m), 0);
  return (n & ~mask) === 0;
}

function numericFlags(flags) {
  if (typeof(flags) === 'number') {
    if (!flagsAllowed(flags, fs.constants)) throw nodeError('EINVAL', 'open');
    return flags;
  }
  const spec = FLAG_TABLE[flags == null ? 'r' : String(flags)];
  if (spec == null) throw nodeError('EINVAL', 'open');
  return spec.split('|').reduce((n, k) => n | fs.constants[k], 0);
}

function openFlags(flags) {
  const n = numericFlags(flags);
  const c = fs.constants;
  return {
    writes: (n & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_APPEND)) !== 0,
    creates: (n & (c.O_CREAT | c.O_TRUNC | c.O_EXCL)) !== 0
  };
}

class FsBroker {
  constructor(opts) {
    this.name = opts.name;
    this.mode = opts.mode;
    this.ns = opts.namespace;
    this.cwd = opts.cwd || '/';
    this.reportFn = opts.report || (() => {});
    this.enforce = (opts.mode === 'enforce');
    this.hooks = opts.hooks || {};
    // The disk quota for /data and /tmp (lib/fs-broker/quota.js); null when
    // not counted (--moduleSandbox off, or no limits).
    this.quota = opts.quota || null;
    // The always-denied files (lib/fs-broker/denied.js): null under off.
    this.denied = opts.denied || null;
    // The module's own package.json (a DeniedSet of one), refused to every
    // write in audit and enforce: its declarations (R2-1 Task 4). null under off.
    this.ownManifest = opts.ownManifest || null;
    // The pin records' directory, every module's, refused to every write in
    // audit and enforce (lib/manifest-pins.js). null under off.
    // The host's path rules for these guards: the namespace's platform
    // (issue #40).
    const rules = {platform: this.ns.platform};
    this.deniedWrites = (opts.pinsDir != null) ? new (require('./denied').DeniedTree)(opts.pinsDir, rules) : null;
    // The protected paths (lib/fs-broker/index.js protectedPaths: the
    // install, every module's code and data, the local store, the auth and
    // device config, the policy, the remote credentials file, ch-local's
    // home; #253 and its follow-up):
    // every path in each refused, reads and writes, in audit and enforce, but
    // those in the module's own base roots (its /app, /data and /tmp, which
    // the runtime gives it). Only those three, by the real paths fixed when
    // the namespace was prepared and never re-read: a declared root, or one
    // swapped later for a link, is never the module's own here (#253's
    // security review, F1). null under off.
    const {DeniedTree, TopLevelNames, hostRules, OWN_FILES} = require('./denied');
    this.deniedTrees = (Array.isArray(opts.deniedTrees) && opts.deniedTrees.length > 0) ? opts.deniedTrees.map((d) => new DeniedTree(d, rules)) : null;
    this.homeRules = hostRules(rules);
    // the install's top-level dot entries and auth.json, refused even under
    // the module's own roots (#260's review). null under off.
    this.installSecrets = (opts.installSecrets != null)
      ? new TopLevelNames(opts.installSecrets, (name) => name.startsWith('.') || this.homeRules.key(name) === this.homeRules.key('auth.json'), rules) : null;
    this.ownRootKeys = (this.deniedTrees != null)
      ? this.ns.roots.filter((r) => r.name === 'app' || r.name === 'data' || r.name === 'tmp').map((r) => this.homeRules.key(r.real)) : [];
    // Every directory above the records, the identity secret and the
    // manifest, refused to every write in audit and enforce (#151's final
    // check): none can be renamed away and back. null under off.
    const guarded = [].concat(this.ownManifest != null ? this.ownManifest.paths : [], opts.pinsDir != null ? [opts.pinsDir] : [],
      // a path in ch-local's home, so the home itself and every directory
      // above it are guarded
      // a path in each protected directory, so it and every directory above
      // it are guarded (a protected file guards its own directory up)
      this.deniedTrees != null ? opts.deniedTrees.map((d) => (this.ns.hostPath || posix).join(d, '.guarded')) : [],
      this.denied != null ? this.denied.paths.filter((p) => OWN_FILES.includes((this.ns.hostPath || posix).basename(p))) : []);
    this.ancestors = (guarded.length > 0) ? new (require('./denied').AncestorGuard)(guarded, rules) : null;
    this.inFlight = 0;
    this.idleWaiters = [];
    this.rpCache = new Map();   // directory host path -> {real, at} (cachedRealpath)
    this.schedule = opts.schedule || ((fn) => fn());
    this.maxEntries = opts.maxEntries || 100000;
    this.lock = new RwLock();
    this.fds = new Map();
    this.nextFd = 3;
    this.reported = new Set();
    this.closed = false;
  }

  report(rule, target) {
    if (this.mode === 'off') return;
    const key = `${rule}\0${target}`;
    if (this.reported.has(key) || this.reported.size > MAX_REPORTS) return;
    this.reported.add(key);
    if (this.reported.size > MAX_REPORTS) return this.reportFn('suppressed', '');
    this.reportFn(rule, target);
  }

  // Every operation is counted while it runs, so idle() can tell the
  // lifecycle lock when a broker whose worker is gone has finished
  // (lib/module-lifecycle.js; spec section 3, "Worker end").
  async handle(op, args) {
    this.inFlight++;
    try {
      return await this.handleOne(op, args);
    } finally {
      this.inFlight--;
      if (this.inFlight === 0) this.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  idle() {
    return this.inFlight === 0 ? Promise.resolve() : new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async handleOne(op, args) {
    const spec = OPS[op];
    if (spec == null) throw nodeError('EINVAL', op);
    if (this.closed) throw nodeError('EIO', op);
    const a = args || [];
    const mode = (typeof(spec.lock) === 'function') ? spec.lock(a) : spec.lock;
    if (mode === 'none') return this.schedule(() => spec.run.call(this, a));
    const exclusive = (mode === 'exclusive');
    await this.lock.acquire(exclusive);
    // A mutation can change any directory's real path: start it with an empty
    // cache. Shared operations that filled it have released their locks.
    if (exclusive) this.rpCache.clear();
    try {
      return await this.schedule(() => spec.run.call(this, a));
    } finally {
      this.lock.release(exclusive);
    }
  }

  // Place one path argument for an operation that wants 'r' or 'w'.
  // Returns {res, host, virtual, root, ident} or throws the module-facing error.
  async place(p, want, syscall, follow) {
    const res = this.ns.resolve(p, this.cwd);
    const v = res.virtual;
    // Windows: a namespace path still holding a "\" (lib/fs-broker/
    // namespace.js), in every mode.
    if (res.kind === 'refused') {
      this.report('denied', v);
      throw nodeError('EACCES', syscall, v);
    }
    // Windows: a path in the module's own roots (/app, /data, /tmp: not a
    // declared root, the operator's) with a ":" in a segment names an NTFS
    // stream (note:alt, note::$DATA). Its bytes escape the quota's walk at a
    // spawn (lstat and readdir see main streams only), so a module could
    // fill the disk past its limit across restarts: under enforce it answers
    // as if nothing were there, before the host is touched; audit reports
    // it and lets it through; off decides nothing about files. (No Windows
    // file name holds a ":" otherwise; a mkdtemp prefix with one would make
    // a stream too.)
    if (this.ns.win32 && res.kind === 'root' && OWN_ROOTS.has(res.root.name) && hasStream(v)) {
      this.report('win-stream', v);
      if (this.enforce) {
        const e = nodeError('ENOENT', syscall, v);
        e.winStream = true;
        throw e;
      }
    }
    // A write to the module's own package.json, by its /app path or by its
    // host path, linked or not, or to anything in the pin records' directory,
    // is refused EACCES and recorded as a denial (R2-1 Task 4): decided below
    // on the real location and identity the path resolves to, which a path in
    // a root already has from checkHost.
    const guardWrites = (want === 'w' && (this.ownManifest != null || this.deniedWrites != null || this.ancestors != null));
    if (res.kind === 'ancestor') {
      if (!this.enforce) {
        // under audit an ancestor of a root passes through, but not one in a
        // protected path (ch-local's home, --moduleDataPath: a listing of
        // every module's), #253
        if ((this.deniedTrees != null || this.installSecrets != null) && await this.inDeniedTree(v)) {
          this.report('denied', v);
          throw nodeError('EACCES', syscall, v);
        }
        // under audit no write leaves the module's own area (maintainer's
        // decision, 2026-11-15)
        if (this.mode === 'audit' && want === 'w') {
          this.report('denied', v);
          throw nodeError('EACCES', syscall, v);
        }
        const at = guardWrites ? await this.outsideIdentity(v, follow !== false) : null;
        if (at != null && await this.writeDenied(at.loc, at.ident, at.real)) {
          this.report('denied', v);
          throw nodeError('EACCES', syscall, v);
        }
        return {res: {kind: 'outside', virtual: v, host: v}, host: v, virtual: v};
      }
      if (want === 'w') throw nodeError('EROFS', syscall, v);
      return {res, host: null, virtual: v};
    }
    if (res.kind === 'outside') {
      // The always-denied set and the module's own package.json first, in
      // audit and enforce: the path is resolved on the host (realpath, then
      // lstat), the one cost an outside access pays under audit, where it is
      // otherwise passed through. Denied is EACCES, ahead of the ENOENT
      // enforce gives an outside path: these files' existence is no secret.
      if (this.denied != null || this.deniedTrees != null || this.installSecrets != null || guardWrites) {
        const at = await this.outsideIdentity(v, follow !== false);
        if ((this.denied != null && (await this.denied.matches(at.loc, at.ident) || (at.real != null && await this.denied.matches(at.real, at.ident)))) ||
            await this.inDeniedTree(at.loc, at.real) ||
            (guardWrites && await this.writeDenied(at.loc, at.ident, at.real))) {
          this.report('denied', v);
          throw nodeError('EACCES', syscall, v);
        }
      }
      // under audit a module reads outside its namespace (logged) but writes
      // nothing there: no write leaves its own area (maintainer's decision,
      // 2026-11-15)
      if (this.mode === 'audit' && want === 'w') {
        this.report('denied', v);
        throw nodeError('EACCES', syscall, v);
      }
      this.report('outside', v);
      if (this.enforce) throw nodeError('ENOENT', syscall, v);
      return {res, host: v, virtual: v};
    }
    const placed = {res, host: res.host, virtual: v, root: res.root, ident: null};
    // --moduleSandbox off decides nothing about files, so it skips the host
    // checks (plan 5 Task 4b, A): the root is the one the virtual path names.
    // The link rules, EXDEV, EBUSY on roots and the special-file check use
    // virtual paths, placed.root or the opened descriptor, and still run (the
    // symlink rule also walks its target on the host: symlinkLandsInRoot).
    if (this.mode === 'off') {
      if (this.hooks.afterCheck) await this.hooks.afterCheck(syscall, res.host);
      return placed;
    }
    const chk = await this.checkHost(placed, syscall, follow !== false);
    // A denied file reached from inside the namespace -- a symlink in /tmp,
    // a hard link in a declared directory -- is EACCES too, decided on the
    // real location and identity checkHost already resolved.
    if ((this.denied != null && await this.denied.matches(chk.loc, chk.ident)) ||
        await this.inDeniedTree(chk.loc) ||
        (guardWrites && await this.writeDenied(chk.loc, chk.ident))) {
      this.report('denied', v);
      throw nodeError('EACCES', syscall, v);
    }
    if (chk.escape) {
      this.report('escape', v);
      if (this.enforce) throw nodeError('ENOENT', syscall, v);
      // a path in a root that really leads outside it: under audit read
      // (logged), never written
      if (this.mode === 'audit' && want === 'w') {
        this.report('denied', v);
        throw nodeError('EACCES', syscall, v);
      }
      placed.escaped = true;
    } else {
      placed.root = chk.root;
      placed.ident = chk.ident;
      placed.real = chk.loc;
    }
    // (F5) a write at a dangling link in a root it can't write answers as a
    // write at a link that leaves the root does (ENOENT, under enforce),
    // never EROFS: which of the two it got told whether the target exists
    if (want === 'w' && !placed.root.writable && this.enforce && placed.ident != null && placed.ident.link === true) {
      this.report('link-dangling', `ENOENT ${v}`);
      throw nodeError('ENOENT', syscall, v);
    }
    if (want === 'w' && !placed.root.writable) {
      // under audit too: the module's own area for writes is its /data, its
      // /tmp and what it declared rw, never /app or a path declared r
      if (this.mode === 'audit') {
        this.report('denied', v);
        throw nodeError('EACCES', syscall, v);
      }
      this.report('readonly', v);
      if (this.enforce) throw nodeError('EROFS', syscall, v);
    }
    if (this.hooks.afterCheck) await this.hooks.afterCheck(syscall, res.host);
    return placed;
  }

  // The real path of a directory, cached (plan 5 Task 4b, C). Safe because:
  // every exclusive (mutating) operation clears the cache before it runs, so
  // the module cannot change its own tree under a stale entry; an entry
  // expires after 1000 ms, bounding how long a host process's change -- or
  // another module's change in a shared declared rw directory, which does
  // not clear this module's cache -- goes unseen (the documented host race;
  // the other module can only make symlinks with a relative target and no
  // "..", decided on where they really lead (symlinkLandsInRoot), so a link it
  // makes cannot lead outside the declared path, before or after a rename,
  // and neither can a stale entry); only
  // directories are cached, never the file a call names; and under enforce
  // verifyOpened still checks every opened descriptor against its real
  // location, so an open cannot land outside through a stale entry.
  async cachedRealpath(dir) {
    const now = Date.now();
    const hit = this.rpCache.get(dir);
    if (hit != null && now - hit.at < RP_CACHE_MS) return hit.real;
    const real = await fsp.realpath(dir);
    if (this.rpCache.size >= RP_CACHE_MAX) this.rpCache.delete(this.rpCache.keys().next().value);
    this.rpCache.set(dir, {real: real, at: now});
    return real;
  }

  // Where the object the operation acts on really is, and which root holds
  // it. Following ops resolve the leaf; no-follow ops (acting on a link
  // itself) resolve the parent and lstat the leaf. Returns {root, ident},
  // or {escape: true} when the real location is in no root.
  async checkHost(placed, syscall, follow) {
    const res = placed.res;
    const isRootItself = (res.virtual === res.root.vroot);
    // the host's path rules (path.win32 on Windows; namespace.js hostPath)
    const hp = this.ns.hostPath || posix;
    // Read as bigints, and kept so: dev and ino exact for verifyOpened's
    // comparison with a descriptor's stat (a Windows file index past 2^53
    // loses its low bits as a Number, and two files would compare alike),
    // the exact key and the birthtime for the denied set
    // (lib/fs-broker/denied.js).
    let realLoc = null;
    let ident = null;
    const viaParent = async() => {
      const parentReal = await this.cachedRealpath(hp.dirname(res.host)).catch(() => null);
      if (parentReal == null) return false;   // the operation itself answers ENOENT
      realLoc = hp.join(parentReal, hp.basename(res.host));
      const st = await fsp.lstat(realLoc, BIG).catch(() => null);
      // (a name that is a link the open would follow, dangling now: marked,
      // so an open of it is refused under enforce before it follows
      // (danglingLeaf), and verifyOpened sees only a link that appeared
      // after)
      ident = (st != null && !follow) ? identOf(st) : (st != null && st.isSymbolicLink()) ? {parent: parentReal, link: true} : {parent: parentReal};
      return true;
    };
    // Following a name: the parent's (cached) real path and an lstat of the
    // name give the identity in one pool job when the name is not a link.
    if (follow && !isRootItself) {
      const parentReal = await this.cachedRealpath(hp.dirname(res.host)).catch(() => null);
      if (parentReal != null) {
        const loc = hp.join(parentReal, hp.basename(res.host));
        const st = await fsp.lstat(loc, BIG).catch((e) => (e.code === 'ENOENT' ? 'missing' : null));
        if (st === 'missing') {
          realLoc = loc;
          ident = {parent: parentReal};
        } else if (st != null && !st.isSymbolicLink()) {
          realLoc = loc;
          // (plain: no link at the name, so the open passes O_NOFOLLOW --
          // openNoting)
          ident = Object.assign(identOf(st), {plain: true});
        }
      }
    }
    if (realLoc != null) {
      // resolved above
    } else if (follow || isRootItself) {
      try {
        realLoc = await fsp.realpath(res.host);
        // (lstat: a link that appeared at the resolved path since -- a race
        // -- is never the file judged; the pre-work high on #513, F7)
        const st = await fsp.lstat(realLoc, BIG);
        if (st.isSymbolicLink()) {
          this.report('link-appeared', placed.virtual);
          throw Object.assign(nodeError('ENOENT', syscall, placed.virtual), {linkAppeared: true});
        }
        // (resolved: the name reached through realpath -- a link the check
        // followed and approved, maybe -- opened at this real path, so the
        // link is never followed at open; openNoting)
        ident = Object.assign(identOf(st), {resolved: true});
      } catch (e) {
        // (a link that appeared is refused, never taken for a missing name)
        if (e.linkAppeared === true) throw e;
        if (e.code !== 'ENOENT') throw rewrite(e, syscall, placed, null, this.ns);
        if (!(await viaParent())) return {root: res.root, ident: null};
      }
    } else if (!(await viaParent())) {
      return {root: res.root, ident: null};
    }
    const root = this.ns.rootForReal(realLoc);
    if (root == null) return {escape: true, loc: realLoc, ident: ident};
    return {root: root, ident: ident, loc: realLoc};
  }

  // Whether a write's real location is one no write may reach: the module's
  // own package.json, the pin records' directory, or a directory above
  // either or above the identity secret. real, when given, is another name
  // for loc (an outside leaf's long name on Windows; outsideIdentity), and
  // is checked too.
  // In ch-local's home and in none of the module's own roots, by its
  // location or real path.
  async inDeniedTree(loc, real) {
    if (this.deniedTrees == null && this.installSecrets == null) return false;
    for (const p of (real != null ? [loc, real] : [loc])) {
      if (p == null) continue;
      if (this.installSecrets != null && await this.installSecrets.matches(p)) return true;
      if (this.deniedTrees == null) continue;
      let inTree = false;
      for (const t of this.deniedTrees) if (await t.matches(p)) { inTree = true; break; }
      if (!inTree) continue;
      const {key, keySep} = this.homeRules;
      const k = key(p);
      const own = this.ownRootKeys.some((r) => k === r || k.startsWith(r.endsWith(keySep) ? r : r + keySep));
      if (!own) return true;
    }
    return false;
  }

  async writeDenied(loc, ident, real) {
    for (const p of (real != null ? [loc, real] : [loc])) {
      if ((this.ownManifest != null && await this.ownManifest.matches(p, ident)) ||
        (this.deniedWrites != null && await this.deniedWrites.matches(p)) ||
        (this.ancestors != null && await this.ancestors.matches(p))) return true;
    }
    return false;
  }

  // An outside path's real location and identity, for the denied set and the
  // module's own package.json: the leaf for a following operation, the name
  // in its real parent otherwise (on Windows also its long name, as real,
  // for an 8.3 short name); a missing leaf is known by its name in the real
  // parent. Located with the host's path rules (lib/fs-broker/denied.js
  // locateOutside; path.win32 on Windows, issue #40), by the denied set's own
  // locator when there is one.
  async outsideIdentity(v, follow) {
    const set = this.denied || this.ownManifest;
    return set != null ? set.locate(v, follow) : require('./denied').locateOutside(v, follow);
  }

  // writes: a write-open must land in the very root checkHost decided on, so
  // a host-process swap cannot steer it into /app or a declared r path.
  // made: {created}, from openNoting -- a refused open's own file is
  // removed here, while the descriptor is still open (an open descriptor
  // keeps its inode from being reused, so the identity compared is still the
  // file's), and made.removed says so. It never closes the descriptor: each
  // caller closes it, in one place, on any throw.
  async verifyOpened(fh, placed, syscall, writes, made) {
    if (!this.enforce || placed.res.kind !== 'root') return;
    const hp = this.ns.hostPath || posix;   // as checkHost splits it
    const refuse = async(rule, code) => {
      if (made != null && made.created === true) made.removed = await removeOwn(fh);
      this.report(rule, placed.virtual);
      throw nodeError(code || 'ENOENT', syscall, placed.virtual);
    };
    let ok = true;
    let st = null;
    if (placed.ident == null || placed.ident.parent !== undefined) {
      // No file at the name when checkHost ran: its parent missing (FB2,
      // ident null), or there with nothing, or a dangling link, at the name
      // ({parent}). Decided on where the descriptor really landed: the
      // parent's real path now -- in the root the virtual path names (FB2),
      // or the very one checkHost found ({parent}) -- and the name in it.
      const parentReal = await fsp.realpath(hp.dirname(placed.host)).catch(() => null);
      ok = parentReal != null && (placed.ident == null ? this.ns.rootForReal(parentReal) === placed.root : parentReal === placed.ident.parent);
      if (ok) {
        const at = await identStat(hp.join(parentReal, hp.basename(placed.host))).catch(() => null);
        // A leaf that is a link here appeared in the race that left
        // checkHost nothing to decide (one that was a link to nothing then
        // never gets this far: danglingLeaf): refused wherever it leads,
        // fail closed -- nothing legitimate needs a link to appear there
        // mid-open -- and reported as what it is, not as an escape (ruled
        // 11-10, L1; the high review of #466; docs/security-model.md, the
        // host-race item)
        if (at != null && at.isSymbolicLink()) await refuse('link-appeared');
        // (exact, as bigints: lib/file-identity.js)
        st = await fh.stat(BIG);
        ok = sameFile(at, st);
        // (a denied file landing at the name in the race -- a hard link to
        // it, a rename of it -- refused by the opened file's own identity,
        // as place() refuses it by its name; the module's own package.json
        // for a write the same; the second high review of #466, 3)
        // (a file this very open created -- O_EXCL said so -- is no denied
        // one, whose number a just-replaced denied file's may reuse)
        if (ok && !(made != null && made.created === true)) {
          const opened = identOf(st);
          if ((this.denied != null && await this.denied.matches(null, opened)) ||
              (writes && this.ownManifest != null && await this.ownManifest.matches(null, opened))) await refuse('denied', 'EACCES');
          // (a file that appeared in the race with more than one link -- a
          // hard link to a file protected by its path alone, a pin record
          // say -- is refused for writing: nothing at the name was judged)
          if (writes && st.nlink > 1n) await refuse('denied', 'EACCES');
        }
      }
    } else {
      st = await fh.stat(BIG);
      ok = sameFile(st, placed.ident);
    }
    if (ok && process.platform === 'linux') {
      const link = await fsp.readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
      if (link != null) {
        const holder = this.ns.rootForReal(link);
        if (holder == null || (writes && holder !== placed.root)) ok = false;
      }
    }
    if (!ok) await refuse('escape');
    // (its fstat, for the caller: one, not two; the second high review of
    // #466, 8)
    return st;
  }

  // A name that is a link to nothing when checkHost ran ({parent, link}):
  // an open would follow it wherever it leads -- outside, or to a file it
  // is pointed at in the race -- before anything could judge that. Under
  // enforce refused, ENOENT, before the open; reported in audit and
  // enforce as link-dangling, its errno first; off decides nothing about
  // files (ruled D1, the review of #466; docs/security-model.md)
  // (an exclusive create -- O_EXCL, COPYFILE_EXCL -- never follows a link:
  // it answers EEXIST as ever, unreported. On POSIX the kernel says so; on
  // Windows a create-new follows a link to nothing and makes its target
  // wherever it leads, so there a link at the name answers EEXIST here,
  // before any open, wherever the check runs (audit and enforce; off
  // decides nothing about files) -- C-win-excl, found by C-win-baseline)
  // (under audit too for a creating open: no write under audit leaves the
  // module's own area, and one through a link to nothing would make its
  // target wherever it leads -- maintainer's decision, 2026-11-15; the
  // second high review of #466)
  // (the pre-work high on #513, F5) An exclusive create -- O_CREAT with
  // O_EXCL, COPYFILE_EXCL -- at a link leaf in a root answers EEXIST before
  // the link is resolved, whatever it leads to: resolved first, a link out
  // to a file that exists answered ENOENT and one to nothing EEXIST, which
  // told the module whether a file outside its roots exists. As POSIX's
  // kernel answers it; audit and enforce (off decides nothing about files).
  async exclusiveLeaf(p, syscall) {
    if (this.mode === 'off') return;
    const res = this.ns.resolve(p, this.cwd);
    if (res.kind !== 'root' || res.host == null) return;
    const st = await fsp.lstat(res.host).catch(() => null);
    if (st != null && st.isSymbolicLink()) throw nodeError('EEXIST', syscall, res.virtual);
  }

  danglingLeaf(placed, syscall, exclusive, creating) {
    if (placed.ident == null || placed.ident.link !== true) return;
    if (exclusive === true) {
      if (this.ns.win32) throw nodeError('EEXIST', syscall, placed.virtual);
      return;
    }
    this.report('link-dangling', `ENOENT ${placed.virtual}`);
    if (this.enforce || (this.mode === 'audit' && creating === true)) throw nodeError('ENOENT', syscall, placed.virtual);
  }

  // An open that may create its file, noting whether it did, and never
  // following a leaf link the check didn't approve. Under enforce, in a
  // root, with O_NOFOLLOW (Windows has none: there the checks after the
  // open stand alone, docs/security-model.md):
  // - where checkHost saw nothing at the name (ident null: its parent
  //   missing; {parent}: missing), O_EXCL first, so it knows whether it made
  //   the file; on EEXIST the open as asked, having made nothing it knows
  //   of. A link that appeared since is the kernel's ELOOP: nothing created,
  //   reported link-appeared (the second high review of #466).
  // - where it saw a plain file, at the name, and where it reached a file
  //   through realpath -- a link it followed -- at that real path: never
  //   O_CREAT (the file was there), so a parent or a link changed since
  //   creates nothing anywhere (ruled R-a).
  // -> {fh, created}. Ruled 11-10.
  async openNoting(placed, flags, mode, syscall) {
    const c = fs.constants;
    const creates = (flags & c.O_CREAT) !== 0;
    const excl = (flags & c.O_EXCL) !== 0;
    const watched = this.enforce && placed.res.kind === 'root';
    const id = placed.ident;
    const missing = id == null || (id.parent !== undefined && id.link !== true);
    const seen = id != null && (id.plain === true || id.resolved === true);
    const nofollow = (watched && c.O_NOFOLLOW !== undefined && (missing || seen)) ? c.O_NOFOLLOW : 0;
    // (the module's own O_NOFOLLOW asks for the name, never what a link
    // there leads to: opened at the name as on master, and its ELOOP is the
    // module's answer, not link-appeared)
    const callerNofollow = c.O_NOFOLLOW !== undefined && (flags & c.O_NOFOLLOW) !== 0;
    const at = (watched && !callerNofollow && id != null && id.resolved === true && typeof(placed.real) === 'string') ? placed.real : placed.host;
    const openOne = (fl) => fsp.open(at, fl | nofollow, mode).catch(async(e) => {
      // (ELOOP or EMLINK from O_NOFOLLOW where the check saw no link: the
      // leaf a link now -- confirmed, since a loop in a parent says ELOOP
      // too -- reported as link-appeared; answered ENOENT, or with the
      // module's own O_NOFOLLOW its ELOOP, as master answers it)
      // (no link where it was opened: nothing, or a plain file, at the
      // name -- or a resolved file at its real path)
      const sawNoLink = missing || (id != null && (id.plain === true || (id.resolved === true && at !== placed.host)));
      if (nofollow !== 0 && sawNoLink && (e.code === 'ELOOP' || e.code === 'EMLINK')) {
        const leaf = await lstatOrNull(at);
        if (leaf != null && leaf.isSymbolicLink()) {
          this.report('link-appeared', placed.virtual);
          if (!callerNofollow) throw nodeError('ENOENT', syscall, placed.virtual);
        }
      }
      throw e;
    });
    if (watched && seen && !excl) return {fh: await openOne(flags & ~c.O_CREAT), created: false};
    if (creates && !excl && missing && watched) {
      try { return {fh: await openOne(flags | c.O_EXCL), created: true}; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      return {fh: await openOne(flags), created: false};
    }
    return {fh: await openOne(flags), created: creates && excl};
  }

  // FB1: a symlink a module makes takes a relative target with no ".."
  // segment, and is then decided by where that target really leads, not by
  // its text. Without "..", a link the module made can lead only into its own
  // directory's subtree, wherever that directory is later renamed within the
  // root -- given no outward link made by a host process, which is already an
  // escape (the walk below follows any link it meets and judges where it
  // leads; one a host process places later is the host race documented
  // below); a check of the text alone, or of the real target at creation alone,
  // can be undone later (x -> "." then y -> "x/.." leads to the root's parent;
  // so does a/b/l -> "../../f" once a/b is renamed to b). The walk is for the
  // links the module did not make (a host process's, or ones that predate
  // this rule): it starts at the real path of the link's directory and takes
  // one component at a time, following any link it meets the way the kernel
  // will when the new link is used (40 hops at most, as the kernel's ELOOP).
  // Once a component does not exist, or is not a directory, the rest is taken
  // as written, and a ".." there (from a followed link) is refused: what it
  // would mean is decided by whatever is created there later. True only when
  // the place is in the link's own root. Runs in every mode, like the rest of
  // the link rules; the host race (a change between this walk and the
  // symlink call) stays as documented.
  async symlinkLandsInRoot(at, target) {
    // the host's path rules for host paths (checkHost); a target's
    // components are "/"-separated (on Windows one with "\" or ":" is
    // refused before this)
    const hp = this.ns.hostPath || posix;
    let cur = await fsp.realpath(hp.dirname(at.host)).catch(() => null);
    if (cur == null) return false;
    const todo = target.split('/');
    // (an lstat or readlink the walk can't make for another reason than a
    // race's -- EACCES, EIO, too many links -- decides nothing: refused, and
    // reported with its errno under its own rule, so an operator can tell it
    // from a link-rule violation; ruled 11-10)
    const unreadable = (code) => {
      this.report('link-unreadable', `${typeof(code) === 'string' ? code : 'error'} ${at.virtual}`);
      return false;
    };
    let hops = 0;
    let settled = true;   // false once a component is missing or not a directory
    while (todo.length > 0) {
      const c = todo.shift();
      if (c === '' || c === '.') continue;
      if (c === '..') {
        if (!settled) return false;
        cur = hp.dirname(cur);
        continue;
      }
      const next = hp.join(cur, c);
      if (!settled) { cur = next; continue; }
      let failed = null;
      const st = await fsp.lstat(next).catch((e) => {
        if (isWalkRace(e.code)) return null;
        failed = e;
        return undefined;
      });
      if (st === undefined) return unreadable(failed && failed.code);
      if (st !== null && st.isSymbolicLink()) {
        // (more than the kernel's 40: its ELOOP, reported as one)
        if (++hops > 40) return unreadable('ELOOP');
        let linkFailed = null;
        const link = await fsp.readlink(next).catch((e) => { linkFailed = e; return null; });
        // (a link swapped since the lstat -- no longer one, EINVAL, or gone
        // -- is a race, refused unreported, as a missing component is)
        if (link == null) return (linkFailed != null && (linkFailed.code === 'EINVAL' || isWalkRace(linkFailed.code))) ? false : unreadable(linkFailed && linkFailed.code);
        // Windows: a link the host made with "\", ":" or a leading "/" (a
        // drive, share or root-relative path) is the OS's to resolve, not
        // this walk's: refused, as the target rule refuses one (round 4).
        if (this.ns.win32 && (/[\\:]/.test(link) || link.startsWith('/'))) return false;
        if (posix.isAbsolute(link)) cur = '/';
        todo.unshift(...link.split('/'));
        continue;
      }
      cur = next;
      if (st === null || !st.isDirectory()) settled = false;
    }
    // (the root the link really lands in, checkHost's -- through a host-made
    // link that can be another declared root than the one its virtual path
    // names; ruled 11-10)
    return this.ns.rootForReal(cur) === at.root;
  }

  isRoot(placed) {
    return placed.res.kind === 'root' && placed.res.virtual === placed.res.root.vroot;
  }

  fdEntry(fd, syscall) {
    const e = this.fds.get(fd);
    if (e == null) throw nodeError('EBADF', syscall);
    return e;
  }

  // A descriptor a write-class call may use: one open placed for writing.
  // On one opened read-only, a write, a truncate or a change of its mode,
  // owner or times is refused -- EACCES under audit, EROFS under enforce --
  // and recorded (#264's review, W1: fchmod on a read-only descriptor of an
  // outside file, or of /app/package.json, changed it). Off decides nothing.
  writableEntry(fd, syscall) {
    const e = this.fdEntry(fd, syscall);
    if (e.writes !== true && this.mode !== 'off') {
      this.report('denied', e.virtual);
      throw nodeError(this.enforce ? 'EROFS' : 'EACCES', syscall, e.virtual);
    }
    return e;
  }

  out(hostPath, placed) {
    if (placed.res.kind !== 'root') return hostPath;
    const v = this.ns.toVirtual(hostPath);
    return v != null ? v : placed.virtual;
  }

  run(placed, syscall, fn, dest) {
    return fn().catch((e) => { throw rewrite(e, syscall, placed, dest, this.ns); });
  }

  // Runs fn with a reservation on the quota, then settles with what actually
  // changed (actual(result) -> {bytes, entries}). Not counted: fn alone.
  // failed: what a throw left used, when the op can tell ({bytes,
  // entries}); else nothing
  async counted(placed, bytes, entries, syscall, fn, actual, failed) {
    if (this.quota == null || !quotaRoot(placed)) return fn();
    this.quota.reserve(bytes, entries, syscall, placed.virtual);
    let result;
    try { result = await fn(); } catch (e) {
      let left = {bytes: 0, entries: 0};
      if (failed != null) { try { left = failed(); } catch (e2) { left = {bytes: 0, entries: 0}; } }
      this.quota.settle(bytes, entries, left.bytes, left.entries);
      throw e;
    }
    // what changed isn't known (actual threw): the reservation counts as
    // used, and the op, which did succeed, answers as it did (never told
    // failed: a retry would apply it twice)
    let a = {bytes: bytes, entries: entries};
    if (actual != null) {
      try { a = await actual(result); } catch (e) { a = {bytes: bytes, entries: entries}; }
    }
    this.quota.settle(bytes, entries, a.bytes, a.entries);
    return result;
  }

  // Gives back what a successful removal or replacement freed.
  release(placed, usage) {
    if (this.quota != null && quotaRoot(placed) && (usage.bytes !== 0 || usage.entries !== 0)) this.quota.settle(0, 0, -usage.bytes, -usage.entries);
  }

  async closeAll() {
    this.closed = true;
    const all = Array.from(this.fds.values());
    this.fds.clear();
    await Promise.all(all.map((e) => e.fh.close().catch(() => {})));
  }
}

const SHARED = 'shared';
// A path on /data or /tmp, where the quota is counted.
// Counted by the root the path names (ruled Q1: a link a module makes
// between its own declared roots can move bytes between their counts,
// never past an uncounted root's existing freedom; docs/security-model.md)
const quotaRoot = (p) => p != null && p.res != null && p.res.kind === 'root' && p.res.root.quota === true;
// (identity exact, as bigints: lib/file-identity.js; sizes and link counts
// read as Numbers where they are used)
const lstatOrNull = (p) => identStat(p).catch(() => null);
// a file's identity as checkHost and the denied set take it
const identOf = (st) => ({dev: st.dev, ino: st.ino, key: fileKey(st), birthtimeMs: Number(st.birthtimeMs)});
// (what a component the walk takes can answer when it simply isn't there:
// the rest is taken as written, never reported)
const isWalkRace = (code) => code === 'ENOENT' || code === 'ENOTDIR';

// A refused open's own file, removed where its still-open descriptor really
// is (/proc/self/fd: Linux), only while that name is still the very file
// (dev and ino exact; the open descriptor keeps the inode from being
// reused). Elsewhere it stays: never removed by a path a host process can
// swap. A swap between the check and the unlink is the host race in
// docs/security-model.md. -> whether one was removed
// (Linux only: its descriptor names its file. Windows has none Node can
// read, and a removal by a path -- one a host process can swap -- could
// delete a file the module never made, so none is tried there; with an
// exclusive create never following a link (danglingLeaf), what is left is
// the documented host race -- C-win-excl, its medium)
async function removeOwn(fh) {
  if (process.platform !== 'linux') return false;
  const at = await fsp.readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
  const ident = await fh.stat(BIG).catch(() => null);
  if (typeof(at) !== 'string' || ident == null) return false;
  const st = await lstatOrNull(at);
  return (st != null && sameFile(st, ident)) ? fsp.unlink(at).then(() => true, () => false) : false;
}

// What removing a path gives back: a directory's subtree (bytes only for
// files whose every link is inside it, review I1), a file's size when it is
// the last link, one entry per name.
async function removalUsage(placed) {
  const st = await lstatOrNull(placed.host);
  if (st == null) return {bytes: 0, entries: 0};
  if (st.isDirectory()) {
    const sub = await spawnWalk.measure([[placed.host, placed.virtual]], {whollyInside: true});
    return {bytes: sub.bytes, entries: sub.entries + 1};
  }
  return {bytes: (st.isFile() && st.nlink === 1n) ? Number(st.size) : 0, entries: 1};
}

// Whether a link target, in "/" segments, has one Windows takes as other
// than its text: trailing dots or spaces (trimmed by Win32 path rules; ".."
// itself is FB1's, refused anyway; "." is the directory), or a DOS device
// name as Win32 reads one: CON, PRN, AUX, NUL, COM0-9, LPT0-9 (and the
// superscript digits), any case, then spaces and any extensions (NUL.txt,
// NUL.tar.gz, CON .txt); CONIN$ and CONOUT$ bare only
const WIN_DEVICE = /^(?:(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]) *(?:\..*)?|conin\$|conout\$)$/i;
// The module's own roots, by name (a declared root is the operator's)
const OWN_ROOTS = new Set(['app', 'data', 'tmp']);
// A namespace path with a ":" in a segment: an NTFS stream on Windows
function hasStream(p) {
  return p.split('/').some((s) => s.includes(':'));
}
function windowsTrims(target) {
  return target.split('/').some((s) => s !== '.' && s !== '' && (/[. ]$/.test(s) || WIN_DEVICE.test(s)));
}

const EXCL = 'exclusive';
const NONE = 'none';

// Each operation: lock mode (or a function of its args), and run(args).
const OPS = {
  access: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'access');
    if (p.host == null) return true;
    return this.run(p, 'access', () => fsp.access(p.host, a[1]).then(() => true));
  }},
  exists: {lock: SHARED, async run(a) {
    try {
      const p = await this.place(a[0], 'r', 'access');
      if (p.host != null) await fsp.access(p.host);
      return true;
    } catch (e) { return false; }
  }},
  stat: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'stat');
    const big = !!(a[1] && a[1].bigint);
    if (p.host == null) return statsOut(ANCESTOR_STATS, false);
    return this.run(p, 'stat', () => fsp.stat(p.host, {bigint: big}).then((s) => statsOut(s, big)));
  }},
  lstat: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'lstat', false);
    const big = !!(a[1] && a[1].bigint);
    if (p.host == null) return statsOut(ANCESTOR_STATS, false);
    return this.run(p, 'lstat', () => fsp.lstat(p.host, {bigint: big}).then((s) => statsOut(s, big)));
  }},
  realpath: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'realpath');
    if (p.host == null) return p.virtual;
    return this.run(p, 'realpath', () => fsp.realpath(p.host).then((r) => this.out(r, p)));
  }},
  readlink: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'readlink', false);
    return this.run(p, 'readlink', async() => {
      return readlinkAnswer(this.ns, await fsp.readlink(p.host));
    });
  }},
  readdir: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'scandir');
    const opts = a[1] || {};
    if (p.host == null) {
      const kids = p.res.children;
      return opts.withFileTypes ? kids.map((k) => ({name: k.name, type: k.type, parentPath: p.virtual})) : kids.map((k) => k.name);
    }
    return this.run(p, 'scandir', async() => {
      const out = [];
      // Nothing in a protected path (ch-local's home, every module's code and
      // data, the store, ...) is listed, or walked into, from above it
      // (#253's security review, F2): decided on real paths -- the starting
      // directory's, each subdirectory's before it is walked, and a linked
      // entry's -- never on the path as the module gave it, which a symlink
      // can lead anywhere. The listing keeps the module's own spelling.
      const guarded = this.deniedTrees != null || this.installSecrets != null;
      const realOf = (d) => fsp.realpath(d).catch(() => null);
      const start = guarded ? await realOf(p.host) : p.host;
      if (guarded && (start == null || await this.inDeniedTree(start))) {
        this.report('denied', p.virtual);
        throw nodeError('EACCES', 'scandir', p.virtual);
      }
      // breadth first, one directory at a time, stopping at the cap (review I5)
      const queue = [[start, p.host, '']];
      while (queue.length > 0) {
        const [real, dir, rel] = queue.shift();
        const list = await fsp.readdir(real, {withFileTypes: true});
        for (const d of list) {
          if (out.length >= this.maxEntries) throw nodeError('ENOBUFS', 'scandir', p.virtual);
          let childReal = `${real}/${d.name}`;
          if (guarded) {
            if (d.isSymbolicLink() || d.isDirectory()) childReal = await realOf(childReal);
            // a link that leads into a protected path is not listed; one whose
            // target can't be resolved (dangling, a loop) is listed as the
            // link it is, and never walked into
            if (childReal != null && await this.inDeniedTree(childReal)) continue;
            if (childReal == null && d.isDirectory()) continue;
          }
          const relName = rel === '' ? d.name : `${rel}/${d.name}`;
          out.push(opts.withFileTypes ? {name: d.name, type: direntType(d), parentPath: this.out(dir, p)} : relName);
          if (opts.recursive && d.isDirectory()) queue.push([childReal, `${dir}/${d.name}`, relName]);
        }
      }
      return out;
    });
  }},
  statfs: {lock: SHARED, async run(a) {
    const p = await this.place(a[0], 'r', 'statfs');
    return this.run(p, 'statfs', () => fsp.statfs(p.host).then((s) => Object.assign({}, s)));
  }},

  mkdir: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'mkdir', false);
    // a recursive mkdir creates each missing component
    let missing = 1;
    if (this.quota != null && quotaRoot(p) && a[1] != null && a[1].recursive) {
      missing = 0;
      // up the host path by the host's rules (backslashes on Windows)
      const hp = this.ns.hostPath || posix;
      for (let h = p.host; h !== p.res.root.host && h !== hp.dirname(h) && (await lstatOrNull(h)) == null; h = hp.dirname(h)) missing++;
    }
    return this.counted(p, 0, missing, 'mkdir',
      () => this.run(p, 'mkdir', () => fsp.mkdir(p.host, a[1]).then((r) => (r == null ? undefined : this.out(r, p)))));
  }},
  mkdtemp: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'mkdtemp', false);
    return this.counted(p, 0, 1, 'mkdtemp', () => this.run(p, 'mkdtemp', () => fsp.mkdtemp(p.host).then((r) => this.out(r, p))));
  }},
  rmdir: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'rmdir', false);
    if (this.isRoot(p)) throw nodeError('EBUSY', 'rmdir', p.virtual);
    await this.run(p, 'rmdir', () => fsp.rmdir(p.host));
    this.release(p, {bytes: 0, entries: 1});
  }},
  rm: {lock: EXCL, async run(a) {
    // (force: a stream answered as missing is nothing to remove, as for any
    // missing file; any other refusal stands)
    const p = await this.place(a[0], 'w', 'rm', false).catch((e) => {
      if (e.winStream === true && a[1] != null && a[1].force === true) return null;
      throw e;
    });
    if (p == null) return undefined;
    if (this.isRoot(p)) throw nodeError('EBUSY', 'rm', p.virtual);
    const usage = (this.quota != null && quotaRoot(p)) ? await removalUsage(p) : null;
    await this.run(p, 'rm', () => fsp.rm(p.host, a[1]));
    if (usage != null) this.release(p, usage);
  }},
  unlink: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'unlink', false);
    if (this.isRoot(p)) throw nodeError('EBUSY', 'unlink', p.virtual);
    const usage = (this.quota != null && quotaRoot(p)) ? await removalUsage(p) : null;
    await this.run(p, 'unlink', () => fsp.unlink(p.host));
    if (usage != null) this.release(p, usage);
  }},
  rename: {lock: EXCL, async run(a) {
    const from = await this.place(a[0], 'w', 'rename', false);
    const to = await this.place(a[1], 'w', 'rename', false);
    if (this.isRoot(from) || this.isRoot(to)) throw nodeError('EBUSY', 'rename', from.virtual, to.virtual);
    if (from.res.kind === 'root' && to.res.kind === 'root' && from.root !== to.root) throw nodeError('EXDEV', 'rename', from.virtual, to.virtual);
    // Replacing a different file gives it back; renaming onto the same inode
    // (to itself, or another name of the file) changes nothing (review I2).
    let replaced = null;
    if (this.quota != null && quotaRoot(to)) {
      const [src, dst] = await Promise.all([lstatOrNull(from.host), lstatOrNull(to.host)]);
      if (dst != null && differentFile(src, dst)) {
        replaced = {bytes: (dst.isFile() && dst.nlink === 1n) ? Number(dst.size) : 0, entries: 1};
      }
    }
    await this.run(from, 'rename', () => fsp.rename(from.host, to.host), to);
    if (replaced != null) this.release(to, replaced);
  }},
  copyFile: {lock: EXCL, async run(a) {
    const from = await this.place(a[0], 'r', 'copyfile');
    if ((Number(a[2] || 0) & fs.constants.COPYFILE_EXCL) !== 0) await this.exclusiveLeaf(a[1], 'copyfile');
    const to = await this.place(a[1], 'w', 'copyfile');
    // (the source judged before anything follows it, the quota's stat too)
    this.danglingLeaf(from, 'copyfile');
    if (this.quota != null && quotaRoot(to)) {
      // (counted by the root the path names; the destination's old size from
      // the file the open will truncate -- its real path where the check
      // reached it through a link -- only when that file is in the same root,
      // counted there: one a link leads into another root gives back nothing.
      // The source's size, under enforce, never through a link the check
      // didn't approve -- its real path, or an lstat of the name: an
      // outside file's size, its EDQUOT, no answer about it; under audit,
      // where the copy follows any link, as the copy does)
      const resolvedAt = (x) => (x.ident != null && x.ident.resolved === true && typeof(x.real) === 'string') ? x.real : null;
      const dstReal = resolvedAt(to);
      const dstAt = dstReal == null ? to.host : (to.root === to.res.root ? dstReal : null);
      const srcSize = this.enforce ? lstatOrNull(resolvedAt(from) || from.host) : fsp.stat(from.host, BIG).catch(() => null);
      const [srcSt, dst] = await Promise.all([srcSize, dstAt != null ? lstatOrNull(dstAt) : Promise.resolve(null)]);
      const src = (srcSt != null && srcSt.isFile()) ? {size: Number(srcSt.size)} : null;
      const old = (dst != null && dst.isFile()) ? Number(dst.size) : 0;
      const bytes = (src != null ? src.size : 0) - old;
      // (a new name only where nothing was there: a link the check reached a
      // file through is one already)
      const newName = dstReal == null && dst == null;
      // (a copy that fails leaves used what it left: the destination's new
      // entry while verifyOpened didn't remove it, as open's; the bytes
      // written once it was truncated, against what was there; the second
      // high review of #466, 5)
      const state = {made: null, truncated: false, written: 0};
      return this.counted(to, bytes, newName ? 1 : 0, 'copyfile', () => OPS.copyFile.copy.call(this, a, from, to, state), null,
        () => ({bytes: state.truncated ? state.written - old : 0, entries: (newName && state.made != null && !state.made.removed) ? 1 : 0}));
    }
    return OPS.copyFile.copy.call(this, a, from, to);
  }, async copy(a, from, to, state) {
    const c = fs.constants;
    const excl = (Number(a[2] || 0) & c.COPYFILE_EXCL) !== 0;
    let src = null;
    let dst = null;
    try {
      // (as an open is: never following a leaf link the check didn't
      // approve, at the real path where it reached the file through one)
      src = (await this.openNoting(from, c.O_RDONLY | c.O_NONBLOCK, undefined, 'copyfile').catch((e) => { throw rewrite(e, 'copyfile', from, to, this.ns); })).fh;
      const st = await src.stat();
      // every mode: a FIFO or device source would block a pool thread
      if (!st.isFile()) throw nodeError('EPERM', 'copyfile', from.virtual, to.virtual);
      await this.verifyOpened(src, from, 'copyfile', false);
      this.danglingLeaf(to, 'copyfile', excl, true);
      const o = await this.openNoting(to, c.O_WRONLY | c.O_CREAT | c.O_NONBLOCK | (excl ? c.O_EXCL : 0), st.mode & 0o777, 'copyfile')
        .catch((e) => { throw rewrite(e, 'copyfile', from, to, this.ns); });
      dst = o.fh;
      const made = {created: o.created, removed: false};
      if (state != null) state.made = made;
      // (closed by the finally below on any throw, a refusal's included)
      await this.verifyOpened(dst, to, 'copyfile', true, made);
      await dst.truncate(0);
      if (state != null) state.truncated = true;
      const buf = Buffer.alloc(1024 * 1024);
      for (;;) {
        const r = await src.read(buf, 0, buf.length, null);
        if (r.bytesRead === 0) break;
        let done = 0;
        while (done < r.bytesRead) {
          const w = (await dst.write(buf, done, r.bytesRead - done)).bytesWritten;
          done += w;
          if (state != null) state.written += w;
        }
      }
    } finally {
      if (src) await src.close().catch(() => {});
      if (dst) await dst.close().catch(() => {});
    }
  }},
  link: {lock: EXCL, async run(a) {
    const from = await this.place(a[0], 'r', 'link', false);
    // (the pre-work high on #513, F1) a source that is a symbolic link is
    // refused, on every platform: macOS link(2) and Windows CreateHardLinkW
    // follow a link in its last component, so the new name would be the
    // link's target -- an outside file -- as a plain file in the root
    if (this.mode !== 'off' && from.host != null) {
      const fromSt = await fsp.lstat(from.host).catch(() => null);
      if (fromSt != null && fromSt.isSymbolicLink()) throw nodeError('EPERM', 'link', from.virtual, String(a[1]));
    }
    // No second name for a pin record: a write through it would change the
    // record in place, out of the records' directory (lib/manifest-pins.js).
    const fromAt = (this.deniedWrites != null && from.host != null) ? await this.outsideIdentity(from.host, false) : null;
    if (fromAt != null && (await this.deniedWrites.matches(fromAt.loc) || (fromAt.real != null && await this.deniedWrites.matches(fromAt.real)))) {
      this.report('denied', from.virtual);
      throw nodeError('EACCES', 'link', from.virtual);
    }
    // under audit a hard link's source must be in the module's own area too:
    // a second name in /data for an outside file would be a way to write it
    if (this.mode === 'audit' && (from.res.kind !== 'root' || from.escaped === true)) {
      this.report('denied', from.virtual);
      throw nodeError('EACCES', 'link', from.virtual);
    }
    const to = await this.place(a[1], 'w', 'link', false);
    const touches = from.res.kind === 'root' || to.res.kind === 'root';
    if (touches && !(from.res.kind === 'root' && to.res.kind === 'root' && from.root === to.root && to.root.writable)) {
      throw nodeError('EPERM', 'link', from.virtual, to.virtual);
    }
    return this.counted(to, 0, 1, 'link', () => this.run(from, 'link', () => fsp.link(from.host, to.host), to));
  }},
  symlink: {lock: EXCL, async run(a) {
    const target = String(a[0]);
    const at = await this.place(a[1], 'w', 'symlink', false);
    if (at.res.kind === 'root') {
      const resolved = posix.resolve(posix.dirname(at.virtual), target);
      // Windows: a target with a "\" (a drive-qualified, UNC or device path
      // the patch kept as given) or a ":" (a drive letter, drive-relative
      // C:..\x too) is the OS's to resolve, not these POSIX checks'.
      // (and on Windows a segment Windows treats as other than its text --
      // trailing dots or spaces, ".. ", "...", "x.", or a device name, CON,
      // NUL, COM1 -- is refused: C-win-excl, the C-fb-rename belt pulled
      // into release 1. A Windows run found link targets not trimmed when
      // followed (C-win-baseline's probe), so this is defence in depth)
      if ((this.ns.win32 && (/[\\:]/.test(target) || windowsTrims(target))) || posix.isAbsolute(target) || target.split('/').includes('..') || !inside(resolved, at.res.root.vroot) ||
          !(await this.symlinkLandsInRoot(at, target))) {
        throw nodeError('EPERM', 'symlink', target, at.virtual);
      }
    }
    return this.counted(at, 0, 1, 'symlink', () => this.run(at, 'symlink', () => fsp.symlink(target, at.host, a[2])));
  }},
  chmod: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'chmod');
    return this.run(p, 'chmod', () => fsp.chmod(p.host, Number(a[1]) & 0o777));
  }},
  chown: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'chown');
    return this.run(p, 'chown', () => fsp.chown(p.host, a[1], a[2]));
  }},
  lchown: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'lchown', false);
    return this.run(p, 'lchown', () => fsp.lchown(p.host, a[1], a[2]));
  }},
  utimes: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'utime');
    return this.run(p, 'utime', () => fsp.utimes(p.host, a[1], a[2]));
  }},
  lutimes: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'lutime', false);
    return this.run(p, 'lutime', () => fsp.lutimes(p.host, a[1], a[2]));
  }},
  // (the pre-work high on #513, F7) through a descriptor: opened r+ with
  // every check an open makes after it opens, then cut there -- a path's
  // truncate, which a host process can swap after the check, never runs
  truncate: {lock: EXCL, async run(a) {
    const fd = await OPS.open.run.call(this, [a[0], 'r+']);
    try {
      return await OPS.ftruncate.run.call(this, [fd, a[1]]);
    } finally {
      await OPS.close.run.call(this, [fd]);
    }
  }},

  open: {lock: (a) => (openFlags(a[1]).creates ? EXCL : SHARED), async run(a) {
    const fl = openFlags(a[1]);
    const n = numericFlags(a[1]);
    const exclusive = (n & (fs.constants.O_CREAT | fs.constants.O_EXCL)) === (fs.constants.O_CREAT | fs.constants.O_EXCL);
    if (exclusive) await this.exclusiveLeaf(a[0], 'open');
    const p = await this.place(a[0], fl.writes ? 'w' : 'r', 'open');
    // (exclusive only as O_CREAT and O_EXCL together: O_EXCL alone follows
    // a link like any open)
    const createExcl = fs.constants.O_CREAT | fs.constants.O_EXCL;
    // (exclusive -- following no link -- as O_CREAT with O_EXCL, or with the
    // module's own O_NOFOLLOW: the kernel answers EEXIST or ELOOP as ever)
    const ownNofollow = fs.constants.O_NOFOLLOW !== undefined && (n & fs.constants.O_NOFOLLOW) !== 0;
    this.danglingLeaf(p, 'open', (n & createExcl) === createExcl || ownNofollow, (n & fs.constants.O_CREAT) !== 0);
    if (p.host == null) throw nodeError('EISDIR', 'open', p.virtual);
    if (this.fds.size >= MAX_FDS) throw nodeError('EMFILE', 'open', p.virtual);
    // Opened without O_TRUNC and truncated only once verified, so a target
    // swapped by a host process is refused before anything is lost.
    const truncate = (n & fs.constants.O_TRUNC) !== 0;
    // Quota: a new name is one entry; truncating gives the old size back.
    const counts = this.quota != null && quotaRoot(p);
    const before = counts ? await lstatOrNull(p.host) : null;
    const newEntry = counts && before == null && (n & fs.constants.O_CREAT) !== 0;
    if (newEntry) this.quota.reserve(0, 1, 'open', p.virtual);
    let fh;
    let made;
    try {
      const o = await this.openNoting(p, (n & ~fs.constants.O_TRUNC) | fs.constants.O_NONBLOCK, a[2], 'open');
      fh = o.fh;
      made = {created: o.created, removed: false};
    } catch (e) {
      if (newEntry) this.quota.settle(0, 1, 0, 0);
      throw rewrite(e, 'open', p, null, this.ns);
    }
    // the new name is there: its entry, reserved, is settled as used at once
    // (a session's view keeps reservations in flight apart: R1 Task 6)
    if (newEntry) this.quota.settle(0, 1, 0, 1);
    // (closed here, once, on any throw before the descriptor is handed out:
    // a refusal, a special file, an fstat or truncate failing alike)
    let handed = false;
    try {
      let verified;
      try { verified = await this.verifyOpened(fh, p, 'open', fl.writes, made); } catch (e) {
        // (its entry given back only when its file is gone: a file left
        // where it landed may be in the counted root, and counted it stays
        // -- over, never under)
        if (made.removed && newEntry) this.release(p, {bytes: 0, entries: 1});
        throw e;
      }
      // Every open is non-blocking, so a FIFO, socket or device cannot block a
      // pool thread at open; what it turned out to be decides the rest (review I2).
      const st = verified != null ? verified : await fh.stat();
      // a directory is never opened for writing (the kernel says EISDIR on
      // POSIX; Windows, opened without O_TRUNC, would hand out the descriptor)
      if (fl.writes && st.isDirectory()) throw nodeError('EISDIR', 'open', p.virtual);
      if (!st.isFile() && !st.isDirectory()) {
        this.report('special', p.virtual);
        if (this.enforce) throw nodeError('EPERM', 'open', p.virtual);
      }
      // (the broker closed meanwhile -- the worker gone: closeAll -- never
      // registered after it, and nothing truncated; the second high review
      // of #466, 6)
      if (this.closed) throw nodeError('EIO', 'open', p.virtual);
      if (truncate && st.isFile()) {
        await fh.truncate(0).catch((e) => { throw rewrite(e, 'open', p, null, this.ns); });
        if (counts && Number(st.size) > 0) this.quota.settle(0, 0, -Number(st.size), 0);
      }
      // (and again after the truncate: a closeAll during it too -- the file
      // already emptied then, which nobody waits on: the worker is gone)
      if (this.closed) throw nodeError('EIO', 'open', p.virtual);
      const fd = this.nextFd++;
      // pos: the file position for calls without one (Node has no seek, so it is
      // exact); append: writes go to the end. Both feed the quota's growth.
      // writes: whether open placed it for writing (#264's review, W1): a
      // descriptor opened read-only changes nothing, not even its metadata
      this.fds.set(fd, {fh, virtual: p.virtual, placed: p, chain: Promise.resolve(), pos: 0,
        append: (n & fs.constants.O_APPEND) !== 0, counts: counts, writes: fl.writes === true});
      handed = true;
      return fd;
    } finally {
      if (!handed) await fh.close().catch(() => {});
    }
  }},
  readFile: {lock: (a) => (openFlags(a[1]).creates ? EXCL : SHARED), async run(a) {
    const fd = await OPS.open.run.call(this, [a[0], a[1] == null ? 'r' : a[1]]);
    const e = this.fds.get(fd);
    try {
      const parts = [];
      let size = 0;
      for (;;) {
        const buf = Buffer.alloc(64 * 1024);
        const r = await e.fh.read(buf, 0, buf.length, null).catch((err) => { throw rewrite(err, 'read', e.placed, null, this.ns); });
        if (r.bytesRead === 0) break;
        size += r.bytesRead;
        if (size > MAX_IO) throw nodeError('EFBIG', 'read', e.virtual);
        parts.push(buf.subarray(0, r.bytesRead));
      }
      return Buffer.concat(parts);
    } finally {
      this.fds.delete(fd);
      await e.fh.close().catch(() => {});
    }
  }},
  // writeFile and appendFile in one brokered call (plan 5 Task 4b, B): open,
  // write all, close, inside the broker, so the quota, the post-open verify
  // and the special-file check apply as they do to the three separate calls.
  writeFile: {lock: (a) => (openFlags(a[2]).creates ? EXCL : SHARED), async run(a) {
    const buf = Buffer.from(a[1]);
    if (buf.length > MAX_IO) throw nodeError('EINVAL', 'write', String(a[0]));
    const fd = await OPS.open.run.call(this, [a[0], a[2] == null ? 'w' : a[2], a[3]]);
    try {
      for (let off = 0; off < buf.length;) {
        const n = await OPS.write.run.call(this, [fd, buf.subarray(off), null]);
        if (n === 0) break;
        off += n;
      }
    } finally {
      await OPS.close.run.call(this, [fd]);
    }
  }},
  close: {lock: NONE, async run(a) {
    const e = this.fdEntry(a[0], 'close');
    this.fds.delete(a[0]);
    await e.chain;
    await e.fh.close().catch(() => {});
  }},
  read: {lock: NONE, async run(a) {
    const e = this.fdEntry(a[0], 'read');
    const length = Number(a[1]);
    if (!(length >= 0) || length > MAX_IO) throw nodeError('EINVAL', 'read', e.virtual);
    return serial(e, async() => {
      const buf = Buffer.alloc(length);
      const r = await e.fh.read(buf, 0, length, a[2] == null ? null : a[2]).catch((err) => { throw rewrite(err, 'read', e.placed, null, this.ns); });
      if (a[2] == null) e.pos += r.bytesRead;
      return buf.subarray(0, r.bytesRead);
    });
  }},
  write: {lock: NONE, async run(a) {
    const e = this.writableEntry(a[0], 'write');
    const buf = Buffer.from(a[1]);
    if (buf.length > MAX_IO) throw nodeError('EINVAL', 'write', e.virtual);
    return serial(e, async() => {
      // Growth is where the write ends past the current size (logical, so an
      // overwrite in place is free and a sparse extension counts its length).
      const counts = e.counts && this.quota != null;
      let size = 0;
      let at = 0;
      let growth = 0;
      if (counts) {
        size = (await e.fh.stat()).size;
        at = a[2] != null ? Number(a[2]) : (e.append ? size : e.pos);
        growth = Math.max(0, at + buf.length - size);
        this.quota.reserve(growth, 0, 'write', e.virtual);
      }
      let r;
      try {
        if (TEST_DELAY_MS > 0) await new Promise((res) => setTimeout(res, TEST_DELAY_MS));
        r = await e.fh.write(buf, 0, buf.length, a[2] == null ? null : a[2]);
      } catch (err) {
        if (counts) this.quota.settle(growth, 0, 0, 0);
        throw rewrite(err, 'write', e.placed, null, this.ns);
      }
      if (counts) this.quota.settle(growth, 0, Math.max(0, at + r.bytesWritten - size), 0);
      if (a[2] == null) e.pos = (counts && e.append) ? at + r.bytesWritten : e.pos + r.bytesWritten;
      return r.bytesWritten;
    });
  }},
  fstat: {lock: NONE, async run(a) {
    const e = this.fdEntry(a[0], 'fstat');
    const big = !!(a[1] && a[1].bigint);
    return serial(e, () => e.fh.stat({bigint: big}).then((s) => statsOut(s, big)));
  }},
  ftruncate: {lock: NONE, async run(a) {
    const e = this.writableEntry(a[0], 'ftruncate');
    return serial(e, async() => {
      if (!e.counts || this.quota == null) return e.fh.truncate(a[1]);
      const len = Number(a[1] || 0);
      const size = (await e.fh.stat()).size;
      const growth = Math.max(0, len - size);
      this.quota.reserve(growth, 0, 'ftruncate', e.virtual);
      try { await e.fh.truncate(a[1]); } catch (err) { this.quota.settle(growth, 0, 0, 0); throw err; }
      this.quota.settle(growth, 0, len - size, 0);
    });
  }},
  fsync: {lock: NONE, async run(a) { const e = this.fdEntry(a[0], 'fsync'); return serial(e, () => e.fh.sync()); }},
  fdatasync: {lock: NONE, async run(a) { const e = this.fdEntry(a[0], 'fdatasync'); return serial(e, () => e.fh.datasync()); }},
  fchmod: {lock: NONE, async run(a) { const e = this.writableEntry(a[0], 'fchmod'); return serial(e, () => e.fh.chmod(Number(a[1]) & 0o777)); }},
  fchown: {lock: NONE, async run(a) { const e = this.writableEntry(a[0], 'fchown'); return serial(e, () => e.fh.chown(a[1], a[2])); }},
  futimes: {lock: NONE, async run(a) { const e = this.writableEntry(a[0], 'futime'); return serial(e, () => e.fh.utimes(a[1], a[2])); }}
};

// Operations on one descriptor run in order.
function serial(entry, fn) {
  const next = entry.chain.then(fn, fn);
  entry.chain = next.catch(() => {});
  return next;
}

module.exports = {FsBroker, OPS, MAX_IO, MAX_FDS, testDelayMs, windowsTrims, hasStream, readlinkAnswer, flagsAllowed};

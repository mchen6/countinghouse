// One module worker's file broker on the main thread (docs/superpowers/
// specs/2026-10-17-module-sandbox-fs-broker-design.md, section 3). Each call
// runs one primitive operation: decide by mode, check on the host, run it
// with Node's async fs, verify after open, and answer with virtual paths.
const fsp = require('fs/promises');
const fs = require('fs');
const posix = require('path').posix;
const {inside} = require('./namespace');
const spawnWalk = require('./spawn-walk');
const {nodeError, rewrite} = require('./errors');
const {RwLock} = require('./rwlock');

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

function numericFlags(flags) {
  if (typeof(flags) === 'number') return flags;
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
    if (res.kind === 'ancestor') {
      if (!this.enforce) return {res: {kind: 'outside', virtual: v, host: v}, host: v, virtual: v};
      if (want === 'w') throw nodeError('EROFS', syscall, v);
      return {res, host: null, virtual: v};
    }
    if (res.kind === 'outside') {
      // The always-denied set first, in audit and enforce: the path is
      // resolved on the host (realpath, then lstat), the one cost an outside
      // access pays under audit, where it is otherwise passed through.
      // Denied is EACCES, ahead of the ENOENT enforce gives an outside path:
      // these files' existence is no secret.
      if (this.denied != null && await this.deniedOutside(v, follow !== false)) {
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
    if (this.denied != null && await this.denied.matches(chk.loc, chk.ident)) {
      this.report('denied', v);
      throw nodeError('EACCES', syscall, v);
    }
    if (chk.escape) {
      this.report('escape', v);
      if (this.enforce) throw nodeError('ENOENT', syscall, v);
    } else {
      placed.root = chk.root;
      placed.ident = chk.ident;
    }
    if (want === 'w' && !placed.root.writable) {
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
    let realLoc = null;
    let ident = null;
    const viaParent = async() => {
      const parentReal = await this.cachedRealpath(posix.dirname(res.host)).catch(() => null);
      if (parentReal == null) return false;   // the operation itself answers ENOENT
      realLoc = posix.join(parentReal, posix.basename(res.host));
      const st = await fsp.lstat(realLoc).catch(() => null);
      ident = (st != null && !follow) ? {dev: st.dev, ino: st.ino} : {parent: parentReal};
      return true;
    };
    // Following a name: the parent's (cached) real path and an lstat of the
    // name give the identity in one pool job when the name is not a link.
    if (follow && !isRootItself) {
      const parentReal = await this.cachedRealpath(posix.dirname(res.host)).catch(() => null);
      if (parentReal != null) {
        const loc = posix.join(parentReal, posix.basename(res.host));
        const st = await fsp.lstat(loc).catch((e) => (e.code === 'ENOENT' ? 'missing' : null));
        if (st === 'missing') {
          realLoc = loc;
          ident = {parent: parentReal};
        } else if (st != null && !st.isSymbolicLink()) {
          realLoc = loc;
          ident = {dev: st.dev, ino: st.ino};
        }
      }
    }
    if (realLoc != null) {
      // resolved above
    } else if (follow || isRootItself) {
      try {
        realLoc = await fsp.realpath(res.host);
        const st = await fsp.stat(realLoc);
        ident = {dev: st.dev, ino: st.ino};
      } catch (e) {
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

  // An outside path's real location and identity, for the denied set: the
  // leaf for a following operation, the name in its real parent otherwise;
  // a missing leaf is known by its name in the real parent.
  async deniedOutside(v, follow) {
    let loc = null;
    const inParent = async() => posix.join(await fsp.realpath(posix.dirname(v)), posix.basename(v));
    try {
      loc = follow ? await fsp.realpath(v) : await inParent();
    } catch (e) {
      try { loc = await inParent(); } catch (e2) { loc = v; }
    }
    const st = await fsp.lstat(loc).catch(() => null);
    return this.denied.matches(loc, st != null ? {dev: st.dev, ino: st.ino} : null);
  }

  // writes: a write-open must land in the very root checkHost decided on, so
  // a host-process swap cannot steer it into /app or a declared r path.
  async verifyOpened(fh, placed, syscall, writes) {
    if (!this.enforce || placed.res.kind !== 'root') return;
    let ok = true;
    if (placed.ident == null) {
      // FB2: the parent did not resolve when checkHost ran (it was missing),
      // so the check decided nothing; an open that succeeds anyway means the
      // parent appeared in between. Decide on where the descriptor really
      // landed: the parent's real path now must be in the root the virtual
      // path names, and the name there (not followed) must be the opened file.
      const parentReal = await fsp.realpath(posix.dirname(placed.host)).catch(() => null);
      ok = (parentReal != null && this.ns.rootForReal(parentReal) === placed.root);
      if (ok) {
        const st = await fh.stat();
        const at = await fsp.lstat(posix.join(parentReal, posix.basename(placed.host))).catch(() => null);
        ok = (at != null && at.dev === st.dev && at.ino === st.ino);
      }
    } else if (placed.ident.parent !== undefined) {
      const parentReal = await fsp.realpath(posix.dirname(placed.host)).catch(() => null);
      ok = (parentReal != null && parentReal === placed.ident.parent);
    } else {
      const st = await fh.stat();
      ok = (st.dev === placed.ident.dev && st.ino === placed.ident.ino);
    }
    if (ok && process.platform === 'linux') {
      const link = await fsp.readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
      if (link != null) {
        const holder = this.ns.rootForReal(link);
        if (holder == null || (writes && holder !== placed.root)) ok = false;
      }
    }
    if (!ok) {
      await fh.close().catch(() => {});
      this.report('escape', placed.virtual);
      throw nodeError('ENOENT', syscall, placed.virtual);
    }
  }

  // FB1: a symlink a module makes takes a relative target with no ".."
  // segment, and is then decided by where that target really leads, not by
  // its text. Without "..", a link the module made can lead only into its own
  // directory's subtree, wherever that directory is later renamed within the
  // root; a check of the text alone, or of the real target at creation alone,
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
    let cur = await fsp.realpath(posix.dirname(at.host)).catch(() => null);
    if (cur == null) return false;
    const todo = target.split('/');
    let hops = 0;
    let settled = true;   // false once a component is missing or not a directory
    while (todo.length > 0) {
      const c = todo.shift();
      if (c === '' || c === '.') continue;
      if (c === '..') {
        if (!settled) return false;
        cur = posix.dirname(cur);
        continue;
      }
      const next = posix.join(cur, c);
      if (!settled) { cur = next; continue; }
      const st = await fsp.lstat(next).catch((e) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : undefined));
      if (st === undefined) return false;
      if (st !== null && st.isSymbolicLink()) {
        if (++hops > 40) return false;
        const link = await fsp.readlink(next).catch(() => null);
        if (link == null) return false;
        if (posix.isAbsolute(link)) cur = '/';
        todo.unshift(...link.split('/'));
        continue;
      }
      cur = next;
      if (st === null || !st.isDirectory()) settled = false;
    }
    return this.ns.rootForReal(cur) === at.res.root;
  }

  isRoot(placed) {
    return placed.res.kind === 'root' && placed.res.virtual === placed.res.root.vroot;
  }

  fdEntry(fd, syscall) {
    const e = this.fds.get(fd);
    if (e == null) throw nodeError('EBADF', syscall);
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
  async counted(placed, bytes, entries, syscall, fn, actual) {
    if (this.quota == null || !quotaRoot(placed)) return fn();
    this.quota.reserve(bytes, entries, syscall, placed.virtual);
    let result;
    try { result = await fn(); } catch (e) { this.quota.settle(bytes, entries, 0, 0); throw e; }
    const a = actual != null ? await actual(result) : {bytes: bytes, entries: entries};
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
const quotaRoot = (p) => p != null && p.res != null && p.res.kind === 'root' && p.res.root.quota === true;
const lstatOrNull = (p) => fsp.lstat(p).catch(() => null);

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
  return {bytes: (st.isFile() && st.nlink === 1) ? st.size : 0, entries: 1};
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
      const target = await fsp.readlink(p.host);
      if (!posix.isAbsolute(target)) return target;
      const v = this.ns.toVirtual(target);
      return v != null ? v : target;
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
      // breadth first, one directory at a time, stopping at the cap (review I5)
      const queue = [[p.host, '']];
      while (queue.length > 0) {
        const [dir, rel] = queue.shift();
        const list = await fsp.readdir(dir, {withFileTypes: true});
        for (const d of list) {
          if (out.length >= this.maxEntries) throw nodeError('ENOBUFS', 'scandir', p.virtual);
          const relName = rel === '' ? d.name : `${rel}/${d.name}`;
          out.push(opts.withFileTypes ? {name: d.name, type: direntType(d), parentPath: this.out(dir, p)} : relName);
          if (opts.recursive && d.isDirectory()) queue.push([`${dir}/${d.name}`, relName]);
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
      for (let h = p.host; h !== p.res.root.host && (await lstatOrNull(h)) == null; h = posix.dirname(h)) missing++;
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
    const p = await this.place(a[0], 'w', 'rm', false);
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
      if (dst != null && !(src != null && src.dev === dst.dev && src.ino === dst.ino)) {
        replaced = {bytes: (dst.isFile() && dst.nlink === 1) ? dst.size : 0, entries: 1};
      }
    }
    await this.run(from, 'rename', () => fsp.rename(from.host, to.host), to);
    if (replaced != null) this.release(to, replaced);
  }},
  copyFile: {lock: EXCL, async run(a) {
    const from = await this.place(a[0], 'r', 'copyfile');
    const to = await this.place(a[1], 'w', 'copyfile');
    if (this.quota != null && quotaRoot(to)) {
      const [src, dst] = await Promise.all([fsp.stat(from.host).catch(() => null), lstatOrNull(to.host)]);
      const bytes = (src != null ? src.size : 0) - ((dst != null && dst.isFile()) ? dst.size : 0);
      return this.counted(to, bytes, dst == null ? 1 : 0, 'copyfile', () => OPS.copyFile.copy.call(this, a, from, to));
    }
    return OPS.copyFile.copy.call(this, a, from, to);
  }, async copy(a, from, to) {
    const c = fs.constants;
    const excl = (Number(a[2] || 0) & c.COPYFILE_EXCL) !== 0;
    let src = null;
    let dst = null;
    try {
      src = await fsp.open(from.host, c.O_RDONLY | c.O_NONBLOCK).catch((e) => { throw rewrite(e, 'copyfile', from, to, this.ns); });
      const st = await src.stat();
      // every mode: a FIFO or device source would block a pool thread
      if (!st.isFile()) throw nodeError('EPERM', 'copyfile', from.virtual, to.virtual);
      await this.verifyOpened(src, from, 'copyfile', false);
      dst = await fsp.open(to.host, c.O_WRONLY | c.O_CREAT | c.O_NONBLOCK | (excl ? c.O_EXCL : 0), st.mode & 0o777)
        .catch((e) => { throw rewrite(e, 'copyfile', from, to, this.ns); });
      await this.verifyOpened(dst, to, 'copyfile', true);
      await dst.truncate(0);
      const buf = Buffer.alloc(1024 * 1024);
      for (;;) {
        const r = await src.read(buf, 0, buf.length, null);
        if (r.bytesRead === 0) break;
        let done = 0;
        while (done < r.bytesRead) done += (await dst.write(buf, done, r.bytesRead - done)).bytesWritten;
      }
    } finally {
      if (src) await src.close().catch(() => {});
      if (dst) await dst.close().catch(() => {});
    }
  }},
  link: {lock: EXCL, async run(a) {
    const from = await this.place(a[0], 'r', 'link', false);
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
      if ((this.ns.win32 && /[\\:]/.test(target)) || posix.isAbsolute(target) || target.split('/').includes('..') || !inside(resolved, at.res.root.vroot) ||
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
  truncate: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'open');
    const len = Number(a[1] || 0);
    const st = (this.quota != null && quotaRoot(p)) ? await fsp.stat(p.host).catch(() => null) : null;
    const size = st != null ? st.size : 0;
    return this.counted(p, Math.max(0, len - size), 0, 'open', () => this.run(p, 'open', () => fsp.truncate(p.host, a[1])),
      () => ({bytes: len - size, entries: 0}));
  }},

  open: {lock: (a) => (openFlags(a[1]).creates ? EXCL : SHARED), async run(a) {
    const fl = openFlags(a[1]);
    const p = await this.place(a[0], fl.writes ? 'w' : 'r', 'open');
    if (p.host == null) throw nodeError('EISDIR', 'open', p.virtual);
    if (this.fds.size >= MAX_FDS) throw nodeError('EMFILE', 'open', p.virtual);
    // Opened without O_TRUNC and truncated only once verified, so a target
    // swapped by a host process is refused before anything is lost.
    const n = numericFlags(a[1]);
    const truncate = (n & fs.constants.O_TRUNC) !== 0;
    // Quota: a new name is one entry; truncating gives the old size back.
    const counts = this.quota != null && quotaRoot(p);
    const before = counts ? await lstatOrNull(p.host) : null;
    const newEntry = counts && before == null && (n & fs.constants.O_CREAT) !== 0;
    if (newEntry) this.quota.reserve(0, 1, 'open', p.virtual);
    let fh;
    try { fh = await fsp.open(p.host, (n & ~fs.constants.O_TRUNC) | fs.constants.O_NONBLOCK, a[2]); } catch (e) {
      if (newEntry) this.quota.settle(0, 1, 0, 0);
      throw rewrite(e, 'open', p, null, this.ns);
    }
    await this.verifyOpened(fh, p, 'open', fl.writes);
    // Every open is non-blocking, so a FIFO, socket or device cannot block a
    // pool thread at open; what it turned out to be decides the rest (review I2).
    const st = await fh.stat();
    if (!st.isFile() && !st.isDirectory()) {
      this.report('special', p.virtual);
      if (this.enforce) { await fh.close().catch(() => {}); throw nodeError('EPERM', 'open', p.virtual); }
    }
    if (truncate && st.isFile()) {
      await fh.truncate(0).catch((e) => { throw rewrite(e, 'open', p, null, this.ns); });
      if (counts && st.size > 0) this.quota.settle(0, 0, -st.size, 0);
    }
    const fd = this.nextFd++;
    // pos: the file position for calls without one (Node has no seek, so it is
    // exact); append: writes go to the end. Both feed the quota's growth.
    this.fds.set(fd, {fh, virtual: p.virtual, placed: p, chain: Promise.resolve(), pos: 0,
      append: (n & fs.constants.O_APPEND) !== 0, counts: counts});
    return fd;
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
    const e = this.fdEntry(a[0], 'write');
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
    const e = this.fdEntry(a[0], 'ftruncate');
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
  fchmod: {lock: NONE, async run(a) { const e = this.fdEntry(a[0], 'fchmod'); return serial(e, () => e.fh.chmod(Number(a[1]) & 0o777)); }},
  fchown: {lock: NONE, async run(a) { const e = this.fdEntry(a[0], 'fchown'); return serial(e, () => e.fh.chown(a[1], a[2])); }},
  futimes: {lock: NONE, async run(a) { const e = this.fdEntry(a[0], 'futime'); return serial(e, () => e.fh.utimes(a[1], a[2])); }}
};

// Operations on one descriptor run in order.
function serial(entry, fn) {
  const next = entry.chain.then(fn, fn);
  entry.chain = next.catch(() => {});
  return next;
}

module.exports = {FsBroker, OPS, MAX_IO, MAX_FDS, testDelayMs};

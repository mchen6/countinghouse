// One module worker's file broker on the main thread (docs/superpowers/
// specs/2026-10-17-module-sandbox-fs-broker-design.md, section 3). Each call
// runs one primitive operation: decide by mode, check on the host, run it
// with Node's async fs, verify after open, and answer with virtual paths.
const fsp = require('fs/promises');
const fs = require('fs');
const posix = require('path').posix;
const {inside} = require('./namespace');
const {nodeError, rewrite} = require('./errors');
const {RwLock} = require('./rwlock');

// Plan 3 gate (plan 2a, Global Constraints): while false, enforce makes the
// same file decisions as audit. Not an option; plan 3 deletes it.
const ENFORCE_FILE_DECISIONS = false;
const MAX_FDS = 256;
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
    this.enforce = (opts.mode === 'enforce') &&
      (opts.enforceFileDecisions != null ? opts.enforceFileDecisions === true : ENFORCE_FILE_DECISIONS);
    this.hooks = opts.hooks || {};
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

  async handle(op, args) {
    const spec = OPS[op];
    if (spec == null) throw nodeError('EINVAL', op);
    if (this.closed) throw nodeError('EIO', op);
    const a = args || [];
    const mode = (typeof(spec.lock) === 'function') ? spec.lock(a) : spec.lock;
    if (mode === 'none') return this.schedule(() => spec.run.call(this, a));
    const exclusive = (mode === 'exclusive');
    await this.lock.acquire(exclusive);
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
    if (res.kind === 'ancestor') {
      if (!this.enforce) return {res: {kind: 'outside', virtual: v, host: v}, host: v, virtual: v};
      if (want === 'w') throw nodeError('EROFS', syscall, v);
      return {res, host: null, virtual: v};
    }
    if (res.kind === 'outside') {
      this.report('outside', v);
      if (this.enforce) throw nodeError('ENOENT', syscall, v);
      return {res, host: v, virtual: v};
    }
    const placed = {res, host: res.host, virtual: v, root: res.root, ident: null};
    const chk = await this.checkHost(placed, syscall, follow !== false);
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
      const parentReal = await fsp.realpath(posix.dirname(res.host)).catch(() => null);
      if (parentReal == null) return false;   // the operation itself answers ENOENT
      realLoc = posix.join(parentReal, posix.basename(res.host));
      const st = await fsp.lstat(realLoc).catch(() => null);
      ident = (st != null && !follow) ? {dev: st.dev, ino: st.ino} : {parent: parentReal};
      return true;
    };
    if (follow || isRootItself) {
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
    if (root == null) return {escape: true};
    return {root: root, ident: ident};
  }

  // writes: a write-open must land in the very root checkHost decided on, so
  // a host-process swap cannot steer it into /app or a declared r path.
  async verifyOpened(fh, placed, syscall, writes) {
    if (!this.enforce || placed.ident == null || placed.res.kind !== 'root') return;
    let ok = true;
    if (placed.ident.parent !== undefined) {
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

  async closeAll() {
    this.closed = true;
    const all = Array.from(this.fds.values());
    this.fds.clear();
    await Promise.all(all.map((e) => e.fh.close().catch(() => {})));
  }
}

const SHARED = 'shared';
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
    return this.run(p, 'mkdir', () => fsp.mkdir(p.host, a[1]).then((r) => (r == null ? undefined : this.out(r, p))));
  }},
  mkdtemp: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'mkdtemp', false);
    return this.run(p, 'mkdtemp', () => fsp.mkdtemp(p.host).then((r) => this.out(r, p)));
  }},
  rmdir: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'rmdir', false);
    if (this.isRoot(p)) throw nodeError('EBUSY', 'rmdir', p.virtual);
    return this.run(p, 'rmdir', () => fsp.rmdir(p.host));
  }},
  rm: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'rm', false);
    if (this.isRoot(p)) throw nodeError('EBUSY', 'rm', p.virtual);
    return this.run(p, 'rm', () => fsp.rm(p.host, a[1]));
  }},
  unlink: {lock: EXCL, async run(a) {
    const p = await this.place(a[0], 'w', 'unlink', false);
    if (this.isRoot(p)) throw nodeError('EBUSY', 'unlink', p.virtual);
    return this.run(p, 'unlink', () => fsp.unlink(p.host));
  }},
  rename: {lock: EXCL, async run(a) {
    const from = await this.place(a[0], 'w', 'rename', false);
    const to = await this.place(a[1], 'w', 'rename', false);
    if (this.isRoot(from) || this.isRoot(to)) throw nodeError('EBUSY', 'rename', from.virtual, to.virtual);
    if (from.res.kind === 'root' && to.res.kind === 'root' && from.root !== to.root) throw nodeError('EXDEV', 'rename', from.virtual, to.virtual);
    return this.run(from, 'rename', () => fsp.rename(from.host, to.host), to);
  }},
  copyFile: {lock: EXCL, async run(a) {
    const from = await this.place(a[0], 'r', 'copyfile');
    const to = await this.place(a[1], 'w', 'copyfile');
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
    return this.run(from, 'link', () => fsp.link(from.host, to.host), to);
  }},
  symlink: {lock: EXCL, async run(a) {
    const target = String(a[0]);
    const at = await this.place(a[1], 'w', 'symlink', false);
    if (at.res.kind === 'root') {
      const resolved = posix.resolve(posix.dirname(at.virtual), target);
      if (posix.isAbsolute(target) || !inside(resolved, at.res.root.vroot)) throw nodeError('EPERM', 'symlink', target, at.virtual);
    }
    return this.run(at, 'symlink', () => fsp.symlink(target, at.host, a[2]));
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
    return this.run(p, 'open', () => fsp.truncate(p.host, a[1]));
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
    let fh;
    try { fh = await fsp.open(p.host, (n & ~fs.constants.O_TRUNC) | fs.constants.O_NONBLOCK, a[2]); } catch (e) { throw rewrite(e, 'open', p, null, this.ns); }
    await this.verifyOpened(fh, p, 'open', fl.writes);
    // Every open is non-blocking, so a FIFO, socket or device cannot block a
    // pool thread at open; what it turned out to be decides the rest (review I2).
    const st = await fh.stat();
    if (!st.isFile() && !st.isDirectory()) {
      this.report('special', p.virtual);
      if (this.enforce) { await fh.close().catch(() => {}); throw nodeError('EPERM', 'open', p.virtual); }
    }
    if (truncate && st.isFile()) await fh.truncate(0).catch((e) => { throw rewrite(e, 'open', p, null, this.ns); });
    const fd = this.nextFd++;
    this.fds.set(fd, {fh, virtual: p.virtual, placed: p, chain: Promise.resolve()});
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
      return buf.subarray(0, r.bytesRead);
    });
  }},
  write: {lock: NONE, async run(a) {
    const e = this.fdEntry(a[0], 'write');
    const buf = Buffer.from(a[1]);
    if (buf.length > MAX_IO) throw nodeError('EINVAL', 'write', e.virtual);
    return serial(e, async() => {
      const r = await e.fh.write(buf, 0, buf.length, a[2] == null ? null : a[2]).catch((err) => { throw rewrite(err, 'write', e.placed, null, this.ns); });
      return r.bytesWritten;
    });
  }},
  fstat: {lock: NONE, async run(a) {
    const e = this.fdEntry(a[0], 'fstat');
    const big = !!(a[1] && a[1].bigint);
    return serial(e, () => e.fh.stat({bigint: big}).then((s) => statsOut(s, big)));
  }},
  ftruncate: {lock: NONE, async run(a) { const e = this.fdEntry(a[0], 'ftruncate'); return serial(e, () => e.fh.truncate(a[1])); }},
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

module.exports = {FsBroker, OPS, MAX_IO, MAX_FDS};

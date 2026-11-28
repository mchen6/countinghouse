'use strict';

// LM1 B2, Task 3 (plan 2026-11-11-lm1-store-and-identity.md, Review Focus
// 1-3): the local store's persisted maps. Several processes may share one
// --storePath (reviewer's ruling, 2026-11-11): every write takes the store
// lock, re-reads the file, applies this process's dirty keys over it and
// renames a temp file into place, so no file is replaced whole.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn, spawnSync} = require('child_process');
const {openJsonFile, withStoreLock} = require('../../lib/store/json-file');

const ROOT = path.resolve(__dirname, '../..');
const MOD = path.join(ROOT, 'lib', 'store', 'json-file');

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ch-store-04-'));
}

// The announcements in a store (#150): each process's own file, all in its
// name, .lock.waiting.<pid>-<startId>-<since>; its freshness, `at`, the
// file's mtime.
const announcements = (dir) => fs.readdirSync(dir).map((n) => /^\.lock\.waiting\.(\d+)-([tm]\d+)-(\d+)$/.exec(n)).filter((m) => m != null).map((m) => {
  try { return {pid: Number(m[1]), startId: m[2], since: Number(m[3]), at: fs.statSync(path.join(dir, m[0])).mtimeMs}; } catch (e) { return null; }
}).filter((w) => w != null);
const announceAs = (dir, pid, ageMs, startId, since = Date.now() - ageMs) => {
  const file = path.join(dir, `.lock.waiting.${pid}-${startId}-${since}`);
  const at = Date.now() - ageMs;
  fs.writeFileSync(file, '');
  fs.utimesSync(file, at / 1000, at / 1000);
};
// a process's start as an announcement records it: on Linux its start in
// clock ticks since boot (/proc), else a stand-in (only a process's own pid
// is compared there)
const startIdOf = (pid) => {
  if (process.platform !== 'linux') return 'm1';
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return `t${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
};
// a live process, with its startId
async function sleeperProcess() {
  const p = spawn(process.execPath, ['-e', 'process.stdout.write("up"); setTimeout(() => {}, 20000)'], {stdio: ['ignore', 'pipe', 'ignore']});
  await new Promise((resolve) => p.stdout.once('data', resolve));
  return {pid: p.pid, startId: startIdOf(p.pid), kill: () => p.kill()};
}

function child(script) {
  return spawnSync(process.execPath, ['-e', `const {openJsonFile, withStoreLock, flushAllOnExit} = require(${JSON.stringify(MOD)});\n${script}`],
    {cwd: ROOT, encoding: 'utf8', timeout: 30000});
}

describe('store 04: the persisted maps (LM1 B2)', function() {
  this.timeout(60000);

  it('round-trips, and leaves no temp file', () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const a = openJsonFile(file);
    a.set('k', {n: 1});
    a.flush();
    a.close();
    assert.deepStrictEqual(openJsonFile(file).data, {k: {n: 1}});
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  });

  it('writes once for several changes within the debounce', async () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const renames = [];
    const rename = fs.renameSync;
    fs.renameSync = (...a) => { renames.push(a[1]); return rename(...a); };
    try {
      const f = openJsonFile(file, {debounceMs: 100});
      f.set('a', 1);
      f.set('b', 2);
      f.delete('a');
      await new Promise((resolve) => setTimeout(resolve, 300));
      f.close();
    } finally {
      fs.renameSync = rename;
    }
    assert.strictEqual(renames.filter((r) => r === file).length, 1);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {b: 2});
  });

  it('a corrupt file at open: the map starts empty, and it holds no copy, so it never replaces the file (R-store-aside-locked)', () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    fs.writeFileSync(file, '{"half": ');
    const f = openJsonFile(file);
    assert.deepStrictEqual(f.data, {});
    f.close();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"half": ', 'neither moved nor replaced');
    assert.strictEqual(fs.readdirSync(dir).filter((e) => e.startsWith('m.json.corrupt-')).length, 0);
  });

  it('two processes writing disjoint keys to one store end with both sets on disk', async () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const writer = (tag) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['-e', `
        const {openJsonFile} = require(${JSON.stringify(MOD)});
        const f = openJsonFile(${JSON.stringify(file)}, {debounceMs: 1});
        for (let i = 0; i < 200; i++) { f.set('${tag}' + i, i); if (i % 10 === 0) f.flush(); }
        f.flush();
      `], {stdio: ['ignore', 'ignore', 'pipe']});
      let err = '';
      p.stderr.on('data', (c) => { err += c; });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
    await Promise.all([writer('a'), writer('b')]);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(Object.keys(data).length, 400);
  });

  it('a key both processes set ends with the later write, and the other keys stay', () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const a = openJsonFile(file);
    const b = openJsonFile(file);
    a.set('shared', 'a');
    a.set('onlyA', 1);
    a.flush();
    b.set('shared', 'b');
    b.flush();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {shared: 'b', onlyA: 1});
  });

  it('takes over a lock whose process is gone', () => {
    const dir = tmpStore();
    fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({pid: 999999, startMs: 1}));
    const f = openJsonFile(path.join(dir, 'm.json'));
    f.set('k', 1);
    f.flush();
    assert.strictEqual(fs.existsSync(path.join(dir, '.lock')), false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'm.json'), 'utf8')), {k: 1});
  });

  it('waits for a lock another process holds, then writes', async () => {
    const dir = tmpStore();
    const holder = spawn(process.execPath, ['-e', `
      const {withStoreLock} = require(${JSON.stringify(MOD)});
      withStoreLock(${JSON.stringify(dir)}, () => { process.stdout.write('held\\n'); const t = Date.now(); while (Date.now() - t < 400) {} });
    `], {stdio: ['ignore', 'pipe', 'inherit']});
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    const f = openJsonFile(path.join(dir, 'm.json'));
    f.set('k', 1);
    const started = Date.now();
    f.flush();
    assert.ok(Date.now() - started >= 100, 'the flush waited for the lock');
    await new Promise((resolve) => holder.on('exit', resolve));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'm.json'), 'utf8')), {k: 1});
  });

  // On Windows a kill ends the process at once, with no handler run, so the
  // last unflushed writes are lost there (docs/deployment.md, "Local mode");
  // the clean stop below is what flushes on every system.
  (process.platform === 'win32' ? it.skip : it)('flushes on SIGTERM (POSIX)', async () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const p = spawn(process.execPath, ['-e', `
      const {openJsonFile, flushAllOnExit} = require(${JSON.stringify(MOD)});
      flushAllOnExit();
      const f = openJsonFile(${JSON.stringify(file)}, {debounceMs: 60000});
      f.set('k', 'kept');
      process.stdout.write('set\\n');
      setInterval(() => {}, 1000);
    `], {stdio: ['ignore', 'pipe', 'inherit']});
    await new Promise((resolve) => p.stdout.once('data', resolve));
    p.kill('SIGTERM');
    await new Promise((resolve) => p.on('exit', resolve));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {k: 'kept'});
  });

  it('flushes when the process ends on its own (a --stdio server\'s stop when stdin closes)', async () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const p = spawn(process.execPath, ['-e', `
      const {openJsonFile, flushAllOnExit} = require(${JSON.stringify(MOD)});
      flushAllOnExit();
      const f = openJsonFile(${JSON.stringify(file)}, {debounceMs: 60000});
      f.set('k', 'kept');
      process.stdin.on('end', () => process.exit(0));
      process.stdin.resume();
      process.stdout.write('set\\n');
    `], {stdio: ['pipe', 'pipe', 'inherit']});
    await new Promise((resolve) => p.stdout.once('data', resolve));
    p.stdin.end();
    assert.strictEqual(await new Promise((resolve) => p.on('exit', resolve)), 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {k: 'kept'});
  });

  it('writes the files and the store directory for the owner only', () => {
    if (process.platform === 'win32') return;
    const dir = path.join(tmpStore(), 'store');
    const f = openJsonFile(path.join(dir, 'm.json'));
    f.set('k', 1);
    f.flush();
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(dir, 'm.json')).mode & 0o777, 0o600);
  });

  it('withStoreLock runs its function and removes the lock', () => {
    const dir = tmpStore();
    assert.strictEqual(withStoreLock(dir, () => 42), 42);
    assert.strictEqual(fs.existsSync(path.join(dir, '.lock')), false);
    void child;
  });
});

// The review of fa3e93f (B2): the lock's takeover and staleness, the event
// loop never blocked by a busy lock, a failed write retried, a corrupt file
// found while writing, and update() for read-modify-write across processes.
describe('store 04: the review of B2', function() {
  this.timeout(60000);

  it('takes over a lock carrying this pid from an earlier start', () => {
    const dir = tmpStore();
    fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({pid: process.pid, startMs: 1, at: Date.now()}));
    const f = openJsonFile(path.join(dir, 'm.json'));
    f.set('k', 1);
    f.flush();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'm.json'), 'utf8')), {k: 1});
  });

  // A lock is stale when its holder's process is gone, or when no holder is
  // readable after STALE_MS (one still being written): never by its age
  // alone, so a live writer held up past it (a slow fsync on a loaded
  // machine, a debugger, a long GC pause) never has its lock taken while it
  // writes, and two processes never write the file at once.
  it('takes over an empty lock older than a write can take, and a dead pid\'s lock', () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {encoding: 'utf8'});
    for (const content of ['', JSON.stringify({pid: Number(dead.stdout), startMs: 1, at: Date.now()})]) {
      const dir = tmpStore();
      const lock = path.join(dir, '.lock');
      fs.writeFileSync(lock, content);
      const old = (Date.now() - 60000) / 1000;
      fs.utimesSync(lock, old, old);
      const f = openJsonFile(path.join(dir, 'm.json'));
      f.set('k', 1);
      f.flush();
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'm.json'), 'utf8')), {k: 1}, `lock ${JSON.stringify(content)}`);
    }
  });

  // A live holder's lock is taken over only past LIVE_STALE_MS (120 s), which
  // no write reaches: a slow live writer keeps it, a hung one cannot stop
  // the store's writes for good.
  it('a live process\'s lock is not taken at 30 s old; at 121 s it is', async () => {
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {stdio: 'ignore'});
    try {
      for (const [ageS, taken] of [[30, false], [121, true]]) {
        const dir = tmpStore();
        const lock = path.join(dir, '.lock');
        const held = JSON.stringify({pid: live.pid, startMs: 1, at: Date.now() - ageS * 1000});
        fs.writeFileSync(lock, held);
        const f = openJsonFile(path.join(dir, 'm.json'));
        f.set('k', 1);
        f.flush(); // a busy lock: waits LOCK_WAIT_MS, then warns and reschedules
        if (taken) {
          assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'm.json'), 'utf8')), {k: 1}, `${ageS} s: taken over and written`);
        } else {
          assert.strictEqual(fs.readFileSync(lock, 'utf8'), held, `${ageS} s: the live holder's lock is still its own`);
          assert.ok(!fs.existsSync(path.join(dir, 'm.json')), `${ageS} s: nothing was written while it held the lock`);
          // released, so the close's flush does not wait the whole wait again
          fs.unlinkSync(lock);
        }
        f.close();
      }
    } finally {
      live.kill('SIGKILL');
    }
  });

  function holdLock(dir, ms) {
    const holder = spawn(process.execPath, ['-e', `
      const {withStoreLock} = require(${JSON.stringify(MOD)});
      withStoreLock(${JSON.stringify(dir)}, () => { process.stdout.write('held\\n'); const t = Date.now(); while (Date.now() - t < ${ms}) {} });
    `], {stdio: ['ignore', 'pipe', 'inherit']});
    return new Promise((resolve) => holder.stdout.once('data', () => resolve(holder)));
  }
  async function eventually(check, ms = 5000) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (check()) return true; await new Promise((resolve) => setTimeout(resolve, 25)); }
    return false;
  }

  it('a scheduled write does not block the event loop while another process holds the lock, and lands after', async () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const holder = await holdLock(dir, 800);
    const f = openJsonFile(file, {debounceMs: 10});
    f.set('k', 'late');
    let ticks = 0;
    const tick = setInterval(() => { ticks++; }, 10);
    await new Promise((resolve) => setTimeout(resolve, 500));
    clearInterval(tick);
    assert.ok(ticks >= 25, `the event loop ran ${ticks} ticks in 500 ms`);
    await new Promise((resolve) => holder.on('exit', resolve));
    assert.ok(await eventually(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).k === 'late'), 'written after the lock was free');
    f.close();
  });

  it('a write that failed is retried without another change', async () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const holder = await holdLock(dir, 2600);
    const f = openJsonFile(file, {debounceMs: 10});
    f.set('k', 'retried');
    await new Promise((resolve) => holder.on('exit', resolve));
    assert.ok(await eventually(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).k === 'retried'), 'retried');
    f.close();
  });

  it('a file found corrupt while writing is rewritten from this process\'s whole map', () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const f = openJsonFile(file);
    f.set('a', 1); f.set('b', 2); f.set('c', 3);
    f.flush();
    fs.writeFileSync(file, '{"broken": ');
    f.set('d', 4);
    f.flush();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {a: 1, b: 2, c: 3, d: 4});
  });

  it('update() is a read-modify-write under the lock: two processes counting one key lose nothing', async () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const counter = () => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['-e', `
        const {openJsonFile} = require(${JSON.stringify(MOD)});
        const f = openJsonFile(${JSON.stringify(file)});
        let n = 0;
        const next = () => f.update('n', (v) => (v || 0) + 1, (err) => {
          if (err) { process.stderr.write(err.message); process.exit(1); }
          if (++n < 100) return next();
          f.close();
        });
        next();
      `], {stdio: ['ignore', 'ignore', 'pipe']});
      let err = '';
      p.stderr.on('data', (c) => { err += c; });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
    await Promise.all([counter(), counter()]);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).n, 200);
  });

  // Windows: a file being deleted while a handle is open on it (delete
  // pending) refuses opens with EPERM until the handle closes. A lock in that
  // state is busy, not an error; one still refused at the deadline fails with
  // EPERM and the lock's path, as a genuine permission error would (the
  // reviewer's rule: retry only under the deadline, keep the code).
  const winIt = process.platform === 'win32' ? it : it.skip;
  // The lock under `dir` held in delete pending: -> close(), or null where
  // this Windows removes an open file's name at once (POSIX delete
  // semantics), so delete pending cannot be made here.
  function deletePendingLock(dir) {
    const lock = path.join(dir, '.lock');
    const fd = fs.openSync(lock, 'w');
    fs.unlinkSync(lock);
    try {
      fs.writeFileSync(lock, 'probe', {flag: 'wx'});
    } catch (e) {
      if (e.code === 'EPERM') return () => fs.closeSync(fd);
      fs.closeSync(fd);
      throw e;
    }
    fs.unlinkSync(lock);
    fs.closeSync(fd);
    return null;
  }

  winIt('update() waits while the lock is being deleted, then writes (Windows)', async function() {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const close = deletePendingLock(dir);
    if (close == null) return this.skip();   // POSIX delete semantics here: no delete pending to wait on
    const f = openJsonFile(file);
    setTimeout(close, 300);
    const value = await new Promise((resolve, reject) => f.update('n', (v) => (v || 0) + 1, (err, v) => (err ? reject(err) : resolve(v))));
    assert.strictEqual(value, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).n, 1);
    f.close();
  });

  winIt('a lock still refused at the deadline fails with EPERM and the lock\'s path, within the deadline (Windows)', function() {
    const dir = tmpStore();
    const close = deletePendingLock(dir);
    if (close == null) return this.skip();   // POSIX delete semantics here: no refusal to hold
    const started = Date.now();
    try {
      assert.throws(() => withStoreLock(dir, () => 'ran'), (e) => {
        assert.strictEqual(e.code, 'EPERM');
        assert.ok(e.message.includes(path.join(dir, '.lock')), e.message);
        return true;
      });
      const took = Date.now() - started;
      assert.ok(took >= 1900 && took < 4000, `failed after ${took} ms (the wait is 2000 ms)`);
    } finally {
      close();
    }
  });

  it('reload() sees what another process wrote', () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const a = openJsonFile(file);
    const b = openJsonFile(file);
    b.set('k', 'from b');
    b.flush();
    assert.strictEqual(a.data.k, undefined);
    a.reload();
    assert.strictEqual(a.data.k, 'from b');
  });
});

// #150: a process that takes the lock again the moment it releases it
// starved one waiting with a 10 ms retry past LOCK_WAIT_MS (seen on Windows
// CI). A waiter announces itself, and the others yield to it, so once it
// has announced the other process takes the lock at most once more before
// the waiter has it (measured in holds, not the wall clock: below).
describe('store 04: a waiter is not starved (#150)', function() {
  this.timeout(60000);

  // Windows refuses a rename onto a file another process has open (or is
  // deleting), and a busy store's announcement is read on every attempt: an
  // announcement made by renaming over the file could then never land, and
  // nothing kept the waiter's turn (store 04's hammer starved on Windows CI).
  // Here a rename onto an existing file fails as it can on Windows, an old
  // announcement is already there, and the waiter's must land anyway.
  it('a waiter\'s announcement lands even where a rename onto an existing file fails, as on Windows', async () => {
    const dir = tmpStore();
    const sleeper = await sleeperProcess();
    // (a file at the name one shared announcement once had: a rename onto it fails here, as on Windows)
    fs.writeFileSync(path.join(dir, '.lock.waiting'), JSON.stringify({pid: sleeper.pid, startMs: 1, at: Date.now() - 60000}));
    announceAs(dir, sleeper.pid, 60000, sleeper.startId);
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('fs'); const path = require('path');
      const {withStoreLock} = require(${JSON.stringify(MOD)});
      const dir = ${JSON.stringify(dir)};
      // (an announcement, never a temporary file one is written to first)
      const mine = (name) => name.startsWith('.lock.waiting.' + process.argv[1] + '-');
      withStoreLock(dir, () => {
        process.stdout.write('held\\n');
        let seen = false;
        const t = Date.now() + 1200;
        while (Date.now() < t && !seen) seen = fs.readdirSync(dir).some((n) => n.startsWith('.lock.waiting') && !n.endsWith('.tmp') && mine(n));
        process.stdout.write(seen ? 'seen' : 'not seen');
      });
    `, String(process.pid)], {stdio: ['ignore', 'pipe', 'ignore']});
    let out = '';
    holder.stdout.on('data', (c) => { out += c; });
    const rename = fs.renameSync;
    try {
      // (bounded: the holder says it holds the lock, or the case fails here)
      await new Promise((resolve, reject) => {
        const until = Date.now() + 10000;
        const check = () => (out.includes('held') ? resolve() : (Date.now() > until ? reject(new Error(`the holder never held the lock (${out})`)) : setTimeout(check, 10)));
        check();
      });
      fs.renameSync = function(from, to) {
        if (fs.existsSync(to)) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), {code: 'EPERM'});
        return rename.apply(this, arguments);
      };
      withStoreLock(dir, () => {});
    } finally {
      fs.renameSync = rename;
      sleeper.kill();
      if (holder.exitCode == null) setTimeout(() => holder.kill(), 5000).unref();
    }
    // (its exit may already have come while this process waited)
    await new Promise((resolve) => (holder.exitCode != null ? resolve() : holder.on('exit', resolve)));
    assert.ok(out.endsWith('seen') && !out.endsWith('not seen'), `the waiter's announcement never landed (${out.trim()})`);
  });

  // The mechanism, deterministically: an announced waiter is yielded to.
  it('a fresh announcement by another live waiter is yielded to; a dead or old one is not', async () => {
    const dir = tmpStore();
    const sleeper = await sleeperProcess();
    try {
      const announce = (pid, ageMs, startId = sleeper.startId) => announceAs(dir, pid, ageMs, startId);
      // a live waiter renewed 3 s ago: yielded to until it is 4 s old
      announce(sleeper.pid, 3000);
      const t = Date.now();
      withStoreLock(dir, () => {});
      assert.strictEqual(withStoreLock.waited, true, 'did not yield');
      assert.ok(Date.now() - t >= 200, `yielded only ${Date.now() - t} ms`);
      // a dead one, and an old one, are not
      const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {encoding: 'utf8'});
      announce(Number(gone.stdout), 0, 'm1');
      withStoreLock(dir, () => {});
      assert.strictEqual(withStoreLock.waited, false, 'yielded to a dead waiter');
      announce(sleeper.pid, 6000);
      withStoreLock(dir, () => {});
      assert.strictEqual(withStoreLock.waited, false, 'yielded to an old announcement');
      // one dated in the future (a clock stepped back since): not fresh
      announce(sleeper.pid, -60000);
      withStoreLock(dir, () => {});
      assert.strictEqual(withStoreLock.waited, false, 'yielded to an announcement from the future');
    } finally {
      sleeper.kill();
    }
  });

  // Windows (and every system) reuses pids: a new process given a dead
  // waiter's pid is not that waiter. Where its start can be read (Linux),
  // one whose start differs from the announcement's is dead: its file goes,
  // and it is not yielded to; elsewhere it is left, and yielded to only
  // while fresh, as a live one.
  (process.platform === 'linux' ? it : it.skip)('a live process announced with another start time (a reused pid) is dead: its file is removed, never yielded to', async () => {
    const dir = tmpStore();
    const sleeper = await sleeperProcess();
    try {
      announceAs(dir, sleeper.pid, 0, `t${Number(sleeper.startId.slice(1)) - 100}`);
      withStoreLock(dir, () => {});
      assert.strictEqual(withStoreLock.waited, false, 'yielded to a reused pid');
      assert.deepStrictEqual(announcements(dir), [], 'its file was left');
      // (its own start: alive, yielded to while fresh, its file kept; renewed 3 s ago, so yielded to for about 1 s of the 2 s wait)
      announceAs(dir, sleeper.pid, 3000, sleeper.startId);
      withStoreLock(dir, () => {});
      assert.strictEqual(withStoreLock.waited, true, 'did not yield to a live waiter');
      assert.strictEqual(announcements(dir).length, 1, 'a live process\'s file was removed');
    } finally {
      sleeper.kill();
    }
  });

  it('a dead process\'s announcement goes (its pid and start are in its name); this process\'s own pid with another start is dead too', () => {
    const dir = tmpStore();
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {encoding: 'utf8'});
    announceAs(dir, Number(gone.stdout), 0, 'm1');
    // (this process's pid, recorded by an earlier process given it: another start)
    announceAs(dir, process.pid, 0, process.platform === 'linux' ? 't1' : 'm1');
    withStoreLock(dir, () => {});
    assert.strictEqual(withStoreLock.waited, false, 'yielded to a dead announcement');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.lock.waiting.')), [], 'a dead announcement was left');
  });

  it('update()\'s failure says what its last attempt found too', () => {
    const {busyError} = require(MOD);
    const dir = tmpStore();
    const err = busyError({busy: true, refused: null, yieldedTo: 4242, heldBy: null}, dir, `the store lock under ${dir} stayed busy for 10000 ms`, 10000);
    assert.strictEqual(err.message, `the store lock under ${dir} stayed busy for 10000 ms (it yielded to a waiting process (pid 4242))`);
  });

  it('a waiter announces itself while the lock is busy, and withdraws once it has the lock', async () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const holder = spawn(process.execPath, ['-e', `
      const {withStoreLock} = require(${JSON.stringify(MOD)});
      withStoreLock(${JSON.stringify(dir)}, () => { process.stdout.write('held'); const t = Date.now() + 400; while (Date.now() < t) { /* hold */ } });
    `], {stdio: ['ignore', 'pipe', 'ignore']});
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    const f = openJsonFile(file);
    let seen = null;
    const probe = setInterval(() => {
      seen = seen || announcements(dir).find((w) => w.pid === process.pid) || null;
    }, 20);
    await new Promise((resolve, reject) => f.update('k', () => 1, (err) => (err ? reject(err) : resolve())));
    clearInterval(probe);
    f.close();
    assert.ok(seen != null && seen.pid === process.pid, `no announcement seen: ${JSON.stringify(seen)}`);
    assert.deepStrictEqual(announcements(dir).filter((w) => w.pid === process.pid), [], 'the announcement was left behind');
  });

  // the review of #160: an announcement is withdrawn on every way out of a
  // wait, a throw included; a wait that ends yielding says so
  it('a wait that throws withdraws its announcement', async () => {
    const dir = tmpStore();
    const holder = spawn(process.execPath, ['-e', `
      const {withStoreLock} = require(${JSON.stringify(MOD)});
      withStoreLock(${JSON.stringify(dir)}, () => { process.stdout.write('held'); const t = Date.now() + 300; while (Date.now() < t) { /* hold */ } });
    `], {stdio: ['ignore', 'pipe', 'ignore']});
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    let calls = 0;
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = function(file, ...rest) {
      // the second attempt at the lock file fails with an I/O error
      if (String(file).endsWith(`${path.sep}.lock`) && ++calls === 2) throw Object.assign(new Error('EIO: i/o error'), {code: 'EIO'});
      return realWrite.call(this, file, ...rest);
    };
    try {
      assert.throws(() => withStoreLock(dir, () => {}), /EIO/);
    } finally {
      fs.writeFileSync = realWrite;
    }
    assert.deepStrictEqual(announcements(dir).filter((w) => w.pid === process.pid), [], 'the announcement was left behind');
    await new Promise((resolve) => holder.on('exit', resolve));
  });

  // The message a wait ends with, decided where the wait ends (busyError),
  // with no wait and no renewing: a fresh announcement by a live process
  // and no lock held is a yield, named by the waiter's pid. (A wait of
  // LOCK_WAIT_MS against an announcement a child kept renewing depended on
  // the renewal's timing, and on Windows a rename over the file while it
  // is read can fail: flaky on #165's CI.)
  // The failure a wait ends with says what its last attempt found, never a
  // state read again afterwards (store 04's hammer on Windows CI threw "held
  // by pid unknown" after a wait it had spent yielding: by then the waiter
  // had the lock and had withdrawn).
  it('a wait\'s failure names what its last attempt found: the waiter it yielded to, or the lock\'s holder', () => {
    const {busyError} = require(MOD);
    const dir = tmpStore();
    // (nothing in the store any more: no lock, no announcement)
    assert.match(busyError({busy: true, refused: null, yieldedTo: 4242, heldBy: null}, dir).message, /yielded to a waiting process \(pid 4242\)/);
    assert.match(busyError({busy: true, refused: null, yieldedTo: null, heldBy: 4343}, dir).message, /held by pid 4343/);
  });

  it('a wait that ends yielding to a waiter names the waiter, not a holder', async () => {
    const {busyError} = require(MOD);
    const dir = tmpStore();
    const sleeper = await sleeperProcess();
    try {
      announceAs(dir, sleeper.pid, 0, sleeper.startId);
      const err = busyError({busy: true, refused: null}, dir);
      assert.ok(err.message.includes(String(sleeper.pid)), err.message);
      assert.doesNotMatch(err.message, /held by pid unknown/);
    } finally {
      sleeper.kill();
    }
  });

  // Fairness, measured in the other process's holds, never the wall clock:
  // a loaded runner stalls both processes alike (CI took 13 s for a 3 s
  // hammer, and an update that succeeded took 2697 ms with the yield
  // working), and a late retry timer lets a hammer whose own announcement
  // the waiter yielded to take the lock freely until the waiter's next
  // attempt, as designed. What the announcement promises is load-free: once
  // the waiter has announced (its own announcement file created), the other
  // process begins at most one more hold -- one already past its yield
  // check -- before the waiter has the lock. The hammer logs when each hold
  // begins, the waiter when it announced and when it got the lock (inside
  // fn), on one monotonic timeline; at most 3 holds (slack for the clock's
  // resolution) may begin in between. With the yield disabled an update
  // waited through 177 and 190 holds of its whole wait.
  it('two processes hammering one key both finish, and once a waiter has announced the other takes the lock at most once more', async () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const run = (script) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['-e', `const {openJsonFile, withStoreLock} = require(${JSON.stringify(MOD)});
        const {performance: perfHooks} = require('perf_hooks');
        const monotonic = () => perfHooks.timeOrigin + perfHooks.now();\n${script}`],
        {stdio: ['ignore', 'pipe', 'pipe']});
      let out = '';
      let err = '';
      p.stdout.on('data', (c) => { out += c; });
      p.stderr.on('data', (c) => { err += c; });
      p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
    });
    // takes the lock again at once, each time holding it about 2 ms, and
    // logs when each hold begins; a wait that ends yielding to a stalled
    // waiter (its announcement still fresh) is counted, not a failure
    const hammer = run(`
      const end = Date.now() + 3000;
      const holds = [];
      let yielded = 0;
      while (Date.now() < end) {
        try {
          withStoreLock(${JSON.stringify(dir)}, () => { holds.push(monotonic()); const t = Date.now() + 2; while (Date.now() < t) { /* hold */ } });
        } catch (e) {
          if (!/yielded to a waiting process/.test(e.message)) throw e;
          yielded++;
        }
      }
      process.stdout.write(JSON.stringify({holds, yielded}));
    `);
    // counts one key with update(), logging when it announced (if it had to)
    // and when it got the lock
    const waiter = run(`
      const fs = require('fs');
      let announced = null;
      // (the moment it announced: its own announcement file created, exclusively)
      const write = fs.writeFileSync;
      fs.writeFileSync = function(file, data, opts) {
        const r = write.apply(this, arguments);
        if (String(file).includes('.lock.waiting.') && opts != null && opts.flag === 'wx' && announced == null) announced = monotonic();
        return r;
      };
      const f = openJsonFile(${JSON.stringify(file)});
      const waits = [];
      const next = () => {
        announced = null;
        let got = null;
        f.update('n', (v) => { got = monotonic(); return (v || 0) + 1; }, (err) => {
          if (err) { process.stderr.write(err.message); process.exit(1); }
          waits.push({announced, got});
          if (waits.length < 40) return next();
          f.close();
          process.stdout.write(JSON.stringify(waits));
        });
      };
      setTimeout(next, 100);
    `);
    const [{holds}, waits] = (await Promise.all([hammer, waiter])).map((out) => JSON.parse(out));
    assert.ok(holds.length > 0, 'the hammer never took the lock');
    // (the two contended: some updates had to announce, so the yield was tested)
    const contended = waits.filter((w) => w.announced != null);
    assert.ok(contended.length > 0, `no update had to announce (${holds.length} holds): nothing was tested`);
    const after = contended.map((w) => holds.filter((h) => h >= w.announced && h < w.got).length);
    assert.ok(Math.max(...after) <= 3, `once announced, an update waited through ${Math.max(...after)} of the other process's holds (${JSON.stringify(after)})`);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).n, 40);
  });
});

// B-storelock: the lock is fair under load (a waiter's longest wait was one
// hold of the other process's, on a loaded Windows runner), but a hold is a
// write and its fsync, and there a hold reached 1.1 s under a disk and CPU
// load; on CI, past update()'s old 2 s, failing a metering charge. update()
// outlasts a live holder's slow hold, and its announcement stays fresh while
// it waits. The holder holds until it is told to let go (a file), so the
// waiter has waited past the old 2 s on every runner: no wall-clock
// assertion, only a bound on what is observable.
describe('store 04: update() outlasts a live holder\'s slow hold (B-storelock)', function() {
  this.timeout(60000);
  const PAST_OLD_WAIT_MS = 2500;
  const children = [];
  after(() => { for (const c of children) if (c.exitCode == null) c.kill(); });
  // a live process holding the lock until <dir>/let-go exists (20 s at
  // most) -> Promise of the child once it holds; rejects if it exits first
  const slowHolder = (dir) => {
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const {withStoreLock} = require(${JSON.stringify(MOD)});
      withStoreLock(${JSON.stringify(dir)}, () => {
        process.stdout.write('held');
        const end = Date.now() + 20000;
        while (Date.now() < end && !fs.existsSync(${JSON.stringify(path.join(dir, 'let-go'))})) { /* a slow write */ }
        fs.writeFileSync(${JSON.stringify(path.join(dir, 'held-until'))}, 'released');
      });
    `], {stdio: ['ignore', 'pipe', 'pipe']});
    children.push(holder);
    let err = '';
    holder.stderr.on('data', (c) => { err += c; });
    return new Promise((resolve, reject) => {
      holder.stdout.once('data', () => resolve(holder));
      holder.once('exit', (code) => reject(new Error(`the holder exited (${code}) before it held the lock: ${err}`)));
    });
  };
  const exited = (p) => new Promise((resolve) => (p.exitCode != null ? resolve() : p.once('exit', resolve)));
  const announcement = (dir) => announcements(dir)[0] || null;
  // until check() holds, polling (bounded)
  async function until(check, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (check()) return true; await new Promise((resolve) => setTimeout(resolve, 20)); }
    return false;
  }

  it('waits past the old 2 s for it, then writes; its announcement stays fresh while it waits', async () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    const holder = await slowHolder(dir);
    const f = openJsonFile(file);
    let ranAfterHold = null;
    const done = new Promise((resolve, reject) => f.update('n', (v) => {
      ranAfterHold = fs.existsSync(path.join(dir, 'held-until'));
      return (v || 0) + 1;
    }, (err, v) => (err ? reject(err) : resolve(v))));
    try {
      assert.ok(await until(() => announcement(dir) != null, 5000), 'the waiter never announced');
      // the waiter waits on; past the old wait, and past an announcement's
      // own freshness (2 s), it has renewed it: another process still yields
      await new Promise((resolve) => setTimeout(resolve, PAST_OLD_WAIT_MS));
      const w = announcement(dir);
      assert.ok(w != null && w.pid === process.pid, `the announcement: ${JSON.stringify(w)}`);
      assert.ok(Date.now() - w.at < 2000, `the announcement is ${Date.now() - w.at} ms old: no longer yielded to`);
      fs.writeFileSync(path.join(dir, 'let-go'), '');
      assert.strictEqual(await done, 1);
      assert.strictEqual(ranAfterHold, true, 'update() ran while the lock was held');
      assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).n, 1);
      assert.strictEqual(announcement(dir), null, 'the announcement was withdrawn');
    } finally {
      fs.writeFileSync(path.join(dir, 'let-go'), '');
      f.close();
      await exited(holder);
    }
  });
});

// R-win-ledger-rename: a write renames a new file into place, and on Windows
// a rename over a file another process has open can be refused. The store's
// files are read without the lock (an openJsonFile, a reload(): a balance
// asked for, another runtime starting), so a reader must never cost a write:
// update() is a metering charge's, and a charge it answers with an error is
// not made again.
const openDirs = require('../helpers/test-tmp').forFile(['ch-store-04-open-']);

// a process running `script`, its first line of output awaited (it is then
// doing what the test needs it to), for 30 s at most; ended with its input,
// killed otherwise -- on every path, the failed wait for its first line
// included (it starts nothing of its own: the process is all there is)
async function reader(script) {
  const child = spawn(process.execPath, ['-e', script], {stdio: ['pipe', 'pipe', 'inherit']});
  let out = '';
  child.stdout.setEncoding('utf8');
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({code, signal})));
  let bound = null;
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(); });
    exited.then((e) => reject(new Error(`the reader ended first: ${JSON.stringify(e)}`)));
    bound = setTimeout(() => reject(new Error(`the reader said nothing in 30 s (${JSON.stringify(out)})`)), 30000);
  });
  child.stdin.on('error', () => undefined);
  try {
    await ready;
  } catch (e) {
    child.kill('SIGKILL');
    await exited;
    throw e;
  } finally {
    clearTimeout(bound);
  }
  return {
    end: () => { child.stdin.end(); return exited; },
    kill: () => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); return exited; },
    said: () => out
  };
}
const update = (f, key, fn) => new Promise((resolve) => f.update(key, fn, (err, value) => resolve({err, value})));
const add = (v) => ({n: ((v != null && v.n) || 0) + 1});
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('store 04: a reader never costs a write (R-win-ledger-rename)', function() {
  this.timeout(120000);
  const winIt = process.platform === 'win32' ? it : it.skip;
  let file = null;
  let f = null;
  let r = null;
  beforeEach(() => {
    file = path.join(openDirs.mkdtemp('ch-store-04-open-'), 'm.json');
    f = openJsonFile(file);
    f.set('k', {n: 0});
    f.flush();
  });
  afterEach(async () => {
    if (r != null) { await r.kill(); r = null; }
    f.close();
  });

  // The file held open by another process while the change is made, until
  // the test ends its input. On Windows the rename meets the open handle
  // and is refused: update() must try it again without blocking (the test
  // ends the reader's input while the change waits), and make it once the
  // handle is closed. Elsewhere the change is made at once.
  it('a change made while another process has the file open is not refused', async () => {
    r = await reader(`
      const fd = require('fs').openSync(${JSON.stringify(file)}, 'r');
      process.stdout.write('open\\n');
      process.stdin.resume();
      process.stdin.once('end', () => { require('fs').closeSync(fd); });
    `);
    const done = update(f, 'k', add);
    assert.deepStrictEqual(await r.end(), {code: 0, signal: null});
    const {err, value} = await done;
    assert.ok(err == null, `the change was refused: ${err != null ? `${err.code} ${err.message}` : ''}`);
    assert.deepStrictEqual(value, {n: 1});
    assert.deepStrictEqual(onDisk(file), {k: {n: 1}}, 'made once');
  });

  // As it happens: another process reading again and again, whatever the
  // moment. It says how many reads it had made when it was ready and how
  // many when its input ended (before reading on), so the test sees reads
  // made while the changes were; its own refused reads are counted by code
  // and said too (a reader refused costs no write: told, not failed).
  it('every change lands once while another process reads the file again and again', async function() {
    // (each change gives up at update()'s own deadline, UPDATE_WAIT_MS in
    // lib/store/json-file.js, and the loop stops at the first that does: so
    // at most that wait for each change, and a margin for the reader)
    const changes = 50;
    const UPDATE_WAIT_MS = 10000;
    this.timeout(changes * UPDATE_WAIT_MS + 30000);
    r = await reader(`
      const fs = require('fs');
      let stop = false;
      let ready = false;
      let n = 0;
      const refused = {};
      process.stdin.resume();
      process.stdin.once('end', () => { stop = true; });
      const once = () => {
        if (stop) return process.stdout.write(\`read \${n} refused \${JSON.stringify(refused)}\\n\`);
        for (let i = 0; i < 20; i++) {
          try { JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8')); n += 1; } catch (e) { if (e.code == null) throw e; refused[e.code] = (refused[e.code] || 0) + 1; }
        }
        if (!ready && n > 0) { ready = true; process.stdout.write(\`reading \${n}\\n\`); }
        return setImmediate(once);
      };
      once();
    `);
    // each rename the store makes, and each one refused (and so tried
    // again, or failed): said, so a reader of the log can tell the changes
    // met the reader's reads (none elsewhere than Windows)
    const rename = fs.renameSync;
    const renames = {made: 0, refused: 0};
    fs.renameSync = function(...a) {
      try { const out = rename.apply(this, a); renames.made += 1; return out; } catch (e) { renames.refused += 1; throw e; }
    };
    const failed = [];
    try {
      for (let i = 0; i < changes && failed.length === 0; i++) {
        const {err} = await update(f, 'k', add);
        if (err != null) failed.push(`${err.code} ${err.message}`);
      }
    } finally {
      fs.renameSync = rename;
    }
    process.stdout.write(`      (${renames.refused} renames refused, ${renames.made} made)\n`);
    assert.deepStrictEqual(await r.end(), {code: 0, signal: null});
    const atReady = Number((/reading (\d+)/.exec(r.said()) || [])[1]);
    const atEnd = Number((/read (\d+) refused/.exec(r.said()) || [])[1]);
    const refused = (/refused (\{.*\})/.exec(r.said()) || [])[1];
    if (refused !== '{}') process.stdout.write(`      (the reader's own reads refused: ${refused})\n`);
    assert.ok(atEnd > atReady, `the reader read on while the changes were made (${r.said()})`);
    assert.deepStrictEqual(failed, [], `a change refused (the reader: ${r.said()})`);
    assert.deepStrictEqual(onDisk(file), {k: {n: changes}});
  });

  // (Windows) a handle never closed: the refused rename is tried again until
  // update()'s deadline, then the change fails with the refusal's code, the
  // store's file named and the wait said, the file as it was and no new file
  // left beside it -- told to its caller, never lost silently
  winIt('a rename still refused at update()\'s deadline fails the change with its code and the wait, the file as it was (Windows)', async () => {
    r = await reader(`
      const fd = require('fs').openSync(${JSON.stringify(file)}, 'r');
      process.stdout.write('open\\n');
      process.stdin.resume();
      process.stdin.once('end', () => { require('fs').closeSync(fd); });
    `);
    const {err} = await update(f, 'k', add);
    assert.deepStrictEqual(await r.end(), {code: 0, signal: null});
    assert.ok(err != null && (err.code === 'EPERM' || err.code === 'EBUSY'), `refused with its code: ${err != null ? `${err.code} ${err.message}` : 'no error'}`);
    assert.strictEqual(err.path, file, 'the store\'s file named, not the new one');
    assert.match(err.message, /still refused at update\(\)'s deadline, 10000 ms/);
    assert.deepStrictEqual(onDisk(file), {k: {n: 0}}, 'the file as it was');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((e) => e.includes('.tmp-')), [], 'no new file left');
  });

  openDirs.hooks();
});

// R-exit-flush-refused: flush() (close, the exit flush) is synchronous, and
// on Windows its rename is refused while another process has the file open
// (a reader without the lock). It was rescheduled, and at exit that write was
// lost (local-kv's kv.json: modules' data, task tombstones, asks). It tries a
// refused rename again within its one wait (LOCK_WAIT_MS: the lock's and the
// rename's together), the lock released between attempts.
const flushDirs = require('../helpers/test-tmp').forFile(['ch-store-04-flush-']);

describe('store 04: a flush outlasts a reader holding the file (R-exit-flush-refused)', function() {
  this.timeout(60000);
  const winIt = process.platform === 'win32' ? it : it.skip;
  let file = null;
  let f = null;
  let r = null;
  beforeEach(() => {
    file = path.join(flushDirs.mkdtemp('ch-store-04-flush-'), 'kv.json');
    f = openJsonFile(file, {debounceMs: 60000});
    f.set('k', {n: 0});
    f.flush();
  });
  afterEach(async () => {
    if (r != null) { await r.kill(); r = null; }
    f.close();
  });

  // The other process closes its handle on its own (the flush blocks this
  // process, so the test can't tell it to), once it has seen the new file
  // appear a second time: a second attempt, which only a refused rename
  // makes, so the flush is trying again when the handle closes (Windows).
  // Elsewhere the rename is never refused, and the flush writes at once.
  it('a flush while another process has the file open, closing it once the flush tries again, has written the change when it returns', async () => {
    r = await reader(`
      const fs = require('fs');
      const fd = fs.openSync(${JSON.stringify(file)}, 'r');
      let closed = false;
      const close = () => { if (!closed) { closed = true; fs.closeSync(fd); } };
      process.stdout.write('open\\n');
      process.stdin.resume();
      process.stdin.once('end', close);
      const dir = ${JSON.stringify(path.dirname(file))};
      const tmp = ${JSON.stringify(`${path.basename(file)}.tmp-`)};
      let was = false;
      let seen = 0;
      const watch = () => {
        if (closed) return;
        const is = fs.readdirSync(dir).some((e) => e.startsWith(tmp));
        if (is && !was) seen += 1;
        was = is;
        if (seen >= 2) return close();
        setImmediate(watch);
      };
      watch();
    `);
    f.set('k', {n: 1});
    f.flush();
    assert.deepStrictEqual(onDisk(file), {k: {n: 1}}, 'written by the flush itself, not a later retry');
    assert.deepStrictEqual(await r.end(), {code: 0, signal: null});
  });

  // (Windows) a handle never closed: the flush gives up at its one wait, and
  // the change is kept for the scheduled write, which lands it once the
  // other process has closed the file
  winIt('a handle never closed: the flush gives up within its wait, and the change is written once the file is let go (Windows)', async () => {
    r = await reader(`
      const fd = require('fs').openSync(${JSON.stringify(file)}, 'r');
      process.stdout.write('open\\n');
      process.stdin.resume();
      process.stdin.once('end', () => { require('fs').closeSync(fd); });
    `);
    f.set('k', {n: 1});
    f.flush();
    // (it returned: it gave up at its wait, and kept the change)
    assert.deepStrictEqual(onDisk(file), {k: {n: 0}}, 'not written while the handle is held');
    assert.deepStrictEqual(await r.end(), {code: 0, signal: null});
    const until = Date.now() + 15000;
    while (onDisk(file).k.n !== 1 && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
    assert.deepStrictEqual(onDisk(file), {k: {n: 1}}, 'the scheduled write landed it');
  });

  flushDirs.hooks();
});

// R-free-counter-double: a file found corrupt is moved aside, and the write
// then builds from this process's own map. Two paths built from that map
// by mistake: (1, Windows) update() tries a refused rename again, and its
// second attempt found no file (the first had moved it aside), so it built
// from nothing -- the record's free call counted as never there, the other
// keys dropped -- and the first attempt's fn had already changed the map's
// own nested objects (metering's free-call counter); (2, everywhere) a
// reload() that found the file corrupt moved it aside, and the next write
// found no file and wrote only the unwritten keys: the map's other keys
// lost from the file and from memory.
const corruptDirs = require('../helpers/test-tmp').forFile(['ch-store-04-corrupt-']);

describe('store 04: a write after a corrupt file builds from this process\'s map, once (R-free-counter-double)', function() {
  this.timeout(60000);
  const winIt = process.platform === 'win32' ? it : it.skip;
  const {meterId} = require('../../lib/key-fingerprint');
  const LocalMeteringProvider = require('../../lib/metering/local-provider');

  // (Windows: only there is a refused rename tried again -- renameRefused in
  // lib/store/json-file.js -- so the retry this case needs runs nowhere else)
  winIt('a charge whose rename is refused once, on a file found corrupt, spends one free call and keeps the other keys (Windows)', async () => {
    const dir = corruptDirs.mkdtemp('ch-store-04-corrupt-');
    const file = path.join(dir, 'metering.json');
    const apiKey = `k-${require('crypto').randomBytes(8).toString('hex')}`;
    const id = meterId(apiKey);
    const seeded = {other: {balance: 3, toolPriceRecord: {}}};
    seeded[id] = {balance: 10, toolPriceRecord: {t: {count: 2}}};
    fs.writeFileSync(file, JSON.stringify(seeded));
    const provider = new LocalMeteringProvider({meter: true, storePath: dir});
    const rename = fs.renameSync;
    let answer = null;
    try {
      fs.writeFileSync(file, '{"broken": ');
      // the first rename of a new file over the store's file refused, as
      // another process's open handle refuses it; the move-aside goes through
      let refused = 0;
      fs.renameSync = function(from, to) {
        if (refused === 0 && to === file && String(from).startsWith(`${file}.tmp-`)) {
          refused += 1;
          throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), {code: 'EPERM', syscall: 'rename'});
        }
        return rename.apply(this, arguments);
      };
      answer = await new Promise((resolve, reject) => provider.recordCall(apiKey, 't', 5, (err, a) => (err != null ? reject(err) : resolve(a))));
      assert.strictEqual(refused, 1, 'the first rename was refused');
    } finally {
      fs.renameSync = rename;
      provider.close();
    }
    assert.ok(fs.renameSync === rename, 'the stub is gone');
    assert.deepStrictEqual(answer, {tool: 't', charged: 0, balance: 10, remainingFreeCalls: 1});
    assert.deepStrictEqual(onDisk(file), {other: {balance: 3, toolPriceRecord: {}}, [id]: {balance: 10, toolPriceRecord: {t: {count: 1}}}});
  });

  it('a reload() that finds the file corrupt loses no key: the next write is this process\'s whole map, an own __proto__ key too', () => {
    const file = path.join(corruptDirs.mkdtemp('ch-store-04-corrupt-'), 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    try {
      f.set('a', {n: 1});
      f.set('__proto__', {own: true});
      f.flush();
      fs.writeFileSync(file, '{"broken": ');
      f.reload();
      f.set('b', {n: 2});
      f.flush();
      const disk = onDisk(file);
      assert.deepStrictEqual(Object.keys(disk).sort(), ['__proto__', 'a', 'b']);
      assert.deepStrictEqual([disk.a, Object.getOwnPropertyDescriptor(disk, '__proto__').value, disk.b], [{n: 1}, {own: true}, {n: 2}]);
      assert.deepStrictEqual(Object.keys(f.data).sort(), ['__proto__', 'a', 'b'], 'the map in memory kept them too');
      assert.deepStrictEqual(Object.getOwnPropertyDescriptor(f.data, '__proto__').value, {own: true});
      assert.ok(Object.getPrototypeOf(f.data) === Object.prototype, 'an own key, not the prototype');
    } finally {
      f.close();
    }
  });

  it('once a write has landed, a file removed later is the file as it is now: only the unwritten keys', () => {
    const file = path.join(corruptDirs.mkdtemp('ch-store-04-corrupt-'), 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    try {
      f.set('a', 1);
      f.flush();
      fs.writeFileSync(file, '{"broken": ');
      f.set('b', 2);
      f.flush();
      assert.deepStrictEqual(onDisk(file), {a: 1, b: 2}, 'the corrupt file rewritten from the whole map');
      fs.unlinkSync(file);
      f.set('c', 3);
      f.flush();
      assert.deepStrictEqual(onDisk(file), {c: 3});
    } finally {
      f.close();
    }
  });

  // (the medium on 3a134c1e, 1) local-kv reloads on an interval and a balance
  // check reloads: a second reload() found no file and took {} as the map
  it('reload() again and again after the file was found corrupt keeps the map, and the next write is all of it', () => {
    const file = path.join(corruptDirs.mkdtemp('ch-store-04-corrupt-'), 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    try {
      f.set('a', 1); f.set('z', 9);
      f.flush();
      fs.writeFileSync(file, '{"broken": ');
      f.reload(); f.reload(); f.reload();
      assert.deepStrictEqual(f.data, {a: 1, z: 9}, 'the map in memory as it was');
      f.set('b', 2);
      f.flush();
      assert.deepStrictEqual(onDisk(file), {a: 1, z: 9, b: 2});
    } finally {
      f.close();
    }
  });

  // a corrupt file removed before the rewrite, as a whole store reset removes
  // it: the store is gone, not rebuilt from memory
  it('a corrupt file removed before the rewrite: the next write is only the unwritten keys', () => {
    const dir = corruptDirs.mkdtemp('ch-store-04-corrupt-');
    const file = path.join(dir, 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    try {
      f.set('a', 1);
      f.flush();
      fs.writeFileSync(file, '{"broken": ');
      f.reload();
      fs.unlinkSync(file);
      f.set('c', 3);
      f.flush();
      assert.deepStrictEqual(onDisk(file), {c: 3});
    } finally {
      f.close();
    }
  });

  // (the medium on 3a134c1e, 3) a value set and not yet written is the one
  // update()'s fn is handed: it was the map's own object, so a refused rename
  // tried again ran fn on the already-changed record (Windows, as above)
  winIt('a record set and not yet written, then a charge whose rename is refused once, spends one free call (Windows)', async () => {
    const dir = corruptDirs.mkdtemp('ch-store-04-corrupt-');
    const file = path.join(dir, 'metering.json');
    const apiKey = `k-${require('crypto').randomBytes(8).toString('hex')}`;
    const id = meterId(apiKey);
    const provider = new LocalMeteringProvider({meter: true, storePath: dir});
    const rename = fs.renameSync;
    let answer = null;
    try {
      provider.file.set(id, {balance: 10, toolPriceRecord: {t: {count: 2}}});
      let refused = 0;
      fs.renameSync = function(from, to) {
        if (refused === 0 && to === file && String(from).startsWith(`${file}.tmp-`)) {
          refused += 1;
          throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), {code: 'EPERM', syscall: 'rename'});
        }
        return rename.apply(this, arguments);
      };
      answer = await new Promise((resolve, reject) => provider.recordCall(apiKey, 't', 5, (err, a) => (err != null ? reject(err) : resolve(a))));
      assert.strictEqual(refused, 1, 'the first rename was refused');
    } finally {
      fs.renameSync = rename;
      provider.close();
    }
    assert.ok(fs.renameSync === rename, 'the stub is gone');
    assert.deepStrictEqual(answer, {tool: 't', charged: 0, balance: 10, remainingFreeCalls: 1});
    assert.deepStrictEqual(onDisk(file), {[id]: {balance: 10, toolPriceRecord: {t: {count: 1}}}});
  });

  // (the medium on f66ec188, 3) everywhere: fn is handed a copy, so a fn that
  // changes its value and then throws leaves the map, and the unwritten value
  // the next write takes, as they were
  it('update()\'s fn is handed a copy: one that changes its value and throws changes neither the map nor the next write', async () => {
    const file = path.join(corruptDirs.mkdtemp('ch-store-04-corrupt-'), 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    try {
      f.set('k', {t: {count: 2}});
      const {err} = await update(f, 'k', (v) => { v.t.count -= 1; throw new Error('fn refused'); });
      assert.strictEqual(err && err.message, 'fn refused');
      assert.deepStrictEqual(f.data.k, {t: {count: 2}}, 'the map as it was');
      f.flush();
      assert.deepStrictEqual(onDisk(file), {k: {t: {count: 2}}}, 'the next write as it was');
    } finally {
      f.close();
    }
  });

  // (the high on 38015155, 2) every OS: a write that failed after its own
  // move-aside (ENOSPC, EIO, any rename error) left no file, and the next
  // charge built from nothing on every OS, not only Windows' retry
  it('a charge whose write fails after the file was found corrupt, then another charge: one free call spent, the other keys kept', async () => {
    const dir = corruptDirs.mkdtemp('ch-store-04-corrupt-');
    const file = path.join(dir, 'metering.json');
    const apiKey = `k-${require('crypto').randomBytes(8).toString('hex')}`;
    const id = meterId(apiKey);
    const seeded = {other: {balance: 3, toolPriceRecord: {}}};
    seeded[id] = {balance: 10, toolPriceRecord: {t: {count: 2}}};
    fs.writeFileSync(file, JSON.stringify(seeded));
    const provider = new LocalMeteringProvider({meter: true, storePath: dir});
    const rename = fs.renameSync;
    const charge = () => new Promise((resolve) => provider.recordCall(apiKey, 't', 5, (err, a) => resolve({err, a})));
    let first = null;
    let second = null;
    try {
      fs.writeFileSync(file, '{"broken": ');
      let failed = 0;
      fs.renameSync = function(from, to) {
        if (failed === 0 && to === file && String(from).startsWith(`${file}.tmp-`)) {
          failed += 1;
          throw Object.assign(new Error(`EIO: i/o error, rename '${from}' -> '${to}'`), {code: 'EIO', syscall: 'rename'});
        }
        return rename.apply(this, arguments);
      };
      first = await charge();
      second = await charge();
      assert.strictEqual(failed, 1, 'the first write failed');
    } finally {
      fs.renameSync = rename;
      provider.close();
    }
    assert.ok(fs.renameSync === rename, 'the stub is gone');
    assert.strictEqual(first.err && first.err.code, 'EIO');
    assert.deepStrictEqual(second, {err: null, a: {tool: 't', charged: 0, balance: 10, remainingFreeCalls: 1}});
    assert.deepStrictEqual(onDisk(file), {other: {balance: 3, toolPriceRecord: {}}, [id]: {balance: 10, toolPriceRecord: {t: {count: 1}}}});
  });

  // (the high on 38015155, 1) a good file read since the move-aside is the
  // file as it is: once it is removed, the store is gone, even with the aside
  // file still there
  it('a good file read after a corrupt one ends the rewrite: that file removed, the next write is only the unwritten keys', () => {
    const dir = corruptDirs.mkdtemp('ch-store-04-corrupt-');
    const file = path.join(dir, 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    try {
      f.set('a', 1);
      f.flush();
      fs.writeFileSync(file, '{"broken": ');
      f.reload();
      fs.writeFileSync(file, JSON.stringify({x: 1}));
      f.reload();
      assert.deepStrictEqual(f.data, {x: 1});
      fs.unlinkSync(file);
      f.set('c', 3);
      f.flush();
      assert.deepStrictEqual(onDisk(file), {c: 3});
    } finally {
      f.close();
    }
  });

  corruptDirs.hooks();
});

// R-store-aside-locked: a corrupt file is copied aside and replaced under the
// lock, in one hold, by the first writer; nothing else moves it. A write that
// fails leaves it in place (corrupt, never missing), so every process finds it
// so and rebuilds; reload() and open move nothing and ask for that rewrite.
// Only the first writer after a corruption writes its whole map; later ones
// read that file and lay their unwritten keys over it, as always: keys another
// process held only in memory, not unwritten, are not recovered.
const lockedDirs = require('../helpers/test-tmp').forFile(['ch-store-04-locked-']);

describe('store 04: a corrupt file is copied aside and replaced under the lock, never moved without it (R-store-aside-locked)', function() {
  this.timeout(60000);
  const logger = require('../../lib/logger');
  let logged = null;
  let W = null;
  beforeEach(() => { logged = []; W = logger.W; logger.W = (line) => { logged.push(String(line)); }; });
  afterEach(() => { logger.W = W; });
  // (process-wide: the read error last said for each file, cleared when this describe ends)
  after(() => { require('../../lib/store/json-file').forgetReadErrors(); });
  const aside = (dir, base) => fs.readdirSync(dir).filter((e) => e.startsWith(`${base}.corrupt-`));

  it('a write that fails after the file was found corrupt leaves it there: another process writes its whole map, and this one\'s change goes over it', async () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    const a = openJsonFile(file, {debounceMs: 60000});
    a.set('k1', 1); a.set('k2', 2); a.flush();
    const b = openJsonFile(file, {debounceMs: 60000});
    const rename = fs.renameSync;
    try {
      fs.writeFileSync(file, '{"broken": ');
      let failed = 0;
      fs.renameSync = function(from, to) {
        if (failed === 0 && to === file && String(from).startsWith(`${file}.tmp-`)) {
          failed += 1;
          throw Object.assign(new Error(`EIO: i/o error, rename '${from}' -> '${to}'`), {code: 'EIO', syscall: 'rename'});
        }
        return rename.apply(this, arguments);
      };
      const first = await update(a, 'k1', (v) => (v || 0) + 10);
      assert.strictEqual(first.err && first.err.code, 'EIO');
      assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"broken": ', 'the corrupt file is still there, not missing');
      b.set('b', 3); b.flush();
      assert.deepStrictEqual(onDisk(file), {k1: 1, k2: 2, b: 3}, 'the other process wrote its whole map');
      const second = await update(a, 'k1', (v) => (v || 0) + 10);
      assert.strictEqual(second.err, null);
    } finally {
      fs.renameSync = rename;
      a.close(); b.close();
    }
    assert.ok(fs.renameSync === rename, 'the stub is gone');
    assert.deepStrictEqual(onDisk(file), {k1: 11, k2: 2, b: 3});
  });

  it('the first writer after a corruption writes its whole map; a later one\'s unwritten keys go over it', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    const a = openJsonFile(file, {debounceMs: 60000});
    try {
      a.set('x', 1); a.flush();
      const b = openJsonFile(file, {debounceMs: 60000});
      try {
        fs.writeFileSync(file, '{"broken": ');
        a.reload(); a.flush();
        assert.deepStrictEqual(onDisk(file), {x: 1}, 'the first writer\'s whole map, though nothing of it was unwritten');
        b.set('y', 2); b.flush();
      } finally {
        b.close();
      }
    } finally {
      a.close();
    }
    assert.deepStrictEqual(onDisk(file), {x: 1, y: 2});
    assert.strictEqual(aside(dir, 'm.json').length, 1, 'one copy of the corrupt file, kept');
  });

  it('reload() never moves a file: a good one written between its read and a move stays', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    const read = fs.readFileSync;
    try {
      f.set('a', 1); f.flush();
      fs.writeFileSync(file, JSON.stringify({good: true}));
      // (the read sees a corrupt file; by the time anything would move it, another process has renamed a good one into place)
      let once = 0;
      fs.readFileSync = function(p) {
        if (once === 0 && p === file) { once += 1; return '{"broken": '; }
        return read.apply(this, arguments);
      };
      f.reload();
      assert.strictEqual(once, 1, 'the read saw the corrupt file');
      fs.readFileSync = read;
      assert.deepStrictEqual(onDisk(file), {good: true}, 'nothing moved it');
    } finally {
      fs.readFileSync = read;
      f.close();
    }
    assert.ok(fs.readFileSync === read, 'the stub is gone');
    assert.deepStrictEqual(onDisk(file), {good: true});
    assert.strictEqual(aside(dir, 'm.json').length, 0, 'nothing copied: the write found a good file');
  });

  it('a corrupt file found by reload(), then a close with nothing unwritten: the file holds the whole map, a copy of the corrupt one kept', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    f.set('a', 1); f.set('b', 2); f.flush();
    fs.writeFileSync(file, '{"broken": ');
    f.reload();
    assert.deepStrictEqual(f.data, {a: 1, b: 2});
    f.close();
    assert.deepStrictEqual(onDisk(file), {a: 1, b: 2});
    const kept = aside(dir, 'm.json');
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), '{"broken": ');
    assert.ok(logged.some((l) => l.includes(file) && l.includes(kept[0])), `the warning names the copy (${JSON.stringify(logged)})`);
  });

  it('a copy aside that can\'t be made never blocks the write: the whole map is written, and the warning says no copy was kept', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    const copy = fs.copyFileSync;
    try {
      f.set('a', 1); f.flush();
      fs.writeFileSync(file, '{"broken": ');
      fs.copyFileSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), {code: 'ENOSPC', syscall: 'copyfile'}); };
      f.set('b', 2); f.flush();
    } finally {
      fs.copyFileSync = copy;
      f.close();
    }
    assert.ok(fs.copyFileSync === copy, 'the stub is gone');
    assert.deepStrictEqual(onDisk(file), {a: 1, b: 2});
    assert.strictEqual(aside(dir, 'm.json').length, 0);
    assert.ok(logged.some((l) => l.includes(file) && /no copy (of it )?was kept/.test(l) && l.includes('ENOSPC')), `the warning says no copy was kept, and why (${JSON.stringify(logged)})`);
  });

  it('a read error is logged once for its code, and once when the file can be read again', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    const read = fs.readFileSync;
    let thrown = 0;
    try {
      f.set('a', 1); f.flush();
      fs.readFileSync = function(p) {
        if (p === file) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), {code: 'EACCES', syscall: 'open'});
        return read.apply(this, arguments);
      };
      for (let i = 0; i < 3; i++) { try { f.reload(); } catch (e) { thrown += 1; } }
      fs.readFileSync = read;
      f.reload(); f.reload();
    } finally {
      fs.readFileSync = read;
      f.close();
    }
    assert.strictEqual(thrown, 3, 'each reload still says it could not read');
    const mine = logged.filter((l) => l.includes(file));
    assert.strictEqual(mine.filter((l) => l.includes('EACCES')).length, 1, `once for the code (${JSON.stringify(mine)})`);
    assert.strictEqual(mine.filter((l) => /read again|readable again/.test(l)).length, 1, `once when it clears (${JSON.stringify(mine)})`);
  });

  it('local-kv\'s interval while kv.json can\'t be read: no throw out of it, and one line for the code', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const LocalKv = require('../../lib/local-kv');
    const kv = new LocalKv({storePath: dir});
    const file = path.join(dir, 'kv.json');
    const read = fs.readFileSync;
    try {
      fs.readFileSync = function(p) {
        if (p === file) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), {code: 'EACCES', syscall: 'open'});
        return read.apply(this, arguments);
      };
      for (let i = 0; i < 3; i++) kv.tick();
    } finally {
      fs.readFileSync = read;
      kv.close();
    }
    assert.ok(fs.readFileSync === read, 'the stub is gone');
    assert.strictEqual(logged.filter((l) => l.includes(file) && l.includes('EACCES')).length, 1, JSON.stringify(logged));
  });

  it('a balance asked for while the ledger can\'t be read is LEDGER_UNREADABLE (retryable), never a throw', async () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const LocalMeteringProvider = require('../../lib/metering/local-provider');
    const provider = new LocalMeteringProvider({meter: true, storePath: dir});
    const file = path.join(dir, 'metering.json');
    const read = fs.readFileSync;
    let got = null;
    try {
      fs.readFileSync = function(p) {
        if (p === file) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), {code: 'EACCES', syscall: 'open'});
        return read.apply(this, arguments);
      };
      got = await new Promise((resolve) => {
        try { provider.checkBalance(`k-${require('crypto').randomBytes(8).toString('hex')}`, (err, r) => resolve({err, r})); } catch (e) { resolve({thrown: e}); }
      });
    } finally {
      fs.readFileSync = read;
      provider.close();
    }
    assert.ok(fs.readFileSync === read, 'the stub is gone');
    assert.strictEqual(got.thrown, undefined, 'never thrown');
    assert.deepStrictEqual(got.err && [got.err.code, require('../../lib/error-catalogue').CODES[got.err.code].retryable], ['LEDGER_UNREADABLE', true]);
    assert.strictEqual(got.r, undefined);
  });

  // (the medium on cb7b5528)
  it('a good read ends the copy kept for a corruption: a later corruption gets a copy of its own', async () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    const rename = fs.renameSync;
    try {
      f.set('a', 1); f.flush();
      fs.writeFileSync(file, '{"first": ');
      let failed = 0;
      fs.renameSync = function(from, to) {
        if (failed === 0 && to === file && String(from).startsWith(`${file}.tmp-`)) { failed += 1; throw Object.assign(new Error('EIO: i/o error, rename'), {code: 'EIO', syscall: 'rename'}); }
        return rename.apply(this, arguments);
      };
      assert.strictEqual((await update(f, 'a', (v) => v + 1)).err.code, 'EIO');
      fs.renameSync = rename;
      fs.writeFileSync(file, JSON.stringify({a: 1, good: true}));
      f.reload();
      fs.writeFileSync(file, '{"second": ');
      f.set('z', 9); f.flush();
    } finally {
      fs.renameSync = rename;
      f.close();
    }
    const kept = aside(dir, 'm.json').map((e) => fs.readFileSync(path.join(dir, e), 'utf8')).sort();
    assert.deepStrictEqual(kept, ['{"first": ', '{"second": ']);
  });

  it('a corrupt ledger this process saw whole is a balance told from its map (the rewrite pending), never refused', async () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const LocalMeteringProvider = require('../../lib/metering/local-provider');
    const apiKey = `k-${require('crypto').randomBytes(8).toString('hex')}`;
    const file = path.join(dir, 'metering.json');
    fs.writeFileSync(file, JSON.stringify({[require('../../lib/key-fingerprint').meterId(apiKey)]: {balance: 10, toolPriceRecord: {}}}));
    const provider = new LocalMeteringProvider({meter: true, storePath: dir});
    let got = null;
    try {
      fs.writeFileSync(file, '{"broken": ');
      got = await new Promise((resolve) => provider.checkBalance(apiKey, (err, r) => resolve({err, r})));
    } finally {
      provider.close();
    }
    assert.deepStrictEqual(got, {err: null, r: {balance: 10}});
  });

  it('a copy aside whose first name is taken gets another: the copy is kept', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    const copy = fs.copyFileSync;
    const names = [];
    try {
      f.set('a', 1); f.flush();
      fs.writeFileSync(file, '{"broken": ');
      fs.copyFileSync = function(from, to) {
        names.push(to);
        if (names.length === 1) throw Object.assign(new Error(`EEXIST: file already exists, copyfile '${from}' -> '${to}'`), {code: 'EEXIST', syscall: 'copyfile'});
        return copy.apply(this, arguments);
      };
      f.set('b', 2); f.flush();
    } finally {
      fs.copyFileSync = copy;
      f.close();
    }
    assert.ok(fs.copyFileSync === copy, 'the stub is gone');
    assert.strictEqual(names.length, 2, 'a second name was tried');
    assert.notStrictEqual(names[0], names[1]);
    assert.deepStrictEqual(aside(dir, 'm.json').map((e) => path.join(dir, e)), [names[1]]);
    assert.strictEqual(fs.readFileSync(names[1], 'utf8'), '{"broken": ');
  });

  it('a read error with no code is logged once, and once when it clears', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    const read = fs.readFileSync;
    try {
      f.set('a', 1); f.flush();
      fs.readFileSync = function(p) { if (p === file) throw new Error('it broke'); return read.apply(this, arguments); };
      for (let i = 0; i < 2; i++) { try { f.reload(); } catch (e) { /* said */ } }
      fs.readFileSync = read;
      f.reload();
    } finally {
      fs.readFileSync = read;
      f.close();
    }
    const mine = logged.filter((l) => l.includes(file));
    assert.strictEqual(mine.filter((l) => l.includes('it broke')).length, 1, JSON.stringify(mine));
    assert.strictEqual(mine.filter((l) => /can be read again/.test(l)).length, 1, JSON.stringify(mine));
  });

  it('a close with only the corrupt file left to replace says that, not "0 changes"', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    const rename = fs.renameSync;
    try {
      f.set('a', 1); f.flush();
      fs.writeFileSync(file, '{"broken": ');
      f.reload();
      fs.renameSync = function(from, to) {
        if (to === file && String(from).startsWith(`${file}.tmp-`)) throw Object.assign(new Error('EIO: i/o error, rename'), {code: 'EIO', syscall: 'rename'});
        return rename.apply(this, arguments);
      };
      f.close();
    } finally {
      fs.renameSync = rename;
    }
    const closed = logged.filter((l) => l.includes(file) && l.includes('closed'));
    assert.strictEqual(closed.length, 1, JSON.stringify(logged));
    assert.ok(!/0 change/.test(closed[0]) && /corrupt file not replaced/.test(closed[0]), closed[0]);
  });

  // (the Reviewer's ruling (A) on cb7b5528's medium, 3: only a map that saw
  // a good copy of the file may replace a corrupt one; every store the same)
  it('metering: a map that never saw a good copy refuses to replace the corrupt ledger; a charge is refused until a map that did replaces it', async () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const LocalMeteringProvider = require('../../lib/metering/local-provider');
    const apiKey = `k-${require('crypto').randomBytes(8).toString('hex')}`;
    const id = require('../../lib/key-fingerprint').meterId(apiKey);
    const file = path.join(dir, 'metering.json');
    fs.writeFileSync(file, JSON.stringify({[id]: {balance: 10, toolPriceRecord: {t: {count: 1}}}, other: {balance: 3, toolPriceRecord: {}}}));
    const known = openJsonFile(file, {debounceMs: 60000});
    fs.writeFileSync(file, '{"broken": ');
    const fresh = new LocalMeteringProvider({meter: true, storePath: dir});
    const charge = () => new Promise((resolve) => fresh.recordCall(apiKey, 't', 5, (err, a) => resolve({err, a})));
    let refused = null;
    let after = null;
    try {
      refused = await charge();
      assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"broken": ', 'not replaced by a map that never saw it whole');
      known.reload(); known.flush();
      after = await charge();
    } finally {
      fresh.close(); known.close();
    }
    assert.ok(refused.err != null && refused.err.message.includes(file), String(refused.err && refused.err.message));
    assert.deepStrictEqual(after, {err: null, a: {tool: 't', charged: 0, balance: 10, remainingFreeCalls: 0}});
    assert.deepStrictEqual(onDisk(file), {[id]: {balance: 10, toolPriceRecord: {t: {count: 0}}}, other: {balance: 3, toolPriceRecord: {}}});
  });

  it('used nonces: a store that never saw the file whole refuses a use while it is corrupt (fail closed), never a first use', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'used-nonces.json');
    const nonce = require('crypto').randomBytes(16).toString('hex');
    const until = Date.now() + 60000;
    fs.writeFileSync(file, '{"broken": ');
    // (a store of its own, in a process of its own: its exit handlers and open map stay there)
    const r = child(`
      const used = require(${JSON.stringify(path.join(ROOT, 'lib', 'store'))}).createStore({store: 'local', storePath: ${JSON.stringify(dir)}}).usedNonces;
      used.use(${JSON.stringify(nonce)}, ${until}).then((first) => { console.log(JSON.stringify({first})); }, (err) => { console.log(JSON.stringify({err: err.message})); });
    `);
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(got.first, undefined, 'never answered as a first use');
    assert.ok(got.err != null && got.err.includes(file), r.stdout + r.stderr);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"broken": ');
  });

  it('kv: a map that never saw the file whole answers every command with an error, and once one that did replaces it, goes on from what it holds', async () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const LocalKv = require('../../lib/local-kv');
    const run = (kv, ...a) => new Promise((resolve) => kv[a[0]](...a.slice(1), (e, r) => resolve(e != null ? {err: e} : {r})));
    const a = new LocalKv({storePath: dir});
    const file = path.join(dir, 'kv.json');
    let b = null;
    const got = {};
    try {
      await run(a, 'set', 'counter', '57'); a.file.flush();
      fs.writeFileSync(file, '{"broken": ');
      b = new LocalKv({storePath: dir});
      got.set = await run(b, 'set', 'counter', '1');
      got.get = await run(b, 'get', 'counter');
      b.file.flush();
      assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"broken": ', 'the unknown map wrote nothing');
      a.reload(); a.file.flush();
      got.after = await run(b, 'get', 'counter');
      await run(b, 'set', 'other', 'x'); b.file.flush();
    } finally {
      if (b != null) b.close();
      a.close();
    }
    assert.ok(got.set.err != null && got.get.err != null, JSON.stringify(got));
    assert.deepStrictEqual(got.after, {r: '57'}, 'the real value, not one made against nothing');
    assert.deepStrictEqual([onDisk(file).counter.v, onDisk(file).other.v], ['57', 'x']);
  });

  it('metering: a charged call is refused before it runs while the ledger is corrupt and this process never saw it whole (LEDGER_CORRUPT, not retryable, from the billed gate and from checkBalance); an uncharged one is served', async () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const LocalMeteringProvider = require('../../lib/metering/local-provider');
    const file = path.join(dir, 'metering.json');
    fs.writeFileSync(file, JSON.stringify({other: {balance: 3, toolPriceRecord: {}}}));
    const known = openJsonFile(file, {debounceMs: 60000});
    fs.writeFileSync(file, '{"broken": ');
    const fresh = new LocalMeteringProvider({meter: true, storePath: dir});
    const gate = (billed = true) => new Promise((resolve) => fresh.rateLimit(`k-${require('crypto').randomBytes(8).toString('hex')}`, (err, r) => resolve({err, r}), {billed}));
    let before = null;
    let after = null;
    let balance = null;
    let uncharged = null;
    try {
      before = await gate();
      uncharged = await gate(false);
      balance = await new Promise((resolve) => fresh.checkBalance(`k-${require('crypto').randomBytes(8).toString('hex')}`, (err, r) => resolve({err, r})));
      known.reload(); known.flush();
      after = await gate();
    } finally {
      fresh.close(); known.close();
    }
    assert.deepStrictEqual(before.err && [before.err.code, require('../../lib/error-catalogue').CODES[before.err.code].retryable], ['LEDGER_CORRUPT', false]);
    assert.deepStrictEqual(balance.err && balance.err.code, 'LEDGER_CORRUPT', 'checkBalance answers the same');
    assert.deepStrictEqual(uncharged, {err: null, r: {limited: false}}, 'an uncharged call is not refused for the ledger');
    assert.deepStrictEqual(after, {err: null, r: {limited: false}});
  });

  it('a good file read by a write that then fails is taken in: a later corruption is replaced with it, not with the empty map', async () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    fs.writeFileSync(file, '{"broken": ');
    const b = openJsonFile(file, {debounceMs: 60000});
    const rename = fs.renameSync;
    try {
      fs.writeFileSync(file, JSON.stringify({k1: 1, k2: 2}));
      let failed = 0;
      fs.renameSync = function(from, to) {
        if (failed === 0 && to === file && String(from).startsWith(`${file}.tmp-`)) { failed += 1; throw Object.assign(new Error('EIO: i/o error, rename'), {code: 'EIO', syscall: 'rename'}); }
        return rename.apply(this, arguments);
      };
      assert.strictEqual((await update(b, 'k3', () => 3)).err.code, 'EIO');
      fs.renameSync = rename;
      assert.deepStrictEqual(b.data, {k1: 1, k2: 2}, 'the good file taken in');
      fs.writeFileSync(file, '{"broken again": ');
      b.set('z', 9); b.flush();
    } finally {
      fs.renameSync = rename;
      b.close();
    }
    assert.deepStrictEqual(onDisk(file), {k1: 1, k2: 2, z: 9});
  });

  it('a flush that can\'t write for a corrupt file it holds no copy of says how many changes are not written', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    fs.writeFileSync(file, '{"broken": ');
    const f = openJsonFile(file, {debounceMs: 60000});
    try {
      f.set('a', 1); f.set('b', 2); f.flush();
    } finally {
      f.close();
    }
    assert.ok(logged.some((l) => l.includes(file) && /2 change\(s\) not written/.test(l) && /holds no copy/.test(l)), JSON.stringify(logged));
  });

  it('a file this map replaced, corrupt again: said again, and the balance can be told meanwhile', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    try {
      f.set('a', 1); f.flush();
      fs.writeFileSync(file, '{"one": ');
      f.reload(); f.flush();
      fs.writeFileSync(file, '{"two": ');
      f.reload(); f.flush();
    } finally {
      f.close();
    }
    assert.strictEqual(logged.filter((l) => l.includes(file) && /could not be read as a JSON object/.test(l)).length, 2, JSON.stringify(logged));
  });

  it('the user moves the corrupt file away: a map opened on the missing file writes at once, and so does one that never saw it whole', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    fs.writeFileSync(file, '{"broken": ');
    const unknown = openJsonFile(file, {debounceMs: 60000});
    try {
      unknown.set('u', 1); unknown.flush();
      assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"broken": ');
      fs.renameSync(file, `${file}.moved-by-the-user`);
      const fresh = openJsonFile(file, {debounceMs: 60000});
      fresh.set('f', 2); fresh.close();
      assert.deepStrictEqual(onDisk(file), {f: 2});
      unknown.flush();
    } finally {
      unknown.close();
    }
    assert.deepStrictEqual(onDisk(file), {f: 2, u: 1});
  });

  // (the medium on the final range, 562c91ab)
  it('kv: the main thread\'s purge and listing refuse on a map that never saw the file whole, and work once it is replaced', async () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const LocalKv = require('../../lib/local-kv');
    const run = (kv, ...a) => new Promise((resolve, reject) => kv[a[0]](...a.slice(1), (e, r) => (e ? reject(e) : resolve(r))));
    const a = new LocalKv({storePath: dir});
    const file = path.join(dir, 'kv.json');
    let b = null;
    const got = {};
    try {
      await run(a, 'set', 'm:mod:x', '1'); await run(a, 'set', 'keep', '2'); a.file.flush();
      fs.writeFileSync(file, '{"broken": ');
      b = new LocalKv({storePath: dir});
      for (const [name, fn] of [['purge', () => b.deletePrefix('m:mod:')], ['list', () => b.keysWithPrefix('m:mod:')]]) {
        try { got[name] = {r: fn()}; } catch (e) { got[name] = {err: e.message}; }
      }
      a.reload(); a.file.flush();
      got.after = b.deletePrefix('m:mod:'); b.file.flush();
    } finally {
      if (b != null) b.close();
      a.close();
    }
    assert.ok(/holds no copy of it/.test(got.purge.err) && /holds no copy of it/.test(got.list.err), JSON.stringify(got));
    assert.strictEqual(got.after, 1);
    assert.deepStrictEqual(Object.keys(onDisk(file)), ['keep']);
  });

  it('a read error at open is said once for its code, however often the store is opened again', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    fs.writeFileSync(file, '{}');
    const read = fs.readFileSync;
    let thrown = 0;
    try {
      fs.readFileSync = function(p) {
        if (p === file) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), {code: 'EACCES', syscall: 'open'});
        return read.apply(this, arguments);
      };
      for (let i = 0; i < 3; i++) { try { openJsonFile(file); } catch (e) { thrown += 1; } }
    } finally {
      fs.readFileSync = read;
    }
    const f = openJsonFile(file);
    f.close();
    assert.strictEqual(thrown, 3, 'each open still says it could not read');
    const mine = logged.filter((l) => l.includes(file));
    assert.strictEqual(mine.filter((l) => l.includes('EACCES')).length, 1, JSON.stringify(mine));
    assert.ok(mine.includes(`local store: ${file} could not be read (EACCES)`), `at open there is no map to keep (${JSON.stringify(mine)})`);
    assert.strictEqual(mine.filter((l) => /can be read again/.test(l)).length, 1, JSON.stringify(mine));
  });

  it('a read error is said once for its code, not again by each write that meets it', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const file = path.join(dir, 'm.json');
    const f = openJsonFile(file, {debounceMs: 60000});
    const read = fs.readFileSync;
    try {
      f.set('a', 1); f.flush();
      fs.readFileSync = function(p) {
        if (p === file) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), {code: 'EACCES', syscall: 'open'});
        return read.apply(this, arguments);
      };
      f.set('b', 2); f.flush(); f.flush(); f.flush();
    } finally {
      fs.readFileSync = read;
      f.close();
    }
    const mine = logged.filter((l) => l.includes(file));
    assert.strictEqual(mine.filter((l) => l.includes('EACCES')).length, 1, JSON.stringify(mine));
    assert.ok(mine.includes(`local store: ${file} could not be read (EACCES); the map is kept as it is: changes made in memory wait until it can be read, and a change that needs it read first (a charge, a nonce's use) fails and is told to its caller`), JSON.stringify(mine));
    assert.ok(!mine.some((l) => /corrupt/.test(l)), `a read error is not a corrupt file (${JSON.stringify(mine)})`);
    assert.ok(mine.some((l) => /change\(s\) not written: the file could not be read/.test(l)), JSON.stringify(mine));
  });

  it('local-kv\'s interval keeps only the store\'s read errors to itself: anything else is thrown', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const LocalKv = require('../../lib/local-kv');
    const kv = new LocalKv({storePath: dir});
    let thrown = null;
    try {
      kv.sweep = () => { throw new Error('a bug in the sweep'); };
      try { kv.tick(); } catch (e) { thrown = e; }
    } finally {
      delete kv.sweep;   // (the prototype's again: close() sweeps)
      kv.close();
    }
    assert.strictEqual(thrown && thrown.message, 'a bug in the sweep');
  });

  it('kv: a purge that meets a read error answers the store\'s own words, never the file\'s path', () => {
    const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
    const LocalKv = require('../../lib/local-kv');
    const kv = new LocalKv({storePath: dir});
    const file = path.join(dir, 'kv.json');
    const read = fs.readFileSync;
    let err = null;
    try {
      kv.file.set('m:mod:x', {t: 'string', v: '1'}); kv.file.flush();
      fs.readFileSync = function(p) {
        if (p === file) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), {code: 'EACCES', syscall: 'open'});
        return read.apply(this, arguments);
      };
      try { kv.deletePrefix('m:mod:'); } catch (e) { err = e; }
    } finally {
      fs.readFileSync = read;
      kv.close();
    }
    assert.ok(err != null && /^ERR the store could not be read/.test(err.message), String(err && err.message));
    assert.ok(!err.message.includes(dir), err.message);
  });

  // (the Reviewer's ruling on the delta read, round 8) the ledger's state
  // table, a row a case: whether this runtime saw the file whole (known,
  // unknown) x the file (good, corrupt, unreadable), each path's answer: the
  // per-key gate (rateLimit), a charge (recordCall), a balance (checkBalance)
  describe('the ledger\'s state table', () => {
    const {CODES} = require('../../lib/error-catalogue');
    const {meterId} = require('../../lib/key-fingerprint');
    const LocalMeteringProvider = require('../../lib/metering/local-provider');
    const apiKey = `k-${require('crypto').randomBytes(8).toString('hex')}`;
    const ask = (p, m, ...a) => new Promise((resolve) => p[m](apiKey, ...a, (err, r) => resolve(err != null ? {err: err.code} : {r})));
    // the gate of a charged call (billed: its charge asked first) and of one nothing charges
    const gate = (p, billed = true) => new Promise((resolve) => p.rateLimit(apiKey, (err, r) => resolve(err != null ? {err: err.code} : {r}), {billed}));
    const ledger = (dir) => {
      const file = path.join(dir, 'metering.json');
      fs.writeFileSync(file, JSON.stringify({[meterId(apiKey)]: {balance: 10, toolPriceRecord: {t: {count: 2}}}}));
      return file;
    };
    const read = fs.readFileSync;
    let unreadable = null;
    beforeEach(() => {
      unreadable = null;
      fs.readFileSync = function(p) {
        if (p === unreadable) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), {code: 'EACCES', syscall: 'open'});
        return read.apply(this, arguments);
      };
    });
    afterEach(() => { fs.readFileSync = read; });

    it('the two texts, word for word, with their flags and statuses', () => {
      assert.deepStrictEqual([CODES.LEDGER_CORRUPT.en, CODES.LEDGER_CORRUPT.retryable, CODES.LEDGER_CORRUPT.httpStatus],
        ["The usage ledger can't be read, so charged calls and balance checks are refused until it is repaired; the runtime's log says how", false, 500]);
      assert.deepStrictEqual([CODES.LEDGER_UNREADABLE.en, CODES.LEDGER_UNREADABLE.retryable, CODES.LEDGER_UNREADABLE.httpStatus],
        ["The usage ledger can't be read right now; charged calls and balance checks are refused until it can be read again", true, 503]);
    });

    it('known, good: the gate passes, a charge is made, the balance told', async () => {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      ledger(dir);
      const p = new LocalMeteringProvider({meter: true, storePath: dir});
      try {
        assert.deepStrictEqual(await ask(p, 'rateLimit'), {r: {limited: false}});
        assert.deepStrictEqual(await ask(p, 'recordCall', 't', 5), {r: {tool: 't', charged: 0, balance: 10, remainingFreeCalls: 1}});
        assert.deepStrictEqual(await ask(p, 'checkBalance'), {r: {balance: 10}});
      } finally { p.close(); }
    });

    it('known, corrupt (the rewrite pending): nothing refused; the gate passes, a charge is made from the map, the balance told from it', async () => {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      const file = ledger(dir);
      const p = new LocalMeteringProvider({meter: true, storePath: dir});
      try {
        fs.writeFileSync(file, '{"broken": ');
        assert.deepStrictEqual(await ask(p, 'checkBalance'), {r: {balance: 10}});
        assert.deepStrictEqual(await ask(p, 'rateLimit'), {r: {limited: false}});
        assert.deepStrictEqual(await ask(p, 'recordCall', 't', 5), {r: {tool: 't', charged: 0, balance: 10, remainingFreeCalls: 1}});
      } finally { p.close(); }
      assert.deepStrictEqual(onDisk(file), {[meterId(apiKey)]: {balance: 10, toolPriceRecord: {t: {count: 1}}}});
    });

    it('known, corrupt, the rewrite failing (a full disk): nothing refused; the charge answers its write\'s error, and is lost', async () => {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      const file = ledger(dir);
      const p = new LocalMeteringProvider({meter: true, storePath: dir});
      const rename = fs.renameSync;
      try {
        fs.writeFileSync(file, '{"broken": ');
        fs.renameSync = function(from, to) {
          if (to === file && String(from).startsWith(`${file}.tmp-`)) throw Object.assign(new Error('ENOSPC: no space left on device, rename'), {code: 'ENOSPC', syscall: 'rename'});
          return rename.apply(this, arguments);
        };
        assert.deepStrictEqual(await ask(p, 'rateLimit'), {r: {limited: false}});
        assert.deepStrictEqual(await ask(p, 'checkBalance'), {r: {balance: 10}});
        assert.deepStrictEqual(await ask(p, 'recordCall', 't', 5), {err: 'ENOSPC'});
        assert.deepStrictEqual(await ask(p, 'checkBalance'), {r: {balance: 10}}, 'the lost charge is in no balance');
      } finally {
        fs.renameSync = rename;
        p.close();
      }
      assert.ok(fs.renameSync === rename, 'the stub is gone');
    });

    it('known, unreadable: once a read has failed, the gate and the balance refuse LEDGER_UNREADABLE (read again first); readable again, they go on', async () => {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      const file = ledger(dir);
      const p = new LocalMeteringProvider({meter: true, storePath: dir});
      try {
        unreadable = file;
        assert.deepStrictEqual(await ask(p, 'checkBalance'), {err: 'LEDGER_UNREADABLE'});
        assert.deepStrictEqual(await gate(p), {err: 'LEDGER_UNREADABLE'});
        assert.deepStrictEqual(await gate(p, false), {r: {limited: false}}, 'an uncharged call is not refused for the ledger');
        unreadable = null;
        assert.deepStrictEqual(await gate(p), {r: {limited: false}});
        assert.deepStrictEqual(await ask(p, 'checkBalance'), {r: {balance: 10}});
      } finally { p.close(); }
    });

    it('known, unreadable before any read has failed: every call let through before the first read fails runs; its charge\'s read fails and is told (logged and lost), and the gate then refuses', async () => {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      const file = ledger(dir);
      const p = new LocalMeteringProvider({meter: true, storePath: dir});
      try {
        unreadable = file;
        assert.deepStrictEqual(await gate(p), {r: {limited: false}});
        assert.deepStrictEqual(await ask(p, 'recordCall', 't', 5), {err: 'EACCES'});
        assert.deepStrictEqual(await gate(p), {err: 'LEDGER_UNREADABLE'});
      } finally { p.close(); }
    });

    it('unknown, corrupt: the billed gate and the balance refuse LEDGER_CORRUPT, a charge ECORRUPT; an uncharged call is served and its charge of 0 skipped: the file byte for byte as it was', async () => {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      const file = ledger(dir);
      fs.writeFileSync(file, '{"broken": ');
      const p = new LocalMeteringProvider({meter: true, storePath: dir});
      try {
        assert.deepStrictEqual(await gate(p), {err: 'LEDGER_CORRUPT'});
        assert.deepStrictEqual(await ask(p, 'checkBalance'), {err: 'LEDGER_CORRUPT'});
        assert.deepStrictEqual(await ask(p, 'recordCall', 't', 5), {err: 'ECORRUPT'});
        assert.deepStrictEqual(await gate(p, false), {r: {limited: false}}, 'an uncharged call is not refused for the ledger');
        assert.deepStrictEqual(await ask(p, 'recordCall', 't', 0), {r: {tool: 't', charged: 0, balance: null}}, 'a charge of 0 is skipped, never attempted');
        assert.deepStrictEqual(await ask(p, 'recordCall', 't', -5), {err: 'ECORRUPT'}, 'a credit is no charge of 0: it fails as it did');
        assert.deepStrictEqual(await ask(p, 'recordCall', 't', null), {err: 'ECORRUPT'}, 'a cost that is not the number 0 fails as it did');
      } finally { p.close(); }
      assert.ok(fs.readFileSync(file).equals(Buffer.from('{"broken": ')), 'the file was changed');
    });

    it('unknown, unreadable: the gate and the balance refuse LEDGER_UNREADABLE', async () => {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      const file = ledger(dir);
      fs.writeFileSync(file, '{"broken": ');
      const p = new LocalMeteringProvider({meter: true, storePath: dir});
      try {
        unreadable = file;
        assert.deepStrictEqual(await gate(p), {err: 'LEDGER_UNREADABLE'});
        assert.deepStrictEqual(await ask(p, 'checkBalance'), {err: 'LEDGER_UNREADABLE'});
        assert.deepStrictEqual(await gate(p, false), {r: {limited: false}}, 'an uncharged call is not refused for the ledger');
      } finally { p.close(); }
    });

    it('a charge of 0 reads an unreadable ledger again first: readable again, it is used again (its free-call count taken)', async () => {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      const file = ledger(dir);
      const p = new LocalMeteringProvider({meter: true, storePath: dir});
      try {
        unreadable = file;
        // (a read that fails: a balance request's)
        assert.deepStrictEqual(await ask(p, 'checkBalance'), {err: 'LEDGER_UNREADABLE'});
        assert.deepStrictEqual(await ask(p, 'recordCall', 't', 0), {r: {tool: 't', charged: 0, balance: null}}, 'still unreadable: skipped');
        unreadable = null;
        assert.deepStrictEqual(await ask(p, 'recordCall', 't', 0), {r: {tool: 't', charged: 0, balance: 10, remainingFreeCalls: 1}});
      } finally { p.close(); }
    });

    it('unknown, then good (another process replaced it): everything goes on, read again first', async () => {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      const file = ledger(dir);
      const good = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, '{"broken": ');
      const p = new LocalMeteringProvider({meter: true, storePath: dir});
      try {
        fs.writeFileSync(file, good);
        assert.deepStrictEqual(await ask(p, 'rateLimit'), {r: {limited: false}});
        assert.deepStrictEqual(await ask(p, 'recordCall', 't', 5), {r: {tool: 't', charged: 0, balance: 10, remainingFreeCalls: 1}});
        assert.deepStrictEqual(await ask(p, 'checkBalance'), {r: {balance: 10}});
      } finally { p.close(); }
    });
  });

  // (the overview) the store files this
  // process can answer nothing from: corrupt, and no map here saw it whole.
  // Read only: never a reload, which would ask for a write.
  describe('heldNoCopy: a corrupt store file this process holds no copy of', () => {
    const {heldNoCopy} = require('../../lib/store/json-file');
    const NAMES = ['metering.json', 'used-nonces.json', 'kv.json'];

    it('none there, or good: none; corrupt with no map open on it: named, in the order asked', () => {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      assert.deepStrictEqual(heldNoCopy(dir, NAMES), []);
      assert.deepStrictEqual(heldNoCopy(path.join(dir, 'none'), NAMES), []);
      fs.writeFileSync(path.join(dir, 'metering.json'), '{}');
      fs.writeFileSync(path.join(dir, 'kv.json'), '[]');
      fs.writeFileSync(path.join(dir, 'used-nonces.json'), '{"broken": ');
      assert.deepStrictEqual(heldNoCopy(dir, NAMES), ['used-nonces.json', 'kv.json']);
      assert.deepStrictEqual(heldNoCopy(dir, ['kv.json']), ['kv.json'], 'only the names asked');
    });

    it('a map opened on the corrupt file holds no copy: named, until the file is good or moved away; the file never written by asking', () => {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      const file = path.join(dir, 'kv.json');
      fs.writeFileSync(file, '{"broken": ');
      const unknown = openJsonFile(file, {debounceMs: 60000});
      try {
        assert.ok(unknown.isUnknownCorrupt());
        assert.deepStrictEqual(heldNoCopy(dir, NAMES), ['kv.json']);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"broken": ');
        fs.renameSync(file, `${file}.moved-by-the-user`);
        assert.deepStrictEqual(heldNoCopy(dir, NAMES), [], 'moved away');
        fs.writeFileSync(file, '{"a": 1}');
        assert.deepStrictEqual(heldNoCopy(dir, NAMES), [], 'good again (another process replaced it)');
      } finally {
        unknown.close();
      }
    });

    it('a map that saw the file whole holds its copy: not named, though the file is corrupt now', () => {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      const file = path.join(dir, 'metering.json');
      fs.writeFileSync(file, '{"a": 1}');
      const known = openJsonFile(file, {debounceMs: 60000});
      let knownOpen = true;
      const unknownToo = (() => { fs.writeFileSync(file, 'not json'); return openJsonFile(file, {debounceMs: 60000}); })();
      try {
        assert.deepStrictEqual(heldNoCopy(dir, NAMES), [], 'one map here saw it whole');
        known.close();
        knownOpen = false;
        assert.deepStrictEqual(heldNoCopy(dir, NAMES), ['metering.json'], 'closed, only the one that never saw it is left');
      } finally {
        if (knownOpen) known.close();
        unknownToo.close();
      }
    });

    it('a file is parsed again only when it changed; a change is seen at once, the same size or not', () => {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      const file = path.join(dir, 'kv.json');
      fs.writeFileSync(file, '{"broken":}');
      assert.deepStrictEqual(heldNoCopy(dir, NAMES), ['kv.json']);
      const parse = JSON.parse;
      let parsed = 0;
      JSON.parse = function(...a) { parsed++; return parse.apply(this, a); };
      try {
        assert.deepStrictEqual(heldNoCopy(dir, NAMES), ['kv.json']);
        assert.strictEqual(parsed, 0, 'unchanged: not parsed again');
        fs.writeFileSync(`${file}.next`, '{"fixed":1}');   // the same size, a new inode, as a writer's rename makes
        fs.renameSync(`${file}.next`, file);
        assert.deepStrictEqual(heldNoCopy(dir, NAMES), []);
        assert.strictEqual(parsed, 1);
      } finally {
        JSON.parse = parse;
      }
      fs.unlinkSync(file);
      assert.deepStrictEqual(heldNoCopy(dir, NAMES), []);
      fs.writeFileSync(file, 'nope');
      assert.deepStrictEqual(heldNoCopy(dir, NAMES), ['kv.json'], 'there again, corrupt');
    });

    it('a map opened under another spelling of its folder (a link) is found: its copy counts', function() {
      if (process.platform === 'win32') this.skip();
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      const real = path.join(dir, 'real');
      fs.mkdirSync(real);
      const link = path.join(dir, 'link');
      fs.symlinkSync(real, link, 'dir');
      fs.writeFileSync(path.join(real, 'kv.json'), '{"a": 1}');
      const known = openJsonFile(path.join(link, 'kv.json'), {debounceMs: 60000});
      try {
        fs.writeFileSync(path.join(real, 'kv.json'), 'broken');
        assert.deepStrictEqual(heldNoCopy(real, NAMES), [], 'the map opened through the link saw it whole');
      } finally {
        known.close();
      }
      assert.deepStrictEqual(heldNoCopy(real, NAMES), ['kv.json']);
    });

    it('a store file that is a folder, or can\'t be read for another reason, is not named', function() {
      const dir = lockedDirs.mkdtemp('ch-store-04-locked-');
      fs.mkdirSync(path.join(dir, 'kv.json'));
      assert.deepStrictEqual(heldNoCopy(dir, NAMES), []);
      if (process.platform === 'win32') return;
      const file = path.join(dir, 'used-nonces.json');
      fs.writeFileSync(file, '{bad');
      fs.chmodSync(file, 0o000);
      try {
        let readable = true;
        try { fs.readFileSync(file); } catch (e) { readable = false; }
        if (readable) this.skip();
        assert.deepStrictEqual(heldNoCopy(dir, NAMES), []);
      } finally {
        fs.chmodSync(file, 0o600);
      }
    });
  });

  lockedDirs.hooks();
});

// writeAtomic once wrote the map with one fs.writeSync and
// never read its count; a short write (a full disk) left a truncated temp
// file, renamed over the good one. Each write is now continued until every
// byte is down, and one that makes no progress fails before the rename.
const shortDirs = require('../helpers/test-tmp').forFile(['ch-store-04-short-']);
describe('store 04: a write that stops short', function() {
  this.timeout(30000);
  const logger = require('../../lib/logger');
  const real = {writeSync: fs.writeSync, openSync: fs.openSync, closeSync: fs.closeSync, W: logger.W};
  let logged = [];
  const restore = () => { fs.writeSync = real.writeSync; fs.openSync = real.openSync; fs.closeSync = real.closeSync; };
  beforeEach(() => { logged = []; logger.W = (line) => { logged.push(String(line)); }; });
  afterEach(() => { restore(); logger.W = real.W; });
  // writes to this store's own temp file only (`<file>.tmp-<pid>`, while it
  // is open) go through `write`; every other write (the log, the lock file,
  // an fd number reused after the temp file closed) is left alone
  function stubTempWrites(file, write) {
    const tempName = `${file}.tmp-${process.pid}`;
    const temp = new Set();
    fs.openSync = function(p, ...rest) {
      const fd = real.openSync.call(fs, p, ...rest);
      if (String(p) === tempName) temp.add(fd);
      return fd;
    };
    fs.closeSync = function(fd) {
      temp.delete(fd);
      return real.closeSync.call(fs, fd);
    };
    fs.writeSync = function(fd, ...rest) {
      return temp.has(fd) ? write(fd, ...rest) : real.writeSync.call(fs, fd, ...rest);
    };
  }

  it('a write that puts down only part of what it was given is continued: the file ends whole', () => {
    const file = path.join(shortDirs.mkdtemp('ch-store-04-short-'), 'm.json');
    const a = openJsonFile(file);
    try {
      a.set('k', 'x'.repeat(5000));
      // (each call writes half of what it is given, at least one byte)
      stubTempWrites(file, (fd, data, ...rest) => {
        if (typeof(data) === 'string') return real.writeSync.call(fs, fd, data.slice(0, Math.ceil(data.length / 2)));
        const off = rest[0] != null ? rest[0] : 0;
        const len = rest[1] != null ? rest[1] : data.length - off;
        return real.writeSync.call(fs, fd, data, off, Math.max(1, Math.ceil(len / 2)));
      });
      a.flush();
      restore();
      assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).k === 'x'.repeat(5000), 'the file holds the whole map');
      assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-')), []);
    } finally {
      restore();
      a.close();
    }
  });

  it('a write that makes no progress fails before the rename: the file keeps what it held, no temp file is left, the failure is logged naming the file and never the map, and the change is written once a write can', () => {
    const file = path.join(shortDirs.mkdtemp('ch-store-04-short-'), 'm.json');
    const a = openJsonFile(file);
    try {
      a.set('a', 1);
      a.flush();
      a.set('b', 'held-value-b');
      stubTempWrites(file, () => 0);
      a.flush();
      restore();
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {a: 1});
      assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-')), []);
      const lines = logged.filter((l) => l.includes('not written'));
      assert.strictEqual(lines.length, 1, JSON.stringify(logged));
      assert.ok(lines[0].includes(`writing ${file}.tmp-${process.pid} stopped after 0 of `), lines[0]);
      assert.ok(!lines[0].includes('held-value-b'), lines[0]);
      a.close();
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {a: 1, b: 'held-value-b'});
    } finally {
      restore();
      a.close();
    }
  });

  shortDirs.hooks();
});

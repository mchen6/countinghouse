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

  it('moves a corrupt file aside and starts empty', () => {
    const dir = tmpStore();
    const file = path.join(dir, 'm.json');
    fs.writeFileSync(file, '{"half": ');
    assert.deepStrictEqual(openJsonFile(file).data, {});
    assert.strictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('m.json.corrupt-')).length, 1);
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

  // The mechanism, deterministically: an announced waiter is yielded to.
  it('a fresh announcement by another live waiter is yielded to; a dead or old one is not', () => {
    const dir = tmpStore();
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {stdio: 'ignore'});
    try {
      const announce = (pid, ageMs) => fs.writeFileSync(path.join(dir, '.lock.waiting'),
        JSON.stringify({pid: pid, startMs: 1, at: Date.now() - ageMs}));
      // a live waiter that announced 1700 ms ago: yielded to until it is 2 s old
      announce(sleeper.pid, 1700);
      const t = Date.now();
      withStoreLock(dir, () => {});
      assert.strictEqual(withStoreLock.waited, true, 'did not yield');
      assert.ok(Date.now() - t >= 200, `yielded only ${Date.now() - t} ms`);
      // a dead one, and an old one, are not
      const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {encoding: 'utf8'});
      announce(Number(gone.stdout), 0);
      withStoreLock(dir, () => {});
      assert.strictEqual(withStoreLock.waited, false, 'yielded to a dead waiter');
      announce(sleeper.pid, 5000);
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
      try { seen = seen || JSON.parse(fs.readFileSync(path.join(dir, '.lock.waiting'), 'utf8')); } catch (e) { /* not yet */ }
    }, 20);
    await new Promise((resolve, reject) => f.update('k', () => 1, (err) => (err ? reject(err) : resolve())));
    clearInterval(probe);
    f.close();
    assert.ok(seen != null && seen.pid === process.pid, `no announcement seen: ${JSON.stringify(seen)}`);
    assert.ok(!fs.existsSync(path.join(dir, '.lock.waiting')), 'the announcement was left behind');
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
    assert.ok(!fs.existsSync(path.join(dir, '.lock.waiting')), 'the announcement was left behind');
    await new Promise((resolve) => holder.on('exit', resolve));
  });

  // The message a wait ends with, decided where the wait ends (busyError),
  // with no wait and no renewing: a fresh announcement by a live process
  // and no lock held is a yield, named by the waiter's pid. (A wait of
  // LOCK_WAIT_MS against an announcement a child kept renewing depended on
  // the renewal's timing, and on Windows a rename over the file while it
  // is read can fail: flaky on #165's CI.)
  it('a wait that ends yielding to a waiter names the waiter, not a holder', () => {
    const {busyError} = require(MOD);
    const dir = tmpStore();
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {stdio: 'ignore'});
    try {
      fs.writeFileSync(path.join(dir, '.lock.waiting'), JSON.stringify({pid: sleeper.pid, startMs: 1, at: Date.now()}));
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
  // the waiter has announced (the rename onto .lock.waiting), the other
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
      const rename = fs.renameSync;
      fs.renameSync = function(from, to) {
        const r = rename.apply(this, arguments);
        if (String(to).endsWith('.lock.waiting') && announced == null) announced = monotonic();
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
  const announcement = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.lock.waiting'), 'utf8')); } catch (e) { return null; } };
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

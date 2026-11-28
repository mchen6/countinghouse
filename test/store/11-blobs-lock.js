'use strict';
// The result store's lock (lib/store/blobs-local.js): the store lock's own
// (lib/store/json-file.js tryLock), so two processes never both hold it, a
// refused release never locks a process out for good, and its deadline keeps
// to a monotonic clock. Run against blobs' own withLock, through real
// processes where it takes two.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawn, spawnSync} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const BLOBS = path.join(ROOT, 'lib', 'store', 'blobs-local');
const STORE = path.join(ROOT, 'lib', 'store', 'json-file');

describe('store 11: the result store\'s lock', function() {
  this.timeout(60000);
  const tmp = require('../helpers/test-tmp').forFile(['ch-store11-']);
  // (a pid no process can have: above every system's limit)
  const deadPid = () => 2147483000;
  const lockDirOf = (dir) => path.join(dir, '.lockdir');

  // (the store lock's interleaving that once gave two holders: two stalls, each between two
  // consecutive filesystem calls of one process, waited for only where the code reaches them)
  const ROLE = `
    const fs = require('fs'); const path = require('path');
    const [BLOBS, DIR, ROLE] = process.argv.slice(1);
    const sig = (n) => path.join(DIR, 'sig.' + n);
    const sl = new Int32Array(new SharedArrayBuffer(4));
    const waitFor = (n, ms = 20000) => { const t = Date.now() + ms; while (!fs.existsSync(sig(n))) { if (Date.now() > t) throw new Error('timed out waiting for ' + n); Atomics.wait(sl, 0, 0, 2); } };
    const say = (n) => fs.writeFileSync(sig(n), String(process.pid));
    const realUnlink = fs.unlinkSync, realWrite = fs.writeFileSync, realRead = fs.readFileSync;
    let paused = false, inSection = false;
    const takeoverName = (t) => path.basename(String(t)).startsWith('.lock.takeover');
    if (ROLE === 'B') {
      fs.unlinkSync = function(t) { if (!paused && takeoverName(t)) { paused = true; say('B-paused'); waitFor('B-go'); } return realUnlink.apply(this, arguments); };
    } else {
      fs.writeFileSync = function(t, d, o) { const r = realWrite.apply(this, arguments); if (takeoverName(t) && o && o.flag === 'wx') inSection = true; return r; };
      fs.readFileSync = function(t) { const r = realRead.apply(this, arguments); if (inSection && !paused && path.basename(String(t)) === '.lock') { paused = true; say('A-paused'); waitFor('A-go'); } return r; };
    }
    const {withLock} = require(BLOBS).forTests;
    const marker = path.join(DIR, '.lockdir', 'holder.marker');
    let result = 'alone';
    withLock(DIR, async () => {
      try { realWrite(marker, String(process.pid), {flag: 'wx'}); } catch (e) { if (e.code === 'EEXIST') result = 'two holders'; else throw e; }
      say(ROLE + '-holding');
      if (ROLE === 'B') waitFor('B-release');
      if (result === 'alone') realUnlink(marker);
    }).then(() => { say(ROLE + '-done'); process.stdout.write(result); }, (e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });
  `;
  const sigOf = (dir, n) => path.join(dir, `sig.${n}`);
  const until = async (dir, names, ms = 15000) => {
    const end = Date.now() + ms;
    const seen = () => names.some((n) => fs.existsSync(sigOf(dir, n)));
    while (!seen() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 2));
    return seen();
  };

  it('(a regression guard for the old code\'s race) a takeover left behind, two stalls at the points that broke the store lock: never two holders of the result store\'s lock', async () => {
    const dir = tmp.mkdtemp('ch-store11-');
    fs.mkdirSync(lockDirOf(dir), {recursive: true});
    fs.writeFileSync(path.join(lockDirOf(dir), '.lock'), JSON.stringify({pid: deadPid(), at: Date.now()}));
    fs.writeFileSync(path.join(lockDirOf(dir), '.lock.takeover'), '1');
    const old = (Date.now() - 20000) / 1000;
    fs.utimesSync(path.join(lockDirOf(dir), '.lock.takeover'), old, old);
    const kids = [];
    const run = (role) => {
      const k = spawn(process.execPath, ['-e', ROLE, BLOBS, dir, role], {stdio: ['ignore', 'pipe', 'pipe']});
      kids.push(k);
      let out = '', err = '';
      k.stdout.on('data', (c) => { out += c; });
      k.stderr.on('data', (c) => { err += c; });
      return new Promise((resolve) => k.on('close', (code) => resolve({role, code, out, err})));
    };
    const say = (n) => fs.writeFileSync(sigOf(dir, n), 'go');
    try {
      const b = run('B');
      assert.ok(await until(dir, ['B-paused', 'B-holding', 'B-done']), 'B never got as far as its stall or a hold');
      const a = run('A');
      await until(dir, ['A-paused', 'A-holding', 'A-done'], 5000);
      say('B-go');
      await until(dir, ['B-holding', 'B-done']);
      say('A-go');
      await until(dir, ['A-holding', 'A-done'], 2000);
      say('B-release');
      const results = await Promise.all([b, a]);
      for (const r of results) assert.strictEqual(r.code, 0, `${r.role} failed: ${r.err}`);
      assert.deepStrictEqual(results.map((r) => `${r.role}: ${r.out}`), ['B: alone', 'A: alone'], 'two processes held the result store\'s lock at once');
    } finally {
      for (const k of kids) if (k.exitCode == null && k.signalCode == null) k.kill();
    }
  });

  describe('a release refused', () => {
    const unlink = fs.unlinkSync;
    let refused = 0;
    before(() => require(STORE).forTests.refuseAsWindows(true));
    after(() => { require(STORE).forTests.refuseAsWindows(false); require(STORE).forTests.stopReleases(); });
    beforeEach(() => {
      refused = 0;
      fs.unlinkSync = function(t) {
        if (path.basename(String(t)) === '.lock' && refused === 0) { refused++; throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${t}'`), {code: 'EPERM', syscall: 'unlink'}); }
        return unlink.apply(this, arguments);
      };
    });
    afterEach(() => { fs.unlinkSync = unlink; });

    it('(Windows: another program has the lock open): the next take of the lock succeeds, never a lock-out for good', async () => {
      const dir = tmp.mkdtemp('ch-store11-');
      const {withLock} = require(BLOBS).forTests;
      await withLock(dir, async () => {});
      assert.strictEqual(refused, 1, 'the release was not refused as set up');
      await withLock(dir, async () => {});
    });
  });

  it('a live holder\'s lock, young or old, is never taken over; a dead holder\'s is', async () => {
    const dir = tmp.mkdtemp('ch-store11-');
    const {withLock} = require(BLOBS).forTests;
    const sleeper = spawn(process.execPath, ['-e', 'process.stdout.write("up"); setTimeout(() => {}, 30000)'], {stdio: ['ignore', 'pipe', 'ignore']});
    try {
      await new Promise((resolve) => sleeper.stdout.once('data', resolve));
      const startId = process.platform === 'linux' ? `t${fs.readFileSync(`/proc/${sleeper.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]}` : 'm1';
      fs.mkdirSync(lockDirOf(dir), {recursive: true});
      for (const age of [0, 3600 * 1000]) {
        fs.writeFileSync(path.join(lockDirOf(dir), '.lock'), JSON.stringify({pid: sleeper.pid, startId, instance: 'aa', n: 1, at: Date.now() - age}));
        await assert.rejects(withLock(dir, async () => {}), /held by a live process/, `a live holder's lock ${age} ms old was taken over`);
      }
    } finally {
      sleeper.kill();
    }
    fs.writeFileSync(path.join(lockDirOf(dir), '.lock'), JSON.stringify({pid: deadPid(), startId: 'm1', instance: 'aa', n: 1, at: Date.now()}));
    await withLock(dir, async () => {});
  });


  // (where this process's start is in ms: off Linux, or with /proc unread)
  (require(STORE).forTests.START_ID.startsWith('m') ? it : it.skip)('a lock this process\'s pid left with a start in ms far from this process\'s (an earlier process given its pid) is a dead holder\'s: taken over', async () => {
    const dir = tmp.mkdtemp('ch-store11-');
    const {withLock} = require(BLOBS).forTests;
    fs.mkdirSync(lockDirOf(dir), {recursive: true});
    // (as off Linux: a start in ms; its at before this process's own start)
    const before = Date.now() - process.uptime() * 1000 - 60000;
    fs.writeFileSync(path.join(lockDirOf(dir), '.lock'), JSON.stringify({pid: process.pid, startId: 'm1', instance: 'earlier', n: 1, at: before}));
    await withLock(dir, async () => {});
  });

  it('a lock of another copy of this process recording the other form of start (its /proc read failed, or not) is a live holder\'s: never taken over', async () => {
    const dir = tmp.mkdtemp('ch-store11-');
    const {withLock} = require(BLOBS).forTests;
    const store = require(STORE).forTests;
    fs.mkdirSync(lockDirOf(dir), {recursive: true});
    const other = store.START_ID.startsWith('t') ? `m${Math.round(Date.now() - process.uptime() * 1000)}` : 't1';
    fs.writeFileSync(path.join(lockDirOf(dir), '.lock'), JSON.stringify({pid: process.pid, startId: other, instance: 'sibling', n: 1, at: Date.now()}));
    await assert.rejects(withLock(dir, async () => {}), /held by a live process/, 'another copy\'s live lock, recording the other form of start, was taken over');
  });

  it('a lock of another copy of this process, dated before this process began (as after a step back of the wall clock), is a live holder\'s: never taken over', async () => {
    const dir = tmp.mkdtemp('ch-store11-');
    const {withLock} = require(BLOBS).forTests;
    const store = require(STORE).forTests;
    fs.mkdirSync(lockDirOf(dir), {recursive: true});
    const before = Date.now() - process.uptime() * 1000 - 60000;
    fs.writeFileSync(path.join(lockDirOf(dir), '.lock'), JSON.stringify({pid: process.pid, startId: store.START_ID, instance: 'sibling', n: 1, at: before}));
    await assert.rejects(withLock(dir, async () => {}), /held by a live process/, 'another copy\'s live lock was taken over by its time');
  });

  it('a lock of another copy of this process (dated since it began) is a live holder\'s: never taken over by its age', async () => {
    const dir = tmp.mkdtemp('ch-store11-');
    const {withLock} = require(BLOBS).forTests;
    const store = require(STORE).forTests;
    fs.mkdirSync(lockDirOf(dir), {recursive: true});
    fs.writeFileSync(path.join(lockDirOf(dir), '.lock'), JSON.stringify({pid: process.pid, startId: store.START_ID, instance: 'sibling', n: 1, at: Date.now()}));
    // (its age by the wall clock made 200 s: never taken over for it here)
    store.clock({wall: 200000});
    try {
      await assert.rejects(withLock(dir, async () => {}), /held by a live process/);
    } finally {
      store.clock(null);
    }
  });

  (process.platform === 'linux' ? it : it.skip)('a lock whose pid is live but whose start is another (a pid given to another process) is a dead holder\'s: taken over', async () => {
    const dir = tmp.mkdtemp('ch-store11-');
    const {withLock} = require(BLOBS).forTests;
    const sleeper = spawn(process.execPath, ['-e', 'process.stdout.write("up"); setTimeout(() => {}, 30000)'], {stdio: ['ignore', 'pipe', 'ignore']});
    try {
      await new Promise((resolve) => sleeper.stdout.once('data', resolve));
      fs.mkdirSync(lockDirOf(dir), {recursive: true});
      fs.writeFileSync(path.join(lockDirOf(dir), '.lock'), JSON.stringify({pid: sleeper.pid, startId: 't1', instance: 'aa', n: 1, at: Date.now()}));
      await withLock(dir, async () => {});
    } finally {
      sleeper.kill();
    }
  });

  describe('a release refused past the point', () => {
    const unlink = fs.unlinkSync;
    let refuse = false;
    before(() => require(STORE).forTests.refuseAsWindows(true));
    after(() => { require(STORE).forTests.refuseAsWindows(false); require(STORE).forTests.stopReleases(); require(STORE).forTests.releaseTimes(null); require(STORE).forTests.clock(null); });
    beforeEach(() => {
      refuse = false;
      fs.unlinkSync = function(t) {
        if (refuse && path.basename(String(t)) === '.lock') throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${t}'`), {code: 'EPERM', syscall: 'unlink'});
        return unlink.apply(this, arguments);
      };
    });
    afterEach(() => { fs.unlinkSync = unlink; });

    it('its cleanup still runs (nobody takes a live holder\'s lock here, so no point stops it): the lock goes once it can', async () => {
      const dir = tmp.mkdtemp('ch-store11-');
      const {withLock} = require(BLOBS).forTests;
      const store = require(STORE).forTests;
      store.releaseTimes({retryMs: 50, cleanupMs: 60000, staleCapMs: 300});
      // (held past the point, by the monotonic clock moved on inside the hold; its removal refused)
      await withLock(dir, async () => { refuse = true; store.clock({mono: 20000}); });
      const until = Date.now() + 5000;
      while (store.holds(lockDirOf(dir)) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
      refuse = false;
      const until2 = Date.now() + 5000;
      while (fs.existsSync(path.join(lockDirOf(dir), '.lock')) && Date.now() < until2) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(!fs.existsSync(path.join(lockDirOf(dir), '.lock')), 'the lock stayed: its cleanup stopped at the point');
    });
  });
  tmp.hooks();
});

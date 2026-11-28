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

describe('store 10: the result store\'s lock', function() {
  this.timeout(60000);
  const tmp = require('../helpers/test-tmp').forFile(['ch-store10-']);
  const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {encoding: 'utf8'}).stdout);

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
    const marker = path.join(DIR, 'holder.marker');
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

  it('a takeover left behind, two stalls at the points that broke the store lock: never two holders of the result store\'s lock', async () => {
    const dir = tmp.mkdtemp('ch-store10-');
    fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({pid: deadPid(), at: Date.now()}));
    fs.writeFileSync(path.join(dir, '.lock.takeover'), '1');
    const old = (Date.now() - 20000) / 1000;
    fs.utimesSync(path.join(dir, '.lock.takeover'), old, old);
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
      await until(dir, ['B-paused', 'B-holding', 'B-done']);
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

  it('a release refused (Windows: another program has the lock open): the next take of the lock succeeds, never a lock-out for good', async () => {
    const dir = tmp.mkdtemp('ch-store10-');
    const {withLock} = require(BLOBS).forTests;
    const store = require(STORE).forTests;
    if (store != null && typeof(store.refuseAsWindows) === 'function') store.refuseAsWindows(true);
    const unlink = fs.unlinkSync;
    let refused = 0;
    fs.unlinkSync = function(t) {
      if (path.basename(String(t)) === '.lock' && refused === 0) { refused++; throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${t}'`), {code: 'EPERM', syscall: 'unlink'}); }
      return unlink.apply(this, arguments);
    };
    try {
      await withLock(dir, async () => {});
      assert.strictEqual(refused, 1, 'the release was not refused as set up');
      await withLock(dir, async () => {});
    } finally {
      fs.unlinkSync = unlink;
      if (store != null && typeof(store.refuseAsWindows) === 'function') { store.refuseAsWindows(false); store.stopReleases(); }
    }
  });
  tmp.hooks();
});

// Issue #40, round 5 (re-review of #119): the always-denied set
// (lib/fs-broker/denied.js) on Windows, and its identities made sticky.
// - An outside path's location is computed with path.win32 there: with
//   POSIX rules the parent of C:\ch\moddata\.identity-secret was ".", so the
//   location was <cwd>/C:\ch\..., nothing matched, and audit let a rename,
//   unlink or lstat through.
// - Locations compare with "/" and "\" as one separator and case folded
//   (NTFS names are case-insensitive): D:\ch/auth.json-journal is
//   D:\ch\auth.json-journal.
// - Once a (dev, ino) has been on the list it stays for the server's life,
//   on every OS, so a denied file moved away is still refused at its new
//   name after the next refresh.
// Server-free; the win32 rules run on every OS with a host fs that answers
// for a D: drive.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {DeniedSet} = require('../../lib/fs-broker/denied');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {virtualFormFor} = require('../../lib/fs-broker/roots');
const tmp = require('../helpers/test-tmp');

// A Windows host as the broker sees it: the current drive is D:, these
// directories and files exist, and realpath answers in "\" form.
const DIRS = ['C:\\ch', 'C:\\ch\\moddata', 'D:\\ch'];
const FILES = {'C:\\ch\\moddata\\.identity-secret': {dev: 7, ino: 101}, 'C:\\ch\\auth.json': {dev: 7, ino: 102}};
const winKey = (p) => {
  let s = path.win32.resolve('D:\\', p);
  if (s.startsWith('\\') && !s.startsWith('\\\\')) s = `D:${s}`;
  return s.toLowerCase();
};
const hostFs = {
  realpath: async(p) => {
    const k = winKey(p);
    const hit = DIRS.concat(Object.keys(FILES)).find((d) => d.toLowerCase() === k);
    if (hit == null) throw Object.assign(new Error(`ENOENT ${p}`), {code: 'ENOENT'});
    return hit;
  },
  stat: async(p) => {
    const hit = Object.keys(FILES).find((f) => f.toLowerCase() === winKey(p));
    if (hit == null) throw Object.assign(new Error(`ENOENT ${p}`), {code: 'ENOENT'});
    return FILES[hit];
  }
};
hostFs.lstat = hostFs.stat;

const DENIED = ['C:\\ch\\auth.json', 'C:\\ch\\auth.json-journal', 'C:\\ch\\moddata\\.identity-secret', 'D:\\ch\\auth.json-journal', 'D:\\ch\\.identity-secret'];

describe('stdio 08: the always-denied set on Windows, and sticky identities (issue #40, round 5)', () => {
  describe('win32: an outside path is located with Windows rules', () => {
    const set = () => new DeniedSet(DENIED, {platform: 'win32', hostFs});

    it('(a) a drive path in "\\" form, not following (rename, unlink, lstat) and following', async () => {
      const d = set();
      for (const v of ['C:\\ch\\moddata\\.identity-secret', 'C:\\ch\\auth.json', 'c:\\CH\\Auth.json']) {
        assert.strictEqual(await d.matchesOutside(v, false), true, `${v} (no follow)`);
        assert.strictEqual(await d.matchesOutside(v, true), true, `${v} (follow)`);
      }
    });

    it('(b) a file that does not exist yet, drive-less, "/" drive and mixed forms', async () => {
      const d = set();
      for (const v of ['/ch/auth.json-journal', 'D:/ch/auth.json-journal', 'C:/ch/auth.json-journal', 'C:/ch\\auth.json-journal',
        '/ch/.identity-secret', 'C:/ch/moddata/.identity-secret', 'C:\\ch/moddata\\.identity-secret']) {
        assert.strictEqual(await d.matchesOutside(v, false), true, v);
      }
    });

    it('(b) the names Windows opens as a denied one: trailing dots or spaces, a stream suffix, another case', async () => {
      const d = set();
      for (const v of ['C:\\ch\\moddata\\.identity-secret.', 'C:\\ch\\moddata\\.identity-secret. .', 'C:\\ch\\moddata\\.identity-secret::$DATA',
        'C:\\ch\\moddata\\.identity-secret:x', 'C:\\ch\\auth.json-journal ', 'c:/CH/AUTH.JSON-JOURNAL']) {
        assert.strictEqual(await d.matchesOutside(v, false), true, v);
      }
    });

    // Round 7: identities are read as bigints (an NTFS file ID often passes
    // 2^53); an entry with ino 0 or no birthtime is matched while current
    // and never kept, so a later file given that dev+ino is not refused.
    it('an identity past 2^53 is kept exactly; ino 0 and a zero birthtime are matched while current, never kept', async () => {
      const big = 2n ** 60n + 1n;
      const files = {
        'C:\\ch\\auth.json': {dev: 9n, ino: 0n, birthtimeMs: 5n},
        'C:\\ch\\moddata\\.identity-secret': {dev: 9n, ino: big, birthtimeMs: 7n},
        'C:\\ch\\auth.db': {dev: 9n, ino: 44n, birthtimeMs: 0n}
      };
      const fake = {realpath: async(p) => p, stat: async(p, o) => {
        if (!files[p]) throw new Error('ENOENT');
        assert.deepStrictEqual(o, {bigint: true});
        return files[p];
      }};
      fake.lstat = fake.stat;
      const d = new DeniedSet(Object.keys(files), {platform: 'win32', hostFs: fake});
      assert.strictEqual(await d.matches('C:\\other', {dev: 9n, ino: 0n}), true, 'ino 0, current');
      assert.strictEqual(await d.matches('C:\\other', {dev: 9n, ino: 44n, birthtimeMs: 1}), true, 'no birthtime, current');
      assert.deepStrictEqual(Array.from(d.sticky.keys()), ['C:\\ch\\moddata\\.identity-secret']);
      Object.keys(files).forEach((k) => delete files[k]);
      d.at = 0;
      assert.strictEqual(await d.matches('C:\\moved', {dev: 9n, ino: big, birthtimeMs: 7}), true, 'the exact id, moved away');
      assert.strictEqual(await d.matches('C:\\other', {dev: 9n, ino: big - 1n, birthtimeMs: 7}), false, 'its Number-rounded neighbour');
      assert.strictEqual(await d.matches('C:\\other', {dev: 9n, ino: 44n, birthtimeMs: 1}), false, 'a zero-birthtime id, no longer current');
    });

    // A refresh that throws (a stat with no ino, say) fails the call that
    // waited on it, and the next refresh runs again.
    it('a refresh that throws is not kept: the next one runs', async () => {
      let bad = true;
      const fake = {realpath: async(p) => p, stat: async() => (bad ? {dev: 1n} : {dev: 1n, ino: 5n, birthtimeMs: 3n})};
      fake.lstat = fake.stat;
      const d = new DeniedSet(['C:\\ch\\auth.json'], {platform: 'win32', hostFs: fake});
      await assert.rejects(d.matches('C:\\x', null));
      bad = false;
      assert.strictEqual(await d.matches('C:\\x', {dev: 1n, ino: 5n, birthtimeMs: 3}), true);
    });

    it('not a denied file: a neighbour, another drive\'s', async () => {
      const d = set();
      for (const v of ['C:\\ch\\auth.json.bak', 'E:\\ch\\auth.json', '/ch/other']) assert.strictEqual(await d.matchesOutside(v, false), false, v);
    });

    it('the broker, audit: rename, unlink and lstat by a drive "\\" path are EACCES', async () => {
      const base = tmp.mkdtemp('ch-den-');
      try {
        const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
        Object.values(dirs).forEach((x) => fs.mkdirSync(x));
        const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: [], platform: 'win32'});
        await ns.prepare();
        const broker = new FsBroker({name: 'm', mode: 'audit', namespace: ns, cwd: '/app', denied: set()});
        const form = virtualFormFor('win32');
        const secret = form('C:\\ch\\moddata\\.identity-secret');
        try {
          await assert.rejects(broker.handle('rename', [secret, '/data/s']), {code: 'EACCES'});
          await assert.rejects(broker.handle('unlink', [form('C:\\ch\\auth.json')]), {code: 'EACCES'});
          await assert.rejects(broker.handle('lstat', [form('C:\\ch\\auth.json'), {}]), {code: 'EACCES'});
          await assert.rejects(broker.handle('open', [form('/ch/auth.json-journal'), 'w', 0o644]), {code: 'EACCES'});
          assert.deepStrictEqual(fs.readdirSync(dirs.data), []);
        } finally {
          await broker.closeAll();
        }
      } finally {
        tmp.remove(base);
      }
    });
  });

  describe('POSIX rules: unchanged locations', () => {
    // A file that does not exist yet, so only the location strings decide
    // (an existing file is also matched by its identity on a real host).
    it('a missing denied file: matched by its location; "\\" is part of a name off Windows', async () => {
      const base = tmp.mkdtemp('ch-den-');
      try {
        const file = path.join(base, 'auth.json-journal');
        const d = new DeniedSet([file], {platform: 'linux'});
        assert.strictEqual(await d.matchesOutside(file, false), true);
        if (process.platform !== 'win32') assert.strictEqual(await d.matchesOutside(`${base}\\auth.json-journal`, false), false);
      } finally {
        tmp.remove(base);
      }
    });
  });

  describe('sticky identities, every OS', () => {
    it('a denied file moved away is still refused at its new name after a refresh', async () => {
      const base = tmp.mkdtemp('ch-den-');
      try {
        const secret = path.join(base, '.identity-secret');
        const moved = path.join(base, 'moved');
        fs.writeFileSync(secret, 'x');
        const d = new DeniedSet([secret]);
        const ident = (p) => { const st = fs.lstatSync(p, {bigint: true}); return {dev: st.dev, ino: st.ino, birthtimeMs: Number(st.birthtimeMs)}; };
        assert.strictEqual(await d.matches(secret, ident(secret)), true);
        fs.renameSync(secret, moved);
        d.at = 0;   // the next refresh, now
        assert.strictEqual(await d.matches(moved, ident(moved)), true, 'the moved file, after a refresh');
        // a new file at the old path is denied too, by its path
        fs.writeFileSync(secret, 'y');
        assert.strictEqual(await d.matches(secret, ident(secret)), true);
      } finally {
        tmp.remove(base);
      }
    });

    // Round 6: sticky only for the main files, at most the last 2 per path,
    // each keyed by dev, ino and a non-zero birthtime.
    const ident = (p) => { const st = fs.lstatSync(p, {bigint: true}); return {dev: st.dev, ino: st.ino, birthtimeMs: Number(st.birthtimeMs)}; };
    const stickyCount = (d) => Array.from(d.sticky.values()).reduce((n, ring) => n + ring.length, 0);

    it('at most the last 2 identities per path: a secret rewritten 5 times keeps 2', async () => {
      const base = tmp.mkdtemp('ch-den-');
      try {
        const secret = path.join(base, '.identity-secret');
        const d = new DeniedSet([secret]);
        const kept = [];
        for (let i = 0; i < 5; i++) {
          fs.writeFileSync(`${secret}.new`, String(i));
          fs.renameSync(`${secret}.new`, secret);   // a new inode at the path, as a provider rewrites
          kept.push(`${base}/keep-${i}`);
          fs.linkSync(secret, kept[i]);             // holds the inode, so it is not reused
          d.at = 0;
          assert.strictEqual(await d.matches(secret, ident(secret)), true);
        }
        assert.ok(stickyCount(d) <= 2, `${stickyCount(d)} sticky`);
        fs.rmSync(secret);
        d.at = 0;
        assert.strictEqual(await d.matches(kept[4], ident(kept[4])), true, 'the last one');
        assert.strictEqual(await d.matches(kept[0], ident(kept[0])), false, 'the first one, rotated out');
      } finally {
        tmp.remove(base);
      }
    });

    it('a side file (-wal, -shm, -journal) is matched while current, never sticky', async () => {
      const base = tmp.mkdtemp('ch-den-');
      try {
        const db = path.join(base, 'auth.db');
        const journal = `${db}-journal`;
        fs.writeFileSync(db, 'db');
        fs.writeFileSync(journal, 'j');
        const d = new DeniedSet([db, `${db}-wal`, `${db}-shm`, journal]);
        const moved = path.join(base, 'moved');
        assert.strictEqual(await d.matches(journal, ident(journal)), true);
        assert.strictEqual(d.sticky.has(journal), false);
        assert.strictEqual(d.sticky.has(db), true);
        fs.renameSync(journal, moved);
        d.at = 0;
        assert.strictEqual(await d.matches(moved, ident(moved)), false, 'a side file moved away is not kept');
      } finally {
        tmp.remove(base);
      }
    });

    it('an identity with a birthtime matches only a file with that birthtime', async () => {
      const base = tmp.mkdtemp('ch-den-');
      try {
        const secret = path.join(base, '.identity-secret');
        fs.writeFileSync(secret, 'x');
        const d = new DeniedSet([secret]);
        const id = ident(secret);
        assert.strictEqual(await d.matches(null, id), true);
        fs.rmSync(secret);
        d.at = 0;
        await d.matches(null, null);
        if (id.birthtimeMs > 0) {
          assert.strictEqual(await d.matches(null, Object.assign({}, id, {birthtimeMs: id.birthtimeMs + 1000})), false, 'a reused inode');
        }
        assert.strictEqual(await d.matches(null, id), true, 'the file itself, moved away');
      } finally {
        tmp.remove(base);
      }
    });
  });

  // Round 6: default APFS is case-insensitive, so darwin folds case too.
  describe('darwin: case folded', () => {
    it('Auth.json-journal is refused under audit (a missing auth.json-journal)', async () => {
      const base = tmp.mkdtemp('ch-den-');
      try {
        const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
        Object.values(dirs).forEach((x) => fs.mkdirSync(x));
        const denied = new DeniedSet([path.join(base, 'auth.json-journal')], {platform: 'darwin'});
        assert.strictEqual(await denied.matchesOutside(path.join(base, 'Auth.json-journal'), false), true);
        // Through the broker, a POSIX host path is a module's outside path;
        // a Windows one (D:\\...) is not a darwin path at all.
        if (process.platform === 'win32') return;
        const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: [], platform: 'darwin'});
        await ns.prepare();
        const broker = new FsBroker({name: 'm', mode: 'audit', namespace: ns, cwd: '/app', denied});
        try {
          await assert.rejects(broker.handle('open', [path.join(base, 'Auth.json-journal'), 'w', 0o644]), {code: 'EACCES'});
          assert.ok(!fs.readdirSync(base).some((n) => /journal/i.test(n)));
        } finally {
          await broker.closeAll();
        }
      } finally {
        tmp.remove(base);
      }
    });
  });

  // Round 6: on win32 the broker splits a root's host path with Windows'
  // rules, and a real path is in a root by either separator.
  describe('win32: host paths in "\\" form', () => {
    it('a "\\"-form declared root: its parent and children split, and real paths under it are in it', async () => {
      const n = createNamespace({moduleRoot: 'D:\\m\\mod', dataDir: 'D:\\m\\data', tmpDir: 'D:\\m\\tmp',
        declared: [{path: 'C:\\decl', access: 'rw'}], protectedPaths: [], platform: 'win32'});
      await n.prepare();
      assert.strictEqual(n.hostPath.dirname('C:\\decl'), 'C:\\');
      assert.strictEqual(n.hostPath.join(n.hostPath.dirname('C:\\decl'), n.hostPath.basename('C:\\decl')), 'C:\\decl');
      assert.strictEqual(n.rootForReal('C:\\decl').name, 'declared');
      assert.strictEqual(n.rootForReal('C:\\decl\\a\\b').name, 'declared');
      assert.strictEqual(n.rootForReal('D:\\m\\data\\a\\b').name, 'data');
      assert.strictEqual(n.rootForReal('D:\\m\\data/a').name, 'data');
      assert.strictEqual(n.rootForReal('D:\\m\\database\\x'), null);
      assert.strictEqual(n.rootForReal('C:\\declx'), null);
      assert.strictEqual(n.toVirtual('D:\\m\\data\\a\\b'), '/data/a/b');
      // the drive letter's case only: d: is D:, any other letter's case counts
      assert.strictEqual(n.rootForReal('d:\\m\\data\\a').name, 'data');
      assert.strictEqual(n.rootForReal('D:\\M\\data\\a'), null);
    });

    it('a "\\"-form declared path inside, or holding, a protected path is refused', async () => {
      const n = createNamespace({moduleRoot: 'D:\\m\\mod', dataDir: 'D:\\m\\data', tmpDir: 'D:\\m\\tmp',
        declared: [{path: 'C:\\ch\\store\\sub', access: 'rw'}, {path: 'C:\\ch', access: 'r'}, {path: 'C:\\other', access: 'r'}],
        protectedPaths: ['C:\\ch\\store'], platform: 'win32'});
      await n.prepare();
      assert.deepStrictEqual(n.refused.map((r) => r.path), ['C:\\ch\\store\\sub', 'C:\\ch']);
      assert.ok(n.roots.some((r) => r.vroot === 'C:\\other'));
    });

    it('POSIX: "\\" is part of a name, and the host path functions are POSIX', async () => {
      const n = createNamespace({moduleRoot: '/m/mod', dataDir: '/m/data', tmpDir: '/m/tmp', declared: [], protectedPaths: [], platform: 'linux'});
      await n.prepare();
      assert.strictEqual(n.hostPath, path.posix);
      // a sibling named data\x, not a child of /m/data
      assert.strictEqual(n.rootForReal('/m/data\\x'), null);
      assert.strictEqual(n.rootForReal('/m/data/x').name, 'data');
      assert.strictEqual(n.toVirtual('/m/data/a\\b'), '/data/a\\b');
    });
  });
});

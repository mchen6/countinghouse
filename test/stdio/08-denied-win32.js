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

    it('a stat that cannot name one file (ino 0, or past 2^53) is matched while current, never kept', async () => {
      const files = {'C:\\ch\\auth.json': {dev: 9, ino: 0}, 'C:\\ch\\moddata\\.identity-secret': {dev: 9, ino: 2 ** 60}};
      const fake = {realpath: async(p) => p, stat: async(p) => { if (files[p]) return files[p]; throw new Error('ENOENT'); }};
      fake.lstat = fake.stat;
      const d = new DeniedSet(Object.keys(files), {platform: 'win32', hostFs: fake});
      assert.strictEqual(await d.matches('C:\\other', {dev: 9, ino: 0}), true, 'current');
      assert.deepStrictEqual(Array.from(d.sticky), []);
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

  describe('POSIX: unchanged locations', () => {
    it('"\\" is part of a name, and case matters', async () => {
      const base = tmp.mkdtemp('ch-den-');
      try {
        const file = path.join(base, 'auth.json');
        fs.writeFileSync(file, '{}');
        const d = new DeniedSet([file], {platform: 'linux'});
        assert.strictEqual(await d.matchesOutside(file, false), true);
        assert.strictEqual(await d.matchesOutside(path.join(base, 'Auth.json'), false), false);
        assert.strictEqual(await d.matchesOutside(`${base}\\auth.json`, false), false);
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
        const ident = (p) => { const st = fs.lstatSync(p); return {dev: st.dev, ino: st.ino}; };
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
  });
});

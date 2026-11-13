// Issue #40, round 4 (review of #119): on Windows "\" is a separator. A path
// the patch left in "\" form reached the broker, whose namespace is POSIX and
// takes "\" as part of a name, while the OS took it as a separator. So:
// (a) the patch gives every path, string or Buffer, relative ones included,
//     the "/" form, except a drive-qualified, UNC or device path
//     (lib/fs-broker/roots.js virtualFormFor);
// (b) the broker refuses (EACCES) a namespace path that still holds a "\",
//     and takes a path with a drive letter ("C:..\x" too) as outside, never
//     as a name under the cwd (lib/fs-broker/namespace.js, broker.js place);
// and a boot or resolving grant may not be a drive's root (roots.js).
// Server-free; the win32 rules run on every OS (the stdio job: ubuntu, macos,
// windows).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {virtualFormFor, assertGrantRoots} = require('../../lib/fs-broker/roots');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const tmp = require('../helpers/test-tmp');

// The review's inputs, as a module would pass them, cwd /app.
const ESCAPES = [
  'x\\..\\..\\..\\..\\Windows\\win.ini',
  '//data/x\\..\\..\\..\\..\\evil.txt',
  '/./data/x\\..\\..\\..\\..\\evil.txt',
  '\\\\app\\..\\..\\x'
];

describe('stdio 07: "\\" paths on Windows (issue #40, round 4)', () => {
  describe('(a) the patch: every path in "/" form, but a drive, UNC or device path', () => {
    const form = virtualFormFor('win32');

    it('converts relative paths, look-alikes and any "\\" mix', () => {
      assert.strictEqual(form('x\\..\\..\\..\\..\\Windows\\win.ini'), 'x/../../../../Windows/win.ini');
      assert.strictEqual(form('//data/x\\..\\..\\..\\..\\evil.txt'), '//data/x/../../../../evil.txt');
      assert.strictEqual(form('/./data/x\\..\\..\\..\\..\\evil.txt'), '/./data/x/../../../../evil.txt');
      assert.strictEqual(form('handlers\\a.js'), 'handlers/a.js');
      assert.strictEqual(form('\\application\\x'), '/application/x');
      assert.strictEqual(form('\\app\\package.json'), '/app/package.json');
      assert.strictEqual(form('/\\host\\share'), '//host/share');
    });

    it('a drive letter not followed by a separator is not a drive-qualified path: C:..\\x is converted', () => {
      assert.strictEqual(form('C:..\\x'), 'C:../x');
      assert.strictEqual(form('C:x\\y'), 'C:x/y');
    });

    it('keeps a drive-qualified, UNC or device path as given', () => {
      for (const v of ['D:\\a\\b', 'd:/a\\b', '\\\\srv\\share\\x', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', '\\\\app\\..\\..\\x']) {
        assert.strictEqual(form(v), v, v);
      }
    });

    it('converts a Buffer or Uint8Array path the same way, and keeps a drive one', () => {
      assert.deepStrictEqual(form(Buffer.from('x\\..\\..\\Windows\\win.ini')), Buffer.from('x/../../Windows/win.ini'));
      assert.deepStrictEqual(Buffer.from(form(new Uint8Array(Buffer.from('\\data\\a')))), Buffer.from('/data/a'));
      const drive = Buffer.from('D:\\x');
      assert.strictEqual(form(drive), drive);
      const unc = Buffer.from('\\\\srv\\share');
      assert.strictEqual(form(unc), unc);
      // UTF-8 never uses 0x5C inside a multi-byte character, so the rest is kept.
      assert.deepStrictEqual(form(Buffer.from('\\data\\é\\ü')), Buffer.from('/data/é/ü'));
    });

    it('leaves anything that is not a path alone', () => {
      const u = new URL('file:///app/x');
      assert.strictEqual(form(u), u);
      assert.strictEqual(form(3), 3);
      assert.strictEqual(form(undefined), undefined);
    });

    it('POSIX: every value unchanged, the same object', () => {
      for (const platform of ['linux', 'darwin']) {
        const posix = virtualFormFor(platform);
        for (const v of ESCAPES.concat(['C:..\\x', 'a\\b'])) assert.strictEqual(posix(v), v, `${platform} ${v}`);
        const b = Buffer.from('a\\b');
        assert.strictEqual(posix(b), b);
      }
    });
  });

  describe('(b) the broker: a namespace path holding "\\" is refused; a drive path is outside', () => {
    let base = null;
    let dirs = null;
    beforeEach(() => {
      base = tmp.mkdtemp('ch-bs-');
      dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
      Object.values(dirs).forEach((d) => fs.mkdirSync(d));
    });
    afterEach(() => { tmp.remove(base); base = null; });

    const namespace = async (platform) => {
      const n = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: [], platform});
      await n.prepare();
      return n;
    };
    const insideRoot = (r) => r.kind !== 'root' || (r.host === r.root.host || r.host.startsWith(`${r.root.host}/`)) && !r.host.includes('\\');

    it('win32: the review\'s inputs, in the form the patch gives them, never name a host path outside its root', async () => {
      const n = await namespace('win32');
      const form = virtualFormFor('win32');
      for (const v of ESCAPES) {
        const r = n.resolve(form(v), '/app');
        assert.ok(r.kind === 'outside' || r.kind === 'refused', `${v}: ${JSON.stringify({kind: r.kind, virtual: r.virtual})}`);
        assert.ok(insideRoot(r), v);
      }
      assert.strictEqual(n.resolve(form('\\\\app\\..\\..\\x'), '/app').kind, 'refused');
    });

    it('win32: a path with a drive letter is outside, drive-relative ones too, never a name under /app', async () => {
      const n = await namespace('win32');
      const form = virtualFormFor('win32');
      for (const v of ['C:..\\x', 'C:x', 'D:\\Windows\\win.ini', 'd:/x']) {
        const r = n.resolve(form(v), '/app');
        assert.strictEqual(r.kind, 'outside', v);
        assert.strictEqual(r.virtual, form(v), v);
      }
    });

    it('win32: a namespace path in either form still maps into its root', async () => {
      const n = await namespace('win32');
      const form = virtualFormFor('win32');
      const r = n.resolve(form('\\data\\a.txt'), '/app');
      assert.strictEqual(r.kind, 'root');
      assert.strictEqual(r.host, `${dirs.data}/a.txt`);
      assert.strictEqual(n.resolve(form('handlers\\a.js'), '/app').host, `${dirs.app}/handlers/a.js`);
    });

    it('POSIX: unchanged, "\\" is part of a name and C: is a file name', async () => {
      const n = await namespace('linux');
      assert.strictEqual(n.resolve('/app/a\\b', '/app').host, `${dirs.app}/a\\b`);
      assert.strictEqual(n.resolve('C:..\\x', '/app').host, `${dirs.app}/C:..\\x`);
    });

    for (const mode of ['enforce', 'audit']) {
      it(`win32, ${mode}: the broker refuses each input and writes nothing`, async () => {
        const broker = new FsBroker({name: 'm', mode, namespace: await namespace('win32'), cwd: '/app'});
        const form = virtualFormFor('win32');
        try {
          await assert.rejects(broker.handle('open', [form('\\\\app\\..\\..\\x'), 'w', 0o644]), {code: 'EACCES'});
          await assert.rejects(broker.handle('open', ['/data/a\\b', 'w', 0o644]), {code: 'EACCES'});
          if (mode === 'enforce') {
            for (const v of ESCAPES.slice(0, 3).concat(['C:..\\x'])) {
              await assert.rejects(broker.handle('open', [form(v), 'w', 0o644]), (e) => ['ENOENT', 'EACCES'].includes(e.code), v);
            }
          }
          for (const d of Object.values(dirs)) assert.deepStrictEqual(fs.readdirSync(d), [], d);
        } finally {
          await broker.closeAll();
        }
      });
    }

    // Review: a symlink target is checked with POSIX rules; one the OS
    // resolves by a drive, a share or "\" is refused as the link rules
    // refuse (EPERM). POSIX keeps "\" and ":" as name characters.
    it('win32: a symlink target with a drive letter, a ":" or a "\\" is refused, and no link is made', async () => {
      const broker = new FsBroker({name: 'm', mode: 'enforce', namespace: await namespace('win32'), cwd: '/app'});
      const form = virtualFormFor('win32');
      try {
        for (const t of ['D:\\secret', 'd:/secret', '\\\\?\\C:\\Windows', '\\\\srv\\share\\x', 'C:..\\x']) {
          await assert.rejects(broker.handle('symlink', [form(t), '/data/l']), {code: 'EPERM'}, t);
        }
        assert.deepStrictEqual(fs.readdirSync(dirs.data), []);
      } finally {
        await broker.closeAll();
      }
    });
  });

  describe('a boot or resolving grant may not be a drive\'s root', () => {
    it('win32: D:\\ and d:\\ are refused; a directory on the drive is not', () => {
      const check = assertGrantRoots('win32');
      assert.throws(() => check(['D:\\a\\lib', 'D:\\']), /drive's root/);
      assert.throws(() => check(['d:\\']), /drive's root/);
      assert.throws(() => check(['\\\\?\\D:\\']), /drive's root/);
      assert.throws(() => check(['\\\\srv\\share']), /drive's root/);
      assert.deepStrictEqual(check(['\\\\srv\\share\\ch\\lib']), ['\\\\srv\\share\\ch\\lib']);
      assert.deepStrictEqual(check(['D:\\a\\lib', 'D:\\a\\package.json']), ['D:\\a\\lib', 'D:\\a\\package.json']);
    });

    it('POSIX: unchanged', () => {
      const roots = ['/srv/ch/lib', '/'];
      assert.strictEqual(assertGrantRoots('linux')(roots), roots);
    });
  });
});

// Issue #40, follow-up to #154: on Windows an 8.3 short name (PINS~1 for
// .pins, PROGRA~1 for "Program Files") names the same directory as its long
// name. The write guards (DeniedTree for .pins/, AncestorGuard for the
// directories above the pin records, the identity secret and the manifest)
// match by path, and a no-follow operation (rename, rmdir) kept its leaf as
// written, so renaming the guarded directory by its short name got past
// them under audit. lib/fs-broker/denied.js locateOutside now also gives an
// existing leaf that is not a link at its real path (the long name), and
// the guards decide on both names; a link's leaf stays the link, as a
// no-follow operation acts on the link.
// The expansion runs with a stand-in host fs on every OS; a real 8.3 name on
// the Windows runner, where C: makes them (skipped when it does not).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const {DeniedSet, DeniedTree, AncestorGuard, locateOutside} = require('../../lib/fs-broker/denied');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const tmp = require('../helpers/test-tmp');

describe('stdio 10: 8.3 short names at the write guards (issue #40)', () => {
  describe('with a stand-in Windows host fs, every OS', () => {
    // C: makes short names; realpath answers the long one.
    const LONG = {'C:\\ch\\moddata\\PINS~1': 'C:\\ch\\moddata\\.pins', 'C:\\PROGRA~1': 'C:\\Program Files', 'C:\\CHDIR~1': 'C:\\ch',
      'C:\\ch\\moddata\\LOCKED~1': 'C:\\ch\\moddata\\.pins', 'C:\\ch\\moddata\\LINK~1': null};
    const dir = {isSymbolicLink: () => false, dev: 1n, ino: 2n, birthtimeMs: 3n};
    const link = {isSymbolicLink: () => true, dev: 1n, ino: 4n, birthtimeMs: 3n};
    const hostFs = {
      realpath: async(p) => {
        if (LONG[p] != null) return LONG[p];
        if (['C:\\ch\\moddata', 'C:\\ch', 'C:\\'].includes(p)) return p;
        throw Object.assign(new Error(`ENOENT ${p}`), {code: 'ENOENT'});
      },
      lstat: async(p) => {
        if (p === 'C:\\ch\\moddata\\LINK~1') return link;
        if (p === 'C:\\ch\\moddata\\LOCKED~1') throw Object.assign(new Error(`EPERM ${p}`), {code: 'EPERM'});
        if (p in LONG) return dir;
        throw Object.assign(new Error(`ENOENT ${p}`), {code: 'ENOENT'});
      }
    };
    hostFs.stat = hostFs.lstat;
    const rules = {platform: 'win32', hostFs};
    const at = (v) => locateOutside(v, false, new DeniedSet([], rules).rules);

    it('a no-follow leaf that is not a link is located as written, with its long name as real', async () => {
      assert.deepStrictEqual([(await at('C:\\ch\\moddata\\PINS~1')).loc, (await at('C:\\ch\\moddata\\PINS~1')).real],
        ['C:\\ch\\moddata\\PINS~1', 'C:\\ch\\moddata\\.pins']);
      assert.strictEqual((await at('C:\\PROGRA~1')).real, 'C:\\Program Files');
      assert.strictEqual((await at('C:\\ch\\moddata\\LOCKED~1')).real, 'C:\\ch\\moddata\\.pins', 'an lstat failing EPERM still asks');
      assert.strictEqual((await at('C:\\ch\\moddata\\LINK~1')).real, null, 'a link stays the link');
      assert.strictEqual((await at('C:\\ch\\moddata\\new')).real, null, 'a missing leaf');
      assert.strictEqual((await locateOutside('C:\\ch\\moddata\\PINS~1', false, new DeniedSet([], {platform: 'linux', hostFs}).rules)).real, null,
        'not on POSIX');
    });

    it('the guards refuse the short name: .pins as PINS~1, an ancestor as PROGRA~1', async () => {
      const tree = new DeniedTree('C:\\ch\\moddata\\.pins', rules);
      assert.strictEqual(await tree.matches((await at('C:\\ch\\moddata\\PINS~1')).real), true);
      const guard = new AncestorGuard(['C:\\Program Files\\ch\\.identity-secret'], rules);
      assert.strictEqual(await guard.matches((await at('C:\\PROGRA~1')).real), true);
    });

    it('the broker, audit: rename from or onto PINS~1, rmdir PINS~1, rename an ancestor as CHDIR~1 are EACCES', async () => {
      const base = tmp.mkdtemp('ch-short-');
      try {
        const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
        Object.values(dirs).forEach((x) => fs.mkdirSync(x));
        fs.writeFileSync(path.join(dirs.data, 'x'), 'x');
        const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: [], platform: 'win32'});
        await ns.prepare();
        ns.hostPath = path;   // the win32 rules over this machine's own disk (as in stdio 07)
        const broker = new FsBroker({name: 'm', mode: 'audit', namespace: ns, cwd: '/app', pinsDir: 'C:\\ch\\moddata\\.pins',
          denied: new DeniedSet([], rules)});
        try {
          await assert.rejects(broker.handle('rename', ['C:\\ch\\moddata\\PINS~1', 'C:\\ch\\moddata\\gone']), {code: 'EACCES'}, 'source');
          await assert.rejects(broker.handle('rename', ['/data/x', 'C:\\ch\\moddata\\PINS~1']), {code: 'EACCES'}, 'destination');
          await assert.rejects(broker.handle('rmdir', ['C:\\ch\\moddata\\PINS~1']), {code: 'EACCES'}, 'rmdir');
          await assert.rejects(broker.handle('rename', ['C:\\CHDIR~1', 'C:\\gone']), {code: 'EACCES'}, 'an ancestor');
          assert.ok(fs.existsSync(path.join(dirs.data, 'x')));
        } finally {
          await broker.closeAll();
        }
      } finally {
        tmp.remove(base);
      }
    });
  });

  describe('POSIX: unchanged', () => {
    it('an existing leaf is located as written, with no second name; a link\'s leaf is the link', async function() {
      if (process.platform === 'win32') this.skip();
      const base = tmp.mkdtemp('ch-short-');
      try {
        fs.mkdirSync(path.join(base, 'd'));
        fs.symlinkSync(path.join(base, 'd'), path.join(base, 'l'));
        const d = await locateOutside(path.join(base, 'd'), false);
        assert.deepStrictEqual([d.loc, d.real], [path.join(base, 'd'), null]);
        assert.strictEqual((await locateOutside(path.join(base, 'l'), false)).loc, path.join(base, 'l'));
      } finally {
        tmp.remove(base);
      }
    });
  });

  describe('Windows: a real 8.3 name', () => {
    // C: (os.tmpdir) makes short names by default; the test is skipped when
    // the volume does not.
    const shortName = (parent, long) => {
      const out = childProcess.execFileSync('cmd', ['/c', 'dir', '/x', '/a:d', parent], {encoding: 'utf8'});
      const m = out.split(/\r?\n/).map((l) => l.match(/<DIR>\s+(\S+)\s+(.+?)\s*$/)).find((x) => x != null && x[2] === long);
      return m == null ? null : m[1];
    };

    it('renaming .pins by its short name is EACCES under audit, and the directory stays', async function() {
      if (process.platform !== 'win32') this.skip();
      const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-short-')));
      try {
        const pins = path.join(base, '.pins');
        fs.mkdirSync(pins);
        const short = shortName(base, '.pins');
        if (short == null) this.skip();
        const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
        Object.values(dirs).forEach((x) => fs.mkdirSync(x));
        const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
        await ns.prepare();
        const broker = new FsBroker({name: 'm', mode: 'audit', namespace: ns, cwd: '/app', pinsDir: pins, denied: new DeniedSet([])});
        try {
          await assert.rejects(broker.handle('rename', [path.join(base, short), path.join(base, 'gone')]), {code: 'EACCES'}, short);
          assert.ok(fs.existsSync(pins));
          assert.ok(!fs.existsSync(path.join(base, 'gone')));
        } finally {
          await broker.closeAll();
        }
      } finally {
        fs.rmSync(base, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
      }
    });
  });
});

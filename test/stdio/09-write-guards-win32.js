// Issue #40, round 7: #151's write guards (lib/fs-broker/denied.js) with the
// host's path rules. AncestorGuard refuses writes to every directory above
// the pin records, the identity secret and the module's manifest; DeniedTree
// refuses writes into the pin records' directory (.pins/). On Windows both
// split with path.win32 and compare with the same key as DeniedSet ("/" and
// "\" one separator; case, trailing dots and spaces, and a ":stream" suffix
// folded), so a case variant of an ancestor or of .pins is refused too. On
// every OS both resolve real paths with the host's realpath.
// Server-free; the win32 rules run on every OS.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {DeniedSet, DeniedTree, AncestorGuard} = require('../../lib/fs-broker/denied');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {virtualFormFor} = require('../../lib/fs-broker/roots');
const tmp = require('../helpers/test-tmp');

const SECRET = 'C:\\ch\\moddata\\.identity-secret';
const PINS = 'C:\\ch\\moddata\\.pins';

describe('stdio 09: the write guards with the host\'s path rules (issue #40, round 7)', () => {
  describe('win32', () => {
    it('AncestorGuard: every directory above, in any case, separator or trailing-dot spelling', async () => {
      const g = new AncestorGuard([SECRET], {platform: 'win32'});
      for (const v of ['C:\\ch\\moddata', 'C:\\CH\\MODDATA', 'c:/ch/moddata', 'C:\\ch\\moddata. ', 'C:\\ch', 'c:\\Ch\\', 'C:\\']) {
        assert.strictEqual(await g.matches(v), true, v);
      }
      for (const v of ['C:\\ch\\moddata\\sub', 'C:\\chx', 'D:\\ch\\moddata', SECRET]) assert.strictEqual(await g.matches(v), false, v);
    });

    it('DeniedTree: .pins and anything under it, in any case or separator', async () => {
      const t = new DeniedTree(PINS, {platform: 'win32'});
      for (const v of ['c:/ch/moddata/.PINS/x.json', 'C:\\ch\\moddata\\.pins', 'C:\\CH\\MODDATA\\.Pins\\a\\b.json', 'C:\\ch\\moddata\\.pins.\\x']) {
        assert.strictEqual(await t.matches(v), true, v);
      }
      for (const v of ['C:\\ch\\moddata\\.pinsx\\a', 'C:\\ch\\moddata', 'D:\\ch\\moddata\\.pins\\x']) assert.strictEqual(await t.matches(v), false, v);
    });

    it('the broker, audit: renaming C:\\CH\\MODDATA and writing c:/ch/moddata/.PINS/x.json are EACCES', async () => {
      const base = tmp.mkdtemp('ch-guard-');
      try {
        const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
        Object.values(dirs).forEach((x) => fs.mkdirSync(x));
        const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: [], platform: 'win32'});
        await ns.prepare();
        const broker = new FsBroker({name: 'm', mode: 'audit', namespace: ns, cwd: '/app', pinsDir: PINS,
          denied: new DeniedSet([SECRET], {platform: 'win32'})});
        const form = virtualFormFor('win32');
        try {
          await assert.rejects(broker.handle('rename', [form('C:\\CH\\MODDATA'), '/data/x']), {code: 'EACCES'});
          await assert.rejects(broker.handle('open', [form('c:/ch/moddata/.PINS/x.json'), 'w', 0o644]), {code: 'EACCES'});
          assert.deepStrictEqual(fs.readdirSync(dirs.data), []);
        } finally {
          await broker.closeAll();
        }
      } finally {
        tmp.remove(base);
      }
    });
  });

  describe('every OS: real paths through the host\'s realpath', () => {
    it('a guard named through a symlinked parent matches the real directories', async function() {
      const base = tmp.mkdtemp('ch-guard-');
      try {
        const real = path.join(base, 'real');
        const link = path.join(base, 'link');
        fs.mkdirSync(path.join(real, '.pins'), {recursive: true});
        try { fs.symlinkSync(real, link, 'dir'); } catch (e) { if (e.code === 'EPERM') this.skip(); throw e; }
        const g = new AncestorGuard([path.join(link, '.identity-secret')]);
        assert.strictEqual(await g.matches(real), true, 'the real parent');
        const t = new DeniedTree(path.join(link, '.pins'));
        assert.strictEqual(await t.matches(path.join(real, '.pins', 'x.json')), true, 'under the real .pins');
      } finally {
        tmp.remove(base);
      }
    });

    it('POSIX: exact names, "\\" part of a name', async function() {
      if (process.platform === 'win32') this.skip();
      const t = new DeniedTree('/srv/ch/.pins', {platform: 'linux'});
      assert.strictEqual(await t.matches('/srv/ch/.pins/x'), true);
      assert.strictEqual(await t.matches('/srv/ch/.PINS/x'), false);
      assert.strictEqual(await t.matches('/srv/ch/.pins\\x'), false);
      const g = new AncestorGuard(['/srv/ch/moddata/.identity-secret'], {platform: 'linux'});
      assert.strictEqual(await g.matches('/srv/ch/moddata'), true);
      assert.strictEqual(await g.matches('/srv/ch/MODDATA'), false);
    });
  });
});

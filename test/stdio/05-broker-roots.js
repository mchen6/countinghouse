// Issue #40, the Windows worker boot: lib/fs-broker/roots.js underFor, the
// worker fs patch's "is this path a granted root or inside one". On Windows
// the boot refused countinghouse's own lib\cli-options.js because the check
// joined the root with "/" (the #114 trace: under by "/": false, by path.sep:
// true). The rule for each platform is a pure function, so these run on every
// system (the stdio job: ubuntu, macos, windows).
const assert = require('assert');
const {underFor, virtualFormFor} = require('../../lib/fs-broker/roots');
const {toVirtualPath} = require('../../lib/fs-broker/namespace');

describe('stdio 05: a path under the granted roots (issue #40)', () => {
  describe('POSIX: as before', () => {
    const under = underFor('linux');
    it('a root and its children are under it; "/" joins them', () => {
      assert.strictEqual(under('/a/lib', ['/a/lib']), true);
      assert.strictEqual(under('/a/lib/x.js', ['/a/lib']), true);
      assert.strictEqual(under('/a/lib/deep/x.js', ['/b', '/a/lib']), true);
    });
    it('nothing else: a name that only extends the root, another tree, another case, a backslash', () => {
      assert.strictEqual(under('/a/library/x.js', ['/a/lib']), false);
      assert.strictEqual(under('/b/lib/x.js', ['/a/lib']), false);
      assert.strictEqual(under('/A/lib/x.js', ['/a/lib']), false);
      assert.strictEqual(under('/a/Countinghouse/lib/x.js', ['/a/countinghouse/lib']), false);
      assert.strictEqual(under('/a/lib\\x.js', ['/a/lib']), false);
      assert.strictEqual(under('/a/lib/x.js', []), false);
    });
    it('is the expression the patch had before (byte-identical on POSIX)', () => {
      assert.strictEqual(under.toString(), '(s, roots) => roots.some((r) => s === r || s.startsWith(`${r}/`))');
      assert.strictEqual(underFor('darwin').toString(), under.toString());
    });
  });

  describe('Windows: by "\\", case as given but the drive letter\'s', () => {
    const under = underFor('win32');
    it('a root and its children are under it, as the loader gives them (the #114 case)', () => {
      const roots = ['D:\\a\\countinghouse\\countinghouse\\lib', 'D:\\a\\countinghouse\\countinghouse\\package.json'];
      assert.strictEqual(under('D:\\a\\countinghouse\\countinghouse\\lib\\cli-options.js', roots), true);
      assert.strictEqual(under('D:\\a\\countinghouse\\countinghouse\\lib', roots), true);
      assert.strictEqual(under('D:\\a\\countinghouse\\countinghouse\\package.json', roots), true);
    });
    it('a drive letter\'s case does not matter', () => {
      assert.strictEqual(under('d:\\a\\lib\\x.js', ['D:\\a\\lib']), true);
      assert.strictEqual(under('D:\\a\\lib\\x.js', ['d:\\a\\lib']), true);
    });
    it('any other letter\'s case does: a path differing from its root only there is not under it (a case-sensitive directory holds both)', () => {
      assert.strictEqual(under('D:\\a\\Countinghouse\\lib\\x.js', ['D:\\a\\countinghouse\\lib']), false);
      assert.strictEqual(under('D:\\A\\LIB\\x.js', ['D:\\a\\lib']), false);
      assert.strictEqual(under('C:\\Users\\RUNNERADMIN\\x', ['C:\\Users\\runneradmin']), false);
    });
    it('a drive\'s root and a UNC share root are not given a second "\\"', () => {
      assert.strictEqual(under('D:\\x.js', ['D:\\']), true);
      assert.strictEqual(under('\\\\srv\\share\\x.js', ['\\\\srv\\share']), true);
    });
    it('nothing else: a name that only extends the root, another tree, another drive, "/" as a separator', () => {
      assert.strictEqual(under('D:\\a\\library\\x.js', ['D:\\a\\lib']), false);
      assert.strictEqual(under('D:\\b\\lib\\x.js', ['D:\\a\\lib']), false);
      assert.strictEqual(under('E:\\a\\lib\\x.js', ['D:\\a\\lib']), false);
      assert.strictEqual(under('D:\\a\\lib/x.js', ['D:\\a\\lib']), false);
      assert.strictEqual(under('D:\\a\\lib\\x.js', []), false);
    });
  });

  // Round 2: a namespace path (/app, /data, /tmp) built with Windows' path
  // functions arrives in "\" form; the patch gives it the POSIX form before
  // anything else sees it, so the broker's namespace and ".." checks see what
  // they see for the "/" form.
  describe('a namespace path\'s form for the broker', () => {
    const asBroker = (form, v) => toVirtualPath(form(v), '/app');

    it('Windows: \\app\\package.json is the module\'s /app/package.json', () => {
      const form = virtualFormFor('win32');
      assert.strictEqual(form('\\app\\package.json'), '/app/package.json');
      assert.strictEqual(asBroker(form, '\\app\\package.json'), '/app/package.json');
      assert.strictEqual(form('\\data\\a.txt'), '/data/a.txt');
      assert.strictEqual(form('\\tmp'), '/tmp');
    });

    it('Windows: "\\" with ".." reaches the namespace exactly as the "/" form does', () => {
      const form = virtualFormFor('win32');
      const posixForm = toVirtualPath('/app/../../x', '/app');
      assert.strictEqual(asBroker(form, '\\app\\..\\..\\x'), posixForm);
      assert.strictEqual(asBroker(form, '/app\\..\\..\\x'), posixForm);
      assert.strictEqual(asBroker(form, '\\data\\..\\app\\x'), toVirtualPath('/data/../app/x', '/app'));
    });

    it('Windows: nothing else is converted: a host path, a UNC or device path, a relative path, a look-alike, a non-string', () => {
      const form = virtualFormFor('win32');
      for (const v of ['D:\\app\\x', 'd:\\data\\x', '\\\\srv\\share\\app\\x', '\\\\?\\C:\\app\\x', 'data\\x', '\\application\\x', '\\apps\\x', '/app/x']) {
        assert.strictEqual(form(v), v, v);
      }
      const buf = Buffer.from('\\app\\x');
      assert.strictEqual(form(buf), buf);
    });

    it('POSIX: unchanged; a "\\" in a file name stays a literal', () => {
      for (const platform of ['linux', 'darwin']) {
        const form = virtualFormFor(platform);
        for (const v of ['/app/a\\b', '/app\\..\\..\\x', '\\app\\x', 'a\\b']) assert.strictEqual(form(v), v, `${platform} ${v}`);
        assert.strictEqual(asBroker(form, '/app/a\\b'), '/app/a\\b');
      }
    });
  });
});

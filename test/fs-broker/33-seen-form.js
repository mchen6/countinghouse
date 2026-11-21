// What a module is handed on Windows (C-compat-win): the broker answers in
// the namespace's POSIX form (/app/..., /data/..., /tmp/...), while a module
// on win32 with a virtual drive sees its files as <V>:\app\... (#195). Every
// path the patch hands the module -- realpath's, mkdtemp's, mkdir's,
// readlink's, a Dirent's, a Dir's, glob's, cp's filter arguments, an error's
// path, dest and message -- is in the module's spelling; anything that isn't
// the namespace's own form (a host-looking path, a UNC one, a name only like
// a root) is exactly as the broker answered it, never mapped into view; and
// the broker is still asked in the namespace's form. The patch is installed
// as on win32, so this runs on every platform.
const assert = require('assert');
const path = require('path');
const {runBrokered} = require('../helpers/brokered-worker');

const M = (rest) => `M:\\${rest}`;

describe('fs-broker 33: the paths a module is handed on Windows are in its own spelling', function() {
  this.timeout(60000);

  it('every answer, every form; a path not the namespace\'s as it was answered; the broker asked in the namespace\'s form', async () => {
    const m = await runBrokered(path.join(__dirname, 'scripts', 'seen-form.js'), {patch: false});
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    const r = m.r;
    const probe = M('app\\handlers\\probe');
    const plugins = M('app\\plugins');
    const missing = M('app\\missing.json');
    assert.deepStrictEqual(r, {
      realpathSync: probe, realpathSyncNative: probe, realpathBuffer: probe, realpathCallback: probe, realpathPromise: probe,
      realpathHost: 'C:\\Users\\someone\\secret', realpathApps: '/apps/x', realpathApplication: '/application/x', realpathUnc: '\\\\server\\share\\x',
      mkdtemp: M('tmp\\ch-abc'), mkdtempPromise: M('tmp\\ch-abc'),
      mkdirRecursive: M('app\\cache'), mkdirPromise: M('app\\cache'), mkdirPlain: 'undefined',
      disposable: M('tmp\\ch-abc'), asyncDisposable: M('tmp\\ch-abc'),
      // (their own cleanup asks the broker in the namespace's form)
      disposableRemoves: ['rm /tmp/ch-abc', 'rm /tmp/ch-abc'],
      readlinkAbs: M('app\\vendor\\x'), readlinkRel: '../vendor/x', readlinkHost: 'C:\\host\\target',
      direntParent: [plugins, plugins], direntPromise: [plugins, plugins],
      direntHost: ['C:\\host\\dir'], names: ['a.js'],
      dirPath: plugins, dirEntry: plugins, dirPromisePath: plugins,
      globSync: [M('app\\plugins\\a.js')], globDirents: [plugins], globPromise: [M('app\\plugins\\a.js')], globCallback: [M('app\\plugins\\a.js')],
      cpFilter: [[M('app\\src'), M('data\\dst')], [M('app\\src\\keep'), M('data\\dst\\keep')], [M('app\\src\\skip'), M('data\\dst\\skip')]],
      cpCopied: ['copyFile /app/src/keep'],
      cpFilterAsync: [[M('app\\src'), M('data\\dst')], [M('app\\src\\keep'), M('data\\dst\\keep')], [M('app\\src\\skip'), M('data\\dst\\skip')]],
      cpError: {path: undefined, dest: undefined, message: `Recursive option is required to copy a directory: ${M('app\\src')}`},
      cpSelf: {path: undefined, dest: undefined, message: `Invalid src or dest: cp returned EINVAL (cannot copy ${M('app\\src')} to a subdirectory of self ${M('app\\src\\in')})`},
      errorSync: {path: missing, dest: undefined, message: `ENOENT: no such file or directory, open '${missing}'`},
      errorCallback: {path: missing, message: `ENOENT: no such file or directory, open '${missing}'`},
      errorPromise: {path: missing, dest: undefined, message: `ENOENT: no such file or directory, open '${missing}'`},
      errorTwo: {path: M('app\\a'), dest: M('data\\b'), message: `EXDEV: cross-device link not permitted, rename '${M('app\\a')}' -> '${M('data\\b')}'`},
      errorHost: {path: 'C:\\host\\secret.json', dest: undefined, message: 'ENOENT: no such file or directory, open \'C:\\host\\secret.json\''},
      askedForeign: []
    });
  });
});

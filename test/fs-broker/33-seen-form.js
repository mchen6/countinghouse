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
const {readlinkAnswer} = require('../../lib/fs-broker/broker');
const {seenFormFor} = require('../../lib/fs-broker/roots');

const M = (rest) => `M:\\${rest}`;

describe('fs-broker 33: the paths a module is handed on Windows are in its own spelling', function() {
  this.timeout(60000);

  it('every answer, every form; a path not the namespace\'s as it was answered; the broker asked in the namespace\'s form', async () => {
    // (the virtual drive in the worker's data: on Windows the module's own
    // spelling in is read too, out.own)
    const m = await runBrokered(path.join(__dirname, 'scripts', 'seen-form.js'), {patch: false, workerData: {virtualDrive: 'M'}});
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
      callbacks: [M('tmp\\ch-abc'), M('app\\cache'), M('app\\vendor\\x')],
      disposable: M('tmp\\ch-abc'), asyncDisposable: M('tmp\\ch-abc'),
      // (their own cleanup asks the broker in the namespace's form)
      disposableRemoves: ['rm /tmp/ch-abc', 'rm /tmp/ch-abc'],
      readlinkAbs: M('app\\vendor\\x'), readlinkRel: '../vendor/x', readlinkHost: 'C:\\host\\target',
      direntParent: [plugins, plugins], direntPromise: [plugins, plugins],
      direntHost: ['C:\\host\\dir'], names: ['a.js'], direntRecursive: [plugins, plugins],
      // (a Dir's path: in the module's spelling, whichever way it was given)
      dirPath: plugins, dirEntry: plugins, dirPromisePath: plugins, dirCallback: [plugins, plugins],
      dirUrl: process.platform === 'win32' ? 'win32' : plugins, dirBuffer: true,
      globSync: [M('app\\plugins\\a.js')], globDirents: [plugins], globPromise: [M('app\\plugins\\a.js')], globCallback: [M('app\\plugins\\a.js')],
      globExclude: [M('app\\plugins\\a.js')], globExcludeSaw: [M('app\\plugins\\a.js'), M('app\\plugins\\b.txt')],
      cpFilter: [[M('app\\src'), M('data\\dst')], [M('app\\src\\keep'), M('data\\dst\\keep')], [M('app\\src\\skip'), M('data\\dst\\skip')]],
      cpCopied: ['copyFile /app/src/keep'],
      cpFilterAsync: [[M('app\\src'), M('data\\dst')], [M('app\\src\\keep'), M('data\\dst\\keep')], [M('app\\src\\skip'), M('data\\dst\\skip')]],
      cpError: {path: undefined, dest: undefined, message: `Recursive option is required to copy a directory: ${M('app\\src')}`},
      cpSelf: {path: undefined, dest: undefined, message: `Invalid src or dest: cp returned EINVAL (cannot copy ${M('app\\src')} to a subdirectory of self ${M('app\\src\\in')})`},
      cpExists: {path: undefined, dest: undefined, message: `Target already exists: cp returned EEXIST (${M('data\\there')} already exists)`},
      cpCallback: 'done', cpFilterCallback: [[M('app\\file'), M('data\\new')]],
      errorStackHead: `Error: ENOENT: no such file or directory, open '${missing}'`,
      moduleFormatter: {ranInCall: 0, stack: `formatted: ENOENT: no such file or directory, open '${missing}'`, ranOnRead: 1},
      errorUnquoted: {path: M('app\\x.json'), dest: undefined, message: `boom at ${M('app\\x.json')}, not /app/x.jsonl`},
      errorSync: {path: missing, dest: undefined, message: `ENOENT: no such file or directory, open '${missing}'`},
      errorCallback: {path: missing, message: `ENOENT: no such file or directory, open '${missing}'`},
      errorPromise: {path: missing, dest: undefined, message: `ENOENT: no such file or directory, open '${missing}'`},
      errorTwo: {path: M('app\\a'), dest: M('data\\b'), message: `EXDEV: cross-device link not permitted, rename '${M('app\\a')}' -> '${M('data\\b')}'`},
      errorHost: {path: 'C:\\host\\secret.json', dest: undefined, message: 'ENOENT: no such file or directory, open \'C:\\host\\secret.json\''},
      askedForeign: [],
      ...(process.platform === 'win32' ? {own: {
        realpath: probe, glob: [M('app\\plugins\\a.js')], globExcludeOwn: [M('app\\plugins\\a.js')],
        error: {path: missing, dest: undefined, message: `ENOENT: no such file or directory, open '${missing}'`},
        dir: M('app\\plugins'), dirUrl: M('app\\plugins'), globBackslash: [M('app\\plugins\\a.js')], mkdtemp: M('tmp\\ch-abc')
      }} : {})
    });
  });

  // (the reviewer's condition: a host path is never spelled into view)
  it('readlink on Windows: a target rooted with no drive is on the link\'s drive -- the namespace\'s when in a root, else a whole host path, never a name that reads as the namespace\'s', () => {
    const ns = {win32: true, hostPath: path.win32, toVirtual: (t) => (t.startsWith('C:\\ns\\') ? `/app/${t.slice(6).split('\\').join('/')}` : null)};
    const link = 'D:\\h\\node_modules\\x';
    assert.strictEqual(readlinkAnswer(ns, '/data/secret', link), 'D:\\data\\secret', 'written with "/": the link\'s drive, a host path');
    assert.strictEqual(readlinkAnswer(ns, '\\data\\secret', link), 'D:\\data\\secret');
    assert.strictEqual(readlinkAnswer(ns, '\\ns\\vendor\\x', 'C:\\ns\\node_modules\\l'), '/app/vendor/x', 'on the link\'s drive and in a root: the namespace\'s');
    assert.strictEqual(readlinkAnswer(ns, 'D:/host/y', link), 'D:\\host\\y');
    assert.strictEqual(readlinkAnswer(ns, 'C:\\ns\\vendor\\x', link), '/app/vendor/x', 'in a root: the namespace\'s');
    assert.strictEqual(readlinkAnswer(ns, '\\\\srv\\share\\x', link), '\\\\srv\\share\\x', 'UNC: as the host has it');
    assert.strictEqual(readlinkAnswer(ns, '../vendor/x', link), '../vendor/x', 'relative: as it is');
    const seen = seenFormFor('win32', 'M');
    // (and the module resolving it from its link never lands in its own namespace)
    for (const t of ['/data/secret', '\\data\\secret', '/app/x', '/tmp/y']) {
      const a = seen(readlinkAnswer(ns, t, link));
      assert.ok(/^[A-LN-Z]:\\/.test(path.win32.resolve('M:\\app\\node_modules', a)), `${t}: ${a}`);
    }
    assert.strictEqual(seen(readlinkAnswer(ns, 'C:\\ns\\vendor\\x', link)), 'M:\\app\\vendor\\x');
    const posixNs = {win32: false, hostPath: path.posix, toVirtual: () => null};
    assert.strictEqual(readlinkAnswer(posixNs, '/data/secret', '/h/l'), '/data/secret', 'POSIX: as before');
  });
});

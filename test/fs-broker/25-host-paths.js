// The identity loader's host-path checks follow the host's rules (#190's
// Windows leg): countinghouse's code roots, a module's root, and the
// exclusion of module roots from the code roots compare host paths with
// "\" on win32 (lib/fs-broker/roots.js underFor, as the boot grant does).
// With "/" alone, every host path on Windows was outside its root, so under
// enforce a worker's own lazily required runtime file
// (D:\a\countinghouse\countinghouse\lib\module-layout) was refused. No case
// folding beyond the drive letter. Server-free.
const assert = require('assert');
const {insideHostFor, withoutModuleRoots} = require('../../lib/fs-broker/identity');

describe('fs-broker 25: host paths in the identity loader, by the host\'s rules', () => {
  it('win32: a file under its root with "\\", the drive letter in either case; a sibling that shares a prefix is outside; no other case folding', () => {
    const inside = insideHostFor('win32');
    const root = 'D:\\a\\countinghouse\\countinghouse';
    assert.strictEqual(inside('D:\\a\\countinghouse\\countinghouse\\lib\\module-layout.js', root), true);
    assert.strictEqual(inside('d:\\a\\countinghouse\\countinghouse\\node_modules\\x\\index.js', root), true);
    assert.strictEqual(inside(root, root), true);
    assert.strictEqual(inside('D:\\a\\countinghouse\\countinghouse-other\\lib\\x.js', root), false);
    assert.strictEqual(inside('D:\\A\\COUNTINGHOUSE\\countinghouse\\lib\\x.js', root), false);
    assert.strictEqual(inside('D:/a/countinghouse/countinghouse/lib/x.js', root), false, '"/" form is not the host\'s form there');
  });

  it('POSIX: "/" only, as before', () => {
    const inside = insideHostFor('linux');
    assert.strictEqual(inside('/srv/ch/lib/module-layout.js', '/srv/ch'), true);
    assert.strictEqual(inside('/srv/ch-other/x.js', '/srv/ch'), false);
    assert.strictEqual(inside('/srv/ch\\lib\\x.js', '/srv/ch'), false, '"\\" is part of a name on POSIX');
  });

  it('win32: a module root is taken out of the code roots even when it differs from them only in case (the refusing side folds)', () => {
    const roots = ['D:\\ch\\lib', 'D:\\ch\\node_modules\\dep', 'D:\\ch\\node_modules\\my-module'];
    const realOf = new Map();
    const kept = withoutModuleRoots(roots, realOf, ['d:\\CH\\NODE_MODULES\\My-Module'], 'win32');
    assert.deepStrictEqual(kept, ['D:\\ch\\lib', 'D:\\ch\\node_modules\\dep']);
    // a module root holding a code root takes it out too
    assert.deepStrictEqual(withoutModuleRoots(roots, realOf, ['D:\\CH\\Node_Modules'], 'win32'), ['D:\\ch\\lib']);
    // a real path that is a module's takes its looked-up spelling with it
    assert.deepStrictEqual(withoutModuleRoots(['D:\\ch\\node_modules\\link'], new Map([['D:\\ch\\node_modules\\link', 'E:\\Mods\\M']]), ['e:\\mods\\m'], 'win32'), []);
  });

  it('POSIX: the exclusion compares as spelled', () => {
    assert.deepStrictEqual(withoutModuleRoots(['/ch/lib', '/ch/node_modules/m'], new Map(), ['/ch/node_modules/m'], 'linux'), ['/ch/lib']);
    assert.deepStrictEqual(withoutModuleRoots(['/ch/lib', '/ch/node_modules/m'], new Map(), ['/ch/node_modules/M'], 'linux'), ['/ch/lib', '/ch/node_modules/m']);
  });
});

// The identity loader's host-path checks follow the host's rules (#190's
// Windows leg): countinghouse's code roots, a module's root, and the
// exclusion of module roots from the code roots compare host paths with
// "\" on win32 (lib/fs-broker/roots.js underFor, as the boot grant does).
// With "/" alone, every host path on Windows was outside its root, so under
// enforce a worker's own lazily required runtime file
// (D:\a\countinghouse\countinghouse\lib\module-layout) was refused. No case
// folding beyond the drive letter. Server-free.
const assert = require('assert');
const {insideHostFor} = require('../../lib/fs-broker/identity');

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
});

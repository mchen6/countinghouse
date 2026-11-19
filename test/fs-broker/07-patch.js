const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {runBrokered} = require('../helpers/brokered-worker');

const S = (name) => path.join(__dirname, 'scripts', name);

describe('fs-broker 07: the worker patch', function() {
  this.timeout(60000);

  it('handles every fs, fs.promises and FileHandle method, or knows it as data; replacements are locked', async () => {
    const m = await runBrokered(S('keys.js'));
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.deepStrictEqual(m.r, {fs: [], promises: [], fileHandle: [], locked: true});
  });

  it('locks what it handles nowhere -- each shape a later Node might add it in -- to one that throws, and says which (F4-6)', async () => {
    const m = await runBrokered(S('swept.js'), {extra: {fakeAdded: true}});
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    const U = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
    const r = m.r;
    assert.match(r.refusal, /cannot guard this Node's fs\.fakeFixedSync, fs\.fakeFixedGetSync, fs\.fakeNcSync .*not starting under enforce -- if it is a constant, add it to PASSTHROUGH in lib\/fs-broker\/patch\.js/);
    delete r.refusal;
    delete r.swept.refusal;
    assert.deepStrictEqual(r, {method: U, lazy: U, hidden: U, space: U, spaceLive: 2, promise: U, klass: U, noCtor: 'TypeError', noProto: true, nc: 'ran',
      late: U, lateFrozen: true, sym: U, replaced: U, nullFilled: U, staticAfter: U, helperSaid: true, staticGetter: U, nodeLazy: U, staticName: U,
      selfNamed: U, selfNamedName: U, copy: 'ran', asyncOp: U, asyncShape: [true, true, 'function', 'function', 'function', 'string', U],
      constant: 7, ncConst: 3, data: [1, 2], list: [true, 1, U], err: [true, 'Error: boom', U], underBoot: [U, U],
      swept: {swept: ['fs.fakeAddedSync', 'fs.fakeLazySync', 'fs.fakeHiddenSync', 'fs.fakeSpace', 'fs.FakeBase', 'fs.FakeNamed', 'fs.FakeSelfNamed',
        'fs.fakeAsyncOp', 'fs.fakeList', 'fs.fakeErr', 'fs.fakeNodeLazySync', 'fs.FakeReader', 'fs.fakeLateSync', 'fs.Symbol(ch.fakeSym)', 'fs.promises.fakeAdded'],
      unsweepable: ['fs.fakeFixedSync', 'fs.fakeFixedGetSync', 'fs.fakeNcSync']}});
  });

  it('behaves as modules and libraries expect', async () => {
    const m = await runBrokered(S('behaviour.js'));
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    const r = m.r;
    assert.strictEqual(r.readSync, 'hello');
    assert.strictEqual(r.readCb, 'hello');
    assert.strictEqual(r.readPromise, 'hello');
    assert.deepStrictEqual(r.stats, {isStats: true, isFile: true, size: 5, mtimeIsDate: true});
    assert.strictEqual(r.bigint, 'bigint');
    assert.deepStrictEqual(r.dirent, {isDirent: true, name: 'a.txt', isFile: true, parentPath: '/data'});
    assert.deepStrictEqual(r.missing, {code: 'ENOENT', path: '/data/missing', isError: true});
    assert.strictEqual(r.fd1, 10);
    assert.deepStrictEqual(r.console, ['1:to stdout\n']);
    assert.strictEqual(r.stream, 'streamed');
    assert.strictEqual(r.handle, 'handle');
    assert.strictEqual(r.append, 'hello world');
    assert.deepStrictEqual(r.exists, [true, false]);
    assert.strictEqual(r.cp, 'deep');
    assert.deepStrictEqual(r.glob, ['a.txt', 'd/e/f.txt', 'd2/e/f.txt', 'h.txt', 's.txt']);
    assert.deepStrictEqual(r.opendir, ['a.txt', 'd', 'd2', 'h.txt', 's.txt']);
    assert.strictEqual(r.vector, 'abcd');
    assert.strictEqual(r.realpathNative, '/data/a.txt');
    assert.strictEqual(r.blob, 'hello world');
    assert.strictEqual(r.disposable, true);
    assert.strictEqual(r.watch, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
    assert.strictEqual(r.utf8Stream, 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
    assert.strictEqual(r.bigRead, 17 * 1024 * 1024);
    assert.strictEqual(r.fhStream, 'handle');
    assert.strictEqual(r.noEntry, true);
    assert.strictEqual(r.fsync1, true);
    assert.strictEqual(r.brokerFd, true);
    assert.strictEqual(r.readRange, 'ERR_OUT_OF_RANGE');
    assert.deepStrictEqual(r.globAbs, ['/data/d/e/f.txt']);
  });

});

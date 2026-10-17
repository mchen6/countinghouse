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

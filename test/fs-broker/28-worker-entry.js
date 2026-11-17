// The spelling a lean worker is started by (lib/fs-broker/worker-entry.js;
// #272's sequel). Once the file broker is installed in a worker, its loader's
// realpath is the native one (FB3), which on Windows expands an 8.3 short
// name. A worker started by another spelling loaded its first files by that
// one and the rest by the native one: two instances of a file required both
// before and after (stdio 26 shows it on Windows, where it happens). Here,
// server-free on any platform: the entry is the native real path, unless the
// loader keeps spellings (--preserve-symlinks), when it is as given.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tmp = require('../helpers/test-tmp');
const {entryFor, preservesSymlinks} = require('../../lib/fs-broker/worker-entry');

describe('fs-broker 28: a lean worker is started by the spelling its loader gives every file', () => {
  let base = null;
  let link = null;
  before(() => {
    base = tmp.mkdtemp('ch-worker-entry-');
    fs.mkdirSync(path.join(base, 'real'));
    fs.writeFileSync(path.join(base, 'real', 'lean-worker.js'), '');
    link = path.join(base, 'spelled');
    fs.symlinkSync(path.join(base, 'real'), link, 'junction');
  });
  after(() => { if (base != null) fs.rmSync(base, {recursive: true, force: true}); });

  it('the native real path, when the loader realpaths what it requires', () => {
    assert.strictEqual(entryFor(link, 'lean-worker.js', {preserve: false}), fs.realpathSync.native(path.join(link, 'lean-worker.js')));
    assert.notStrictEqual(entryFor(link, 'lean-worker.js', {preserve: false}), path.join(link, 'lean-worker.js'));
  });

  it('as given under --preserve-symlinks, where the loader realpaths nothing', () => {
    assert.strictEqual(entryFor(link, 'lean-worker.js', {preserve: true}), path.join(link, 'lean-worker.js'));
  });

  it('as given when it cannot be resolved (the worker then fails to start as it did)', () => {
    assert.strictEqual(entryFor(path.join(base, 'nowhere'), 'lean-worker.js', {preserve: false}), path.join(base, 'nowhere', 'lean-worker.js'));
  });

  it('--preserve-symlinks is read where Node reads it: the process\'s flags, NODE_OPTIONS, NODE_PRESERVE_SYMLINKS', () => {
    assert.strictEqual(preservesSymlinks([], {}), false);
    assert.strictEqual(preservesSymlinks(['--preserve-symlinks'], {}), true);
    // only the main file's spelling is kept: the files it requires are still realpathed
    assert.strictEqual(preservesSymlinks(['--preserve-symlinks-main'], {}), false);
    assert.strictEqual(preservesSymlinks([], {NODE_OPTIONS: '--max-old-space-size=512 --preserve-symlinks'}), true);
    assert.strictEqual(preservesSymlinks([], {NODE_OPTIONS: '--preserve-symlinks-main'}), false);
    assert.strictEqual(preservesSymlinks([], {NODE_PRESERVE_SYMLINKS: '1'}), true);
    assert.strictEqual(preservesSymlinks([], {NODE_PRESERVE_SYMLINKS: '0'}), false);
    // as Node reads them: the first character of the variable, a quoted word,
    // and the last flag deciding (the variable, then NODE_OPTIONS, then the flags)
    assert.strictEqual(preservesSymlinks([], {NODE_PRESERVE_SYMLINKS: '1 '}), true);
    assert.strictEqual(preservesSymlinks([], {NODE_OPTIONS: '"--preserve-symlinks"'}), true);
    assert.strictEqual(preservesSymlinks(['--preserve-symlinks', '--no-preserve-symlinks'], {}), false);
    assert.strictEqual(preservesSymlinks(['--no-preserve-symlinks'], {NODE_PRESERVE_SYMLINKS: '1'}), false);
    assert.strictEqual(preservesSymlinks(['--preserve-symlinks'], {NODE_OPTIONS: '--no-preserve-symlinks'}), true);
  });

  it('a path whose real path can\'t be read: as given, and the caller is told', () => {
    let told = null;
    const given = path.join(base, 'nowhere', 'lean-worker.js');
    assert.strictEqual(entryFor(path.join(base, 'nowhere'), 'lean-worker.js', {preserve: false, onFallback: (e) => { told = e.code; }}), given);
    assert.strictEqual(told, 'ENOENT');
  });
});

// FB1: a symlink a module creates takes a relative target with no ".."
// segment, and is decided by where that target really leads (the existing
// components walked from the real path of the link's directory, links among
// them followed), not by its text. Text alone passed x -> "." then
// y -> "x/..", which leads to the root's PARENT for anyone who follows y; a
// check of the real target at creation alone passed a/b/l -> "../../f",
// which leads there once a/b is renamed to b.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {mkdtemp} = require('../helpers/test-tmp');

async function setup(mode) {
  const base = mkdtemp('broker-fb1-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp'),
    outside: path.join(base, 'outside')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  fs.writeFileSync(path.join(dirs.outside, 'secret'), 'no');
  fs.writeFileSync(path.join(base, 'f'), 'parent of /data');
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp,
    declared: [], protectedPaths: []});
  await namespace.prepare();
  const broker = new FsBroker({name: 'm', mode: mode, namespace: namespace, cwd: '/'});
  return {base, dirs, broker, done: () => broker.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (e) { return false; }
}

const eperm = (e) => e.code === 'EPERM';
const MODES = ['off', 'audit', 'enforce'];

describe('fs-broker 20: a symlink is decided by its real target, and takes no ".." (FB1)', function() {
  this.timeout(10000);

  it('x -> "." is accepted; y -> "x/.." (really the root\'s parent) is refused EPERM in every mode', async () => {
    for (const mode of MODES) {
      const t = await setup(mode);
      try {
        await t.broker.handle('symlink', ['.', '/data/x']);
        assert.strictEqual(fs.readlinkSync(path.join(t.dirs.data, 'x')), '.', mode);
        await assert.rejects(t.broker.handle('symlink', ['x/..', '/data/y']), eperm, mode);
        assert.strictEqual(isLink(path.join(t.dirs.data, 'y')), false, mode);
      } finally { await t.done(); }
    }
  });

  it('any ".." is refused, even where it stays inside today: a later rename would re-aim it', async () => {
    for (const mode of MODES) {
      const t = await setup(mode);
      try {
        fs.mkdirSync(path.join(t.dirs.data, 'a', 'b'), {recursive: true});
        fs.writeFileSync(path.join(t.dirs.data, 'f'), 'inside');
        // /data/a/b/../../f is /data/f today; after renaming a/b to b it
        // would be the f above /data.
        await assert.rejects(t.broker.handle('symlink', ['../../f', '/data/a/b/l']), eperm, mode);
        await assert.rejects(t.broker.handle('symlink', ['../f', '/data/a/l']), eperm, mode);
        await assert.rejects(t.broker.handle('symlink', ['b/../../f', '/data/a/l']), eperm, mode);
        await assert.rejects(t.broker.handle('symlink', ['z/..', '/data/l']), eperm, mode);
      } finally { await t.done(); }
    }
  });

  it('targets without ".." still work, and still lead inside after the module renames their directory', async () => {
    for (const mode of MODES) {
      const t = await setup(mode);
      try {
        fs.mkdirSync(path.join(t.dirs.data, 'a', 'b', 'sub'), {recursive: true});
        fs.writeFileSync(path.join(t.dirs.data, 'a', 'b', 'sub', 'f'), 'ok');
        await t.broker.handle('symlink', ['sub/f', '/data/a/b/l1']);
        await t.broker.handle('symlink', ['./sub', '/data/a/b/l2']);
        await t.broker.handle('symlink', ['missing/later', '/data/a/b/l3']);   // dangling is fine
        await t.broker.handle('rename', ['/data/a/b', '/data/b']);
        assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'b', 'l1'), 'utf8'), 'ok', mode);
        assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'b', 'l2', 'f'), 'utf8'), 'ok', mode);
      } finally { await t.done(); }
    }
  });

  it('links met on the way are followed: through a link a host process planted to the outside is refused', async () => {
    for (const mode of MODES) {
      const t = await setup(mode);
      try {
        fs.symlinkSync(t.dirs.outside, path.join(t.dirs.data, 'abs'));
        fs.mkdirSync(path.join(t.dirs.data, 'sub'));
        fs.symlinkSync('../..', path.join(t.dirs.data, 'sub', 'up'));    // host-made: the parent of /data
        await t.broker.handle('symlink', ['sub', '/data/a']);             // the module's own, inside
        await assert.rejects(t.broker.handle('symlink', ['abs/secret', '/data/l1']), eperm, mode);
        await assert.rejects(t.broker.handle('symlink', ['a/up', '/data/l2']), eperm, mode);
        await assert.rejects(t.broker.handle('symlink', ['sub/up/f', '/data/l3']), eperm, mode);
        await t.broker.handle('symlink', ['a', '/data/l4']);              // a -> sub: inside
      } finally { await t.done(); }
    }
  });

  it('a link loop the walk cannot settle is refused', async () => {
    const t = await setup('enforce');
    try {
      fs.symlinkSync('p', path.join(t.dirs.data, 'q'));
      fs.symlinkSync('q', path.join(t.dirs.data, 'p'));
      await assert.rejects(t.broker.handle('symlink', ['p/x', '/data/l']), eperm);
    } finally { await t.done(); }
  });
});

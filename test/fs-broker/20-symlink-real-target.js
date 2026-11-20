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
  const reports = [];
  const broker = new FsBroker({name: 'm', mode: mode, namespace: namespace, cwd: '/', report: (rule, target) => reports.push(`${rule} ${target}`)});
  return {base, dirs, broker, reports, done: () => broker.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
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
        // (the dangling l3: made, moved with its directory, and once what it
        // names is created there it leads inside, to that)
        assert.strictEqual(fs.readlinkSync(path.join(t.dirs.data, 'b', 'l3')), 'missing/later', mode);
        await t.broker.handle('mkdir', ['/data/b/missing']);
        // (written through the dangling link itself, which makes its target)
        await t.broker.handle('writeFile', ['/data/b/l3', 'later']);
        assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'b', 'l3'), 'utf8'), 'later', mode);
        assert.strictEqual(fs.realpathSync(path.join(t.dirs.data, 'b', 'l3')), path.join(fs.realpathSync(t.dirs.data), 'b', 'missing', 'later'), mode);
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
        // (and with nothing there: the rule refuses where the target leads,
        // whether or not anything is at the end of it)
        assert.strictEqual(fs.existsSync(path.join(t.base, 'g')), false);
        await assert.rejects(t.broker.handle('symlink', ['sub/up/g', '/data/l3b']), eperm, mode);
        await t.broker.handle('symlink', ['a', '/data/l4']);              // a -> sub: inside
      } finally { await t.done(); }
    }
  });

  // (the FB1 follow-up, ruled 11-10: a link's own root is the one it really
  // lands in -- checkHost's -- not the one its virtual path names; a
  // host-made link between two declared roots, both ways)
  it('a link\'s own root is where it really lands: through a host-made link from /data into /tmp\'s root, both ways', async () => {
    for (const mode of ['audit', 'enforce']) {
      const t = await setup(mode);
      try {
        fs.mkdirSync(path.join(t.dirs.tmp, 'sub'));
        fs.writeFileSync(path.join(t.dirs.tmp, 'sub', 'f'), 'tmp');
        fs.writeFileSync(path.join(t.dirs.data, 'f'), 'data');
        fs.symlinkSync(path.join(t.dirs.tmp, 'sub'), path.join(t.dirs.data, 'hl'));    // host-made: /data/hl is in /tmp's root
        fs.symlinkSync(t.dirs.data, path.join(t.dirs.tmp, 'sub', 'back'));           // host-made: back into /data's root
        // a link placed at /data/hl/... lives in /tmp's root: one to a file
        // beside it stays in its own root, and is made
        await t.broker.handle('symlink', ['f', '/data/hl/l1']);
        assert.strictEqual(fs.readFileSync(path.join(t.dirs.tmp, 'sub', 'l1'), 'utf8'), 'tmp', mode);
        // one through 'back' leads into /data's root, not its own: refused
        await assert.rejects(t.broker.handle('symlink', ['back/f', '/data/hl/l2']), eperm, mode);
        assert.strictEqual(isLink(path.join(t.dirs.tmp, 'sub', 'l2')), false, mode);
      } finally { await t.done(); }
    }
  });

  // (the FB1 follow-up, ruled 11-10: an lstat the walk can't make, for
  // another reason than ENOENT or ENOTDIR, keeps the refusal, but is
  // reported with its errno under its own rule, so an operator can tell it
  // from a link-rule violation)
  it('an lstat the walk can\'t make (EACCES) is refused EPERM and reported as link-unreadable with its errno', async function() {
    if (process.platform === 'win32' || process.getuid() === 0) return this.skip();
    for (const mode of ['audit', 'enforce']) {
      const t = await setup(mode);
      const locked = path.join(t.dirs.data, 'locked');
      try {
        fs.mkdirSync(locked);
        fs.writeFileSync(path.join(locked, 'x'), 'x');
        fs.chmodSync(locked, 0);
        await assert.rejects(t.broker.handle('symlink', ['locked/x', '/data/l']), eperm, mode);
        assert.ok(t.reports.includes('link-unreadable /data/l EACCES'), `${mode}: ${t.reports.join(', ')}`);
      } finally { fs.chmodSync(locked, 0o700); await t.done(); }
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

// The pre-work high on #513 (C-broker-links): a file broker that never lets
// a link take a module past its roots, nor tells it what is out there.
// - F1: a hard link's source that is a symbolic link is refused (EPERM) on
//   every platform: macOS link(2) and Windows CreateHardLinkW follow a link
//   in its last component, so the new name would be its target's.
// - F2: an open's numeric flags hold only the bits a string flag maps to; any
//   other is EINVAL (Windows maps 0x40 to delete-on-close, 0x10000000 to an
//   exclusive lock: judged by POSIX bits alone they passed as a read).
// - F5: under enforce an exclusive create at any link leaf answers EEXIST,
//   whether its target exists or not; a write at a dangling link in a root
//   it can't write answers ENOENT, as one at a link that leaves the root.
// - F6: two identities are the same file only when both are known: bigint
//   dev and ino, the ino not 0.
// - F7: the following check's identity is the resolved path's own, never a
//   link that appeared there; truncate goes through a checked descriptor.
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker, flagsAllowed} = require('../../lib/fs-broker/broker');
const {sameFile, differentFile} = require('../../lib/file-identity');
const tmp = require('../helpers/test-tmp').forFile(['broker-links-']);

const POSIX = process.platform !== 'win32';

async function setup(mode = 'enforce') {
  const base = tmp.mkdtemp('broker-links-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp'), out: path.join(base, 'outside')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  fs.writeFileSync(path.join(dirs.out, 'there'), 'outside the roots');
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await namespace.prepare();
  const reports = [];
  const broker = new FsBroker({name: 'm', mode, namespace, cwd: '/', report: (rule, target) => reports.push(`${rule} ${target}`)});
  return {base, dirs, broker, reports, done: () => broker.closeAll()};
}
const code = (c) => (e) => e.code === c;

describe('fs-broker 36: links never take a module past its roots (C-broker-links)', function() {
  this.timeout(60000);

  it('F1: a hard link\'s source that is a symbolic link is refused, on every platform', async function() {
    const t = await setup();
    try {
      try {
        fs.symlinkSync(path.join(t.dirs.out, 'there'), path.join(t.dirs.data, 'secrets.env'));
      } catch (e) {
        if (e.code === 'EPERM') return this.skip(); // (Windows without the symlink privilege)
        throw e;
      }
      await assert.rejects(t.broker.handle('link', ['/data/secrets.env', '/data/s2']), code('EPERM'));
      assert.strictEqual(fs.existsSync(path.join(t.dirs.data, 's2')), false, 'no second name made');
      // (a plain file is linked as before)
      fs.writeFileSync(path.join(t.dirs.data, 'f'), 'own');
      await t.broker.handle('link', ['/data/f', '/data/g']);
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'g'), 'utf8'), 'own');
    } finally { await t.done(); }
  });

  it('F2: an open\'s numeric flags hold only a string flag\'s bits, per platform (Windows\' table on every OS)', async () => {
    // (libuv's Windows values: UV_FS_O_*)
    const win = {O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_APPEND: 0x8, O_CREAT: 0x100, O_TRUNC: 0x200, O_EXCL: 0x400, O_SYNC: 0x08000000, O_DSYNC: 0x04000000,
      UV_FS_O_TEMPORARY: 0x40, UV_FS_O_SHORT_LIVED: 0x1000, UV_FS_O_EXLOCK: 0x10000000, UV_FS_O_RANDOM: 0x10, UV_FS_O_SEQUENTIAL: 0x20};
    for (const bad of [0x40, 0x10000000, 0x1000, 0x10, 0x20, 0x40 | 0x2]) assert.strictEqual(flagsAllowed(bad, win), false, `0x${bad.toString(16)}`);
    for (const good of [0, 1, 2, 0x100 | 0x200 | 0x1, 0x100 | 0x400 | 0x1, 0x8 | 0x100 | 0x1, 0x08000000 | 0x2]) assert.strictEqual(flagsAllowed(good, win), true, `0x${good.toString(16)}`);
    // (this host's own: every string flag passes; a bit none maps to is EINVAL at open)
    const c = fs.constants;
    for (const good of [c.O_RDONLY, c.O_WRONLY | c.O_CREAT | c.O_TRUNC, c.O_RDWR | c.O_APPEND | c.O_CREAT, c.O_WRONLY | c.O_CREAT | c.O_EXCL]) assert.strictEqual(flagsAllowed(good, c), true);
    const t = await setup();
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'f'), 'own');
      const unknown = POSIX ? 0x40000000 : 0x40;
      await assert.rejects(t.broker.handle('open', ['/data/f', unknown]), code('EINVAL'));
      assert.ok(fs.existsSync(path.join(t.dirs.data, 'f')), 'the file is still there');
    } finally { await t.done(); }
  });

  it('F5: an exclusive create at any link leaf answers EEXIST; a write at a dangling link in a read-only root answers as one leaving it', async function() {
    const t = await setup();
    try {
      try {
        fs.symlinkSync(path.join(t.dirs.out, 'there'), path.join(t.dirs.data, 'to-there'));
        fs.symlinkSync(path.join(t.dirs.out, 'missing'), path.join(t.dirs.data, 'to-missing'));
        fs.symlinkSync(path.join(t.dirs.out, 'there'), path.join(t.dirs.app, 'to-there'));
        fs.symlinkSync(path.join(t.dirs.out, 'missing'), path.join(t.dirs.app, 'to-missing'));
      } catch (e) {
        if (e.code === 'EPERM') return this.skip();
        throw e;
      }
      for (const leaf of ['/data/to-there', '/data/to-missing']) {
        await assert.rejects(t.broker.handle('open', [leaf, 'wx']), code('EEXIST'), leaf);
      }
      // (the exclusive copy's answer is the same for both: EEXIST at the leaf)
      fs.writeFileSync(path.join(t.dirs.data, 'src'), 'own');
      const answers = [];
      for (const leaf of ['/data/to-there', '/data/to-missing']) {
        answers.push(await t.broker.handle('copyFile', ['/data/src', leaf, fs.constants.COPYFILE_EXCL]).then(() => 'ok', (e) => e.code));
      }
      assert.deepStrictEqual(answers, ['EEXIST', 'EEXIST']);
      // (a write in /app: the same answer whether the target exists)
      const ro = [];
      for (const leaf of ['/app/to-there', '/app/to-missing']) ro.push(await t.broker.handle('open', [leaf, 'w']).then(() => 'ok', (e) => e.code));
      assert.deepStrictEqual(ro, ['ENOENT', 'ENOENT']);
      assert.strictEqual(fs.existsSync(path.join(t.dirs.out, 'missing')), false, 'nothing made outside');
    } finally { await t.done(); }
  });

  it('F6: two identities are one file only when both are known (bigint dev and ino, ino not 0)', () => {
    assert.strictEqual(sameFile({}, {}), false);
    assert.strictEqual(sameFile({dev: 0n, ino: 0n}, {dev: 0n, ino: 0n}), false);
    assert.strictEqual(sameFile({dev: 1, ino: 5}, {dev: 1, ino: 5}), false, 'Numbers: not exact');
    assert.strictEqual(sameFile({dev: 1n, ino: 5n}, {dev: 1n, ino: 5n}), true);
    assert.strictEqual(sameFile({dev: 1n, ino: 5n}, {dev: 1n, ino: 6n}), false);
    // (different only when both are known and differ: cannot tell is neither)
    assert.strictEqual(differentFile({dev: 1n, ino: 5n}, {dev: 1n, ino: 6n}), true);
    assert.strictEqual(differentFile({dev: 1n, ino: 5n}, {dev: 1n, ino: 5n}), false);
    assert.strictEqual(differentFile({}, {dev: 1n, ino: 5n}), false);
    assert.strictEqual(differentFile({dev: 0n, ino: 0n}, {dev: 1n, ino: 5n}), false);
  });

  it('F7: a link that appears at the resolved path is never the file judged', async function() {
    if (!POSIX) return this.skip(); // (the race is staged with a symlink and a stub)
    const t = await setup('enforce');
    const saved = fsp.realpath;
    try {
      // (an in-root link, followed: realpath answers its target's path, which
      // by the following check is a link out -- staged by the stub)
      fs.writeFileSync(path.join(t.dirs.data, 'f'), 'own');
      fs.symlinkSync(path.join(t.dirs.data, 'f'), path.join(t.dirs.data, 'inlink'));
      fs.symlinkSync(path.join(t.dirs.out, 'there'), path.join(t.dirs.data, 'swapped'));
      assert.strictEqual((await t.broker.handle('stat', ['/data/inlink'])).fields.size, 3, 'followed in the root');
      fsp.realpath = async (p, o) => (String(p).endsWith(`${path.sep}inlink`) ? path.join(t.dirs.data, 'swapped') : saved(p, o));
      await assert.rejects(t.broker.handle('stat', ['/data/inlink']), code('ENOENT'));
      assert.ok(t.reports.includes('link-appeared /data/inlink'), t.reports.join(', '));
    } finally {
      fsp.realpath = saved;
      await t.done();
    }
  });

  it('F7: truncate goes through a checked descriptor: a denied or outward file is never cut', async function() {
    const t = await setup();
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'f'), '0123456789');
      await t.broker.handle('truncate', ['/data/f', 4]);
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'f'), 'utf8'), '0123');
      try {
        fs.symlinkSync(path.join(t.dirs.out, 'there'), path.join(t.dirs.data, 'out-link'));
      } catch (e) {
        if (e.code === 'EPERM') return this.skip();
        throw e;
      }
      await assert.rejects(t.broker.handle('truncate', ['/data/out-link', 0]), code('ENOENT'));
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.out, 'there'), 'utf8'), 'outside the roots');
      // (a hook between the check and the cut swaps the name for a link out:
      // the descriptor's own check refuses it)
      let swapped = false;
      t.broker.hooks.afterCheck = async (syscall, host) => {
        if (swapped || !String(host).endsWith(`${path.sep}g`)) return;
        swapped = true;
        fs.rmSync(host);
        fs.symlinkSync(path.join(t.dirs.out, 'there'), host);
      };
      fs.writeFileSync(path.join(t.dirs.data, 'g'), 'abcdef');
      await assert.rejects(t.broker.handle('truncate', ['/data/g', 0]));
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.out, 'there'), 'utf8'), 'outside the roots', 'the outside file is uncut');
    } finally { await t.done(); }
  });

  tmp.hooks();
});

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {mkdtemp} = require('../helpers/test-tmp');

async function setup(mode, opts) {
  opts = opts || {};
  const base = mkdtemp('broker-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp'),
    outside: path.join(base, 'outside'), ro: path.join(base, 'ro')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  fs.writeFileSync(path.join(dirs.app, 'index.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(dirs.outside, 'secret'), 'no');
  fs.writeFileSync(path.join(dirs.ro, 'config'), 'ro');
  if (opts.dataIsLink) {
    fs.renameSync(dirs.data, path.join(base, 'real-data'));
    fs.symlinkSync(path.join(base, 'real-data'), dirs.data);
  }
  const reports = [];
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp,
    declared: [{path: dirs.ro, access: 'r'}], protectedPaths: []});
  await namespace.prepare();
  const broker = new FsBroker({name: 'm', mode: mode, namespace: namespace, cwd: '/',
    report: (rule, target) => reports.push(`${rule} ${target}`),
    enforceFileDecisions: opts.enforceFileDecisions != null ? opts.enforceFileDecisions : true, hooks: opts.hooks});
  return {base, dirs, broker, reports, done: () => broker.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
}

function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return {wait: () => p, open: open};
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('fs-broker 03: broker operations', function() {
  this.timeout(10000);

  it('writes, reads and lists inside /data, answering virtual paths', async () => {
    const t = await setup('enforce');
    try {
      const fd = await t.broker.handle('open', ['/data/a.txt', 'w', 0o644]);
      assert.ok(fd >= 3);
      assert.strictEqual(await t.broker.handle('write', [fd, Buffer.from('hello'), null]), 5);
      await t.broker.handle('close', [fd]);
      const rfd = await t.broker.handle('open', ['/data/a.txt', 'r']);
      assert.strictEqual(Buffer.from(await t.broker.handle('read', [rfd, 100, 0])).toString(), 'hello');
      await t.broker.handle('close', [rfd]);
      assert.deepStrictEqual(await t.broker.handle('readdir', ['/data', {withFileTypes: true}]), [{name: 'a.txt', type: 'file', parentPath: '/data'}]);
      assert.strictEqual(await t.broker.handle('realpath', ['/data/a.txt']), '/data/a.txt');
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'a.txt'), 'utf8'), 'hello');
    } finally { await t.done(); }
  });

  it('enforce: outside is ENOENT with a virtual path, and is reported', async () => {
    const t = await setup('enforce');
    try {
      const secret = path.join(t.dirs.outside, 'secret');
      await assert.rejects(t.broker.handle('stat', [secret]), (e) => e.code === 'ENOENT' && e.path === secret && e.errno < 0 && e.syscall === 'stat');
      assert.ok(t.reports.includes(`outside ${secret}`), t.reports.join('\n'));
    } finally { await t.done(); }
  });

  it('audit: outside passes through and is reported once', async () => {
    const t = await setup('audit');
    try {
      const secret = path.join(t.dirs.outside, 'secret');
      assert.strictEqual((await t.broker.handle('stat', [secret])).fields.size, 2);
      await t.broker.handle('stat', [secret]);
      assert.strictEqual(t.reports.filter((r) => r === `outside ${secret}`).length, 1);
    } finally { await t.done(); }
  });

  it('off: outside passes through silently', async () => {
    const t = await setup('off');
    try {
      await t.broker.handle('stat', [path.join(t.dirs.outside, 'secret')]);
      assert.deepStrictEqual(t.reports, []);
    } finally { await t.done(); }
  });

  it('the plan 3 gate: enforce behaves as audit while enforceFileDecisions is false', async () => {
    const t = await setup('enforce', {enforceFileDecisions: false});
    try {
      assert.strictEqual((await t.broker.handle('stat', [path.join(t.dirs.outside, 'secret')])).fields.size, 2);
    } finally { await t.done(); }
  });

  it('enforce: /app is read-only (EROFS); audit allows and reports it', async () => {
    const e = await setup('enforce');
    try {
      await assert.rejects(e.broker.handle('open', ['/app/index.js', 'w']), (err) => err.code === 'EROFS' && err.path === '/app/index.js');
    } finally { await e.done(); }
    const a = await setup('audit');
    try {
      await a.broker.handle('close', [await a.broker.handle('open', ['/app/new.js', 'w'])]);
      assert.ok(a.reports.includes('readonly /app/new.js'), a.reports.join('\n'));
    } finally { await a.done(); }
  });

  it('a symlink planted in /data that points outside: reading through it is refused under enforce, reported under audit', async () => {
    const e = await setup('enforce');
    try {
      fs.symlinkSync(path.join(e.dirs.outside, 'secret'), path.join(e.dirs.data, 'link'));
      await assert.rejects(e.broker.handle('open', ['/data/link', 'r']), (err) => err.code === 'ENOENT' && err.path === '/data/link');
    } finally { await e.done(); }
    const a = await setup('audit');
    try {
      fs.symlinkSync(path.join(a.dirs.outside, 'secret'), path.join(a.dirs.data, 'link'));
      await a.broker.handle('close', [await a.broker.handle('open', ['/data/link', 'r'])]);
      assert.ok(a.reports.includes('escape /data/link'), a.reports.join('\n'));
    } finally { await a.done(); }
  });

  it('the same link can be lstat\'d, read as a link and removed under enforce', async () => {
    const t = await setup('enforce');
    try {
      const target = path.join(t.dirs.outside, 'secret');
      fs.symlinkSync(target, path.join(t.dirs.data, 'link'));
      assert.strictEqual((await t.broker.handle('lstat', ['/data/link'])).fields.mode & 0o170000, 0o120000);
      assert.strictEqual(await t.broker.handle('readlink', ['/data/link']), target);
      await t.broker.handle('unlink', ['/data/link']);
      assert.strictEqual(fs.existsSync(path.join(t.dirs.data, 'link')), false);
    } finally { await t.done(); }
  });

  it('readlink maps an absolute target inside a root back to its virtual path', async () => {
    const t = await setup('enforce');
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
      fs.symlinkSync(path.join(t.dirs.data, 'f'), path.join(t.dirs.data, 'abs'));
      assert.strictEqual(await t.broker.handle('readlink', ['/data/abs']), '/data/f');
    } finally { await t.done(); }
  });

  it('the real target\'s root decides access: a link from /data into a declared r directory is not writable', async () => {
    const e = await setup('enforce');
    try {
      fs.symlinkSync(path.join(e.dirs.ro, 'config'), path.join(e.dirs.data, 'cfg'));
      await assert.rejects(e.broker.handle('open', ['/data/cfg', 'w']), (err) => err.code === 'EROFS' && err.path === '/data/cfg');
      await e.broker.handle('close', [await e.broker.handle('open', ['/data/cfg', 'r'])]);
    } finally { await e.done(); }
  });

  it('a /data that is itself a symlink answers canonical virtual paths', async () => {
    const t = await setup('enforce', {dataIsLink: true});
    try {
      await t.broker.handle('mkdir', ['/data/sub', {}]);
      await t.broker.handle('close', [await t.broker.handle('open', ['/data/sub/x', 'w'])]);
      assert.strictEqual(await t.broker.handle('realpath', ['/data/sub/x']), '/data/sub/x');
      assert.deepStrictEqual(await t.broker.handle('readdir', ['/data', {withFileTypes: true, recursive: true}]),
        [{name: 'sub', type: 'dir', parentPath: '/data'}, {name: 'x', type: 'file', parentPath: '/data/sub'}]);
    } finally { await t.done(); }
  });

  it('a root itself cannot be removed or renamed (EBUSY), in every mode', async () => {
    for (const mode of ['off', 'audit', 'enforce']) {
      const t = await setup(mode);
      try {
        await assert.rejects(t.broker.handle('rm', ['/data', {recursive: true, force: true}]), (e) => e.code === 'EBUSY', mode);
        await assert.rejects(t.broker.handle('rename', ['/tmp', '/data/t']), (e) => e.code === 'EBUSY', mode);
        assert.ok(fs.existsSync(t.dirs.data) && fs.existsSync(t.dirs.tmp), mode);
      } finally { await t.done(); }
    }
  });

  it('link rules in every mode: hard links only within one writable root, symlinks only relative and inside', async () => {
    for (const mode of ['off', 'audit', 'enforce']) {
      const t = await setup(mode);
      try {
        await assert.rejects(t.broker.handle('link', ['/app/index.js', '/data/x.js']), (e) => e.code === 'EPERM', mode);
        await assert.rejects(t.broker.handle('symlink', ['/etc', '/data/l']), (e) => e.code === 'EPERM', mode);
        await assert.rejects(t.broker.handle('symlink', ['../app/index.js', '/data/l']), (e) => e.code === 'EPERM', mode);
        fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
        await t.broker.handle('link', ['/data/f', '/data/g']);
        await t.broker.handle('symlink', ['f', '/data/s']);
        assert.strictEqual(fs.readlinkSync(path.join(t.dirs.data, 's')), 'f', mode);
      } finally { await t.done(); }
    }
  });

  it('chmod strips setuid, setgid and sticky bits', async () => {
    const t = await setup('off');
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
      await t.broker.handle('chmod', ['/data/f', 0o7755]);
      assert.strictEqual(fs.statSync(path.join(t.dirs.data, 'f')).mode & 0o7777, 0o755);
    } finally { await t.done(); }
  });

  it('descriptors: numbered from 3, at most 256, unknown or 0-2 are EBADF', async () => {
    const t = await setup('enforce');
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
      const fds = [];
      for (let i = 0; i < 256; i++) fds.push(await t.broker.handle('open', ['/data/f', 'r']));
      assert.strictEqual(fds[0], 3);
      await assert.rejects(t.broker.handle('open', ['/data/f', 'r']), (e) => e.code === 'EMFILE');
      for (const fd of [0, 1, 2, 9999]) await assert.rejects(t.broker.handle('read', [fd, 1, 0]), (e) => e.code === 'EBADF', String(fd));
    } finally { await t.done(); }
  });

  it('read and write are capped at 16 MB per call', async () => {
    const t = await setup('enforce');
    try {
      const fd = await t.broker.handle('open', ['/data/big', 'w']);
      await assert.rejects(t.broker.handle('write', [fd, Buffer.alloc(16 * 1024 * 1024 + 1), null]), (e) => e.code === 'EINVAL');
      await assert.rejects(t.broker.handle('read', [fd, 16 * 1024 * 1024 + 1, 0]), (e) => e.code === 'EINVAL');
    } finally { await t.done(); }
  });

  it('verify after open: a file swapped for a symlink between check and open is refused under enforce', async () => {
    const t = await setup('enforce', {hooks: {afterCheck: (syscall, host) => {
      if (syscall === 'open' && host.endsWith('/swap')) {
        fs.rmSync(host);
        fs.symlinkSync(path.join(path.dirname(path.dirname(host)), 'outside', 'secret'), host);
      }
    }}});
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'swap'), 'in');
      await assert.rejects(t.broker.handle('open', ['/data/swap', 'r']), (e) => e.code === 'ENOENT' && e.path === '/data/swap');
    } finally { await t.done(); }
  });

  it('verify after open: a create whose parent is swapped toward a read-only root is refused under enforce', async () => {
    const t = await setup('enforce', {hooks: {afterCheck: (syscall, host) => {
      if (syscall === 'open' && host.endsWith('/sub/new')) {
        const sub = path.dirname(host);
        fs.rmSync(sub, {recursive: true});
        fs.symlinkSync(path.join(path.dirname(path.dirname(sub)), 'ro'), sub);
      }
    }}});
    try {
      fs.mkdirSync(path.join(t.dirs.data, 'sub'));
      await assert.rejects(t.broker.handle('open', ['/data/sub/new', 'w']), (e) => e.code === 'ENOENT' && e.path === '/data/sub/new');
    } finally { await t.done(); }
  });

  it('errors from the host carry the virtual path, never the host path', async () => {
    const t = await setup('enforce');
    try {
      await assert.rejects(t.broker.handle('stat', ['/data/missing']), (e) => e.code === 'ENOENT' && e.path === '/data/missing' &&
        !e.message.includes(t.base) && e.message.includes('/data/missing'));
    } finally { await t.done(); }
  });

  it('non-E* errors keep their code and lose the host path', async () => {
    const t = await setup('enforce');
    try {
      fs.mkdirSync(path.join(t.dirs.data, 'd'));
      await assert.rejects(t.broker.handle('rm', ['/data/d', {}]), (e) => e.code === 'ERR_FS_EISDIR' && !e.message.includes(t.base) && e.message.includes('/data/d'));
    } finally { await t.done(); }
  });

  it('enforce: synthesised ancestors list only the next component and cannot be written', async () => {
    const t = await setup('enforce');
    try {
      const names = await t.broker.handle('readdir', ['/', {}]);
      assert.ok(['app', 'data', 'tmp'].every((n) => names.includes(n)), names.join(','));
      assert.strictEqual((await t.broker.handle('stat', ['/'])).fields.mode & 0o170000, 0o040000);
      // the parent of the declared ro root is a synthesised ancestor: not writable
      await assert.rejects(t.broker.handle('utimes', [t.base, 0, 0]), (e) => e.code === 'EROFS');
      // a new name beside the roots is outside the namespace
      await assert.rejects(t.broker.handle('mkdir', ['/new', {}]), (e) => e.code === 'ENOENT');
    } finally { await t.done(); }
  });

  it('closeAll closes every open descriptor', async () => {
    const t = await setup('enforce');
    fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
    const fd = await t.broker.handle('open', ['/data/f', 'r']);
    await t.broker.closeAll();
    await assert.rejects(t.broker.handle('read', [fd, 1, 0]), (e) => e.code === 'EBADF' || e.code === 'EIO');
    fs.rmSync(t.base, {recursive: true, force: true});
  });

  it('a mutation waits for a read that holds the lock (deterministic)', async () => {
    const g = gate();
    const t = await setup('enforce', {hooks: {afterCheck: (syscall, host) => (syscall === 'stat' && host.endsWith('/f') ? g.wait() : null)}});
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
      const stat = t.broker.handle('stat', ['/data/f']);
      await tick();
      const rename = t.broker.handle('rename', ['/data/f', '/data/g']);
      await tick();
      assert.ok(fs.existsSync(path.join(t.dirs.data, 'f')), 'rename ran while a read held the lock');
      g.open();
      await stat;
      await rename;
      assert.ok(fs.existsSync(path.join(t.dirs.data, 'g')));
    } finally { await t.done(); }
  });

  it('reads share the lock: a read-only open is not held up by a paused stat', async () => {
    const g = gate();
    const t = await setup('enforce', {hooks: {afterCheck: (syscall, host) => (syscall === 'stat' ? g.wait() : null)}});
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'f'), 'x');
      const stat = t.broker.handle('stat', ['/data/f']);
      await tick();
      const fd = await t.broker.handle('open', ['/data/f', 'r']);
      await t.broker.handle('close', [fd]);
      g.open();
      await stat;
    } finally { await t.done(); }
  });

  it('descriptor operations take no path lock: a write proceeds while a mutation is paused', async () => {
    const g = gate();
    const t = await setup('enforce', {hooks: {afterCheck: (syscall) => (syscall === 'mkdir' ? g.wait() : null)}});
    try {
      const fd = await t.broker.handle('open', ['/data/f', 'w']);
      const mkdir = t.broker.handle('mkdir', ['/data/d', {}]);
      await tick();
      assert.strictEqual(await t.broker.handle('write', [fd, Buffer.from('x'), null]), 1);
      await t.broker.handle('close', [fd]);
      g.open();
      await mkdir;
    } finally { await t.done(); }
  });
});

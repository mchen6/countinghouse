// The broker's cache of directory real paths (plan 5 Task 4b, C): fewer
// realpath calls, cleared by every exclusive (mutating) operation, expiring
// after 1000 ms, and never trusted for an open under enforce, where
// verifyOpened still checks the descriptor.
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');

async function setup(mode) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.ch-rpcache-')));
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp'), outside: path.join(base, 'outside')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  for (const [dir, text] of [['real1', 'one'], ['real2', 'two']]) {
    fs.mkdirSync(path.join(dirs.data, dir));
    fs.writeFileSync(path.join(dirs.data, dir, 'f'), text);
  }
  fs.writeFileSync(path.join(dirs.outside, 'f'), 'outside');
  const reports = [];
  const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await ns.prepare();
  const broker = new FsBroker({name: 'm', mode, namespace: ns, cwd: '/app', report: (r, t) => reports.push(`${r} ${t}`)});
  return {base, dirs, broker, reports, done: () => broker.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
}
const read = async(b, p) => (await b.handle('readFile', [p, 'r'])).toString();

describe('fs-broker 19: the directory realpath cache', function() {
  this.timeout(20000);

  it('repeated calls in one directory resolve it once', async () => {
    const t = await setup('enforce');
    const realpath = fsp.realpath;
    const seen = [];
    fsp.realpath = (p, ...rest) => { seen.push(String(p)); return realpath(p, ...rest); };
    try {
      for (let i = 0; i < 5; i++) await t.broker.handle('stat', ['/data/real1/f']);
      assert.strictEqual(seen.filter((p) => p === path.join(t.dirs.data, 'real1')).length, 1, seen.join('\n'));
    } finally { fsp.realpath = realpath; await t.done(); }
  });

  ['unlink then symlink', 'rename over', 'rm then symlink'].forEach((how) => {
    it(`a module's own change clears it: ${how}`, async () => {
      const t = await setup('enforce');
      try {
        await t.broker.handle('symlink', ['real1', '/data/link']);
        assert.strictEqual(await read(t.broker, '/data/link/f'), 'one');
        if (how === 'unlink then symlink') {
          await t.broker.handle('unlink', ['/data/link']);
          await t.broker.handle('symlink', ['real2', '/data/link']);
        } else if (how === 'rename over') {
          await t.broker.handle('symlink', ['real2', '/data/link2']);
          await t.broker.handle('rename', ['/data/link2', '/data/link']);
        } else {
          await t.broker.handle('rm', ['/data/link']);
          await t.broker.handle('symlink', ['real2', '/data/link']);
        }
        assert.strictEqual(await read(t.broker, '/data/link/f'), 'two');
      } finally { await t.done(); }
    });
  });

  it('an entry older than 1000 ms is resolved again (a host process\'s change)', async () => {
    const t = await setup('audit');
    try {
      fs.symlinkSync('real1', path.join(t.dirs.data, 'link'));
      assert.strictEqual(await read(t.broker, '/data/link/f'), 'one');
      fs.unlinkSync(path.join(t.dirs.data, 'link'));
      fs.symlinkSync('real2', path.join(t.dirs.data, 'link'));
      await new Promise((r) => setTimeout(r, 1100));
      assert.strictEqual(await read(t.broker, '/data/link/f'), 'two');
    } finally { await t.done(); }
  });

  it('enforce: a host swap to outside inside the cache window still cannot be opened', async () => {
    const t = await setup('enforce');
    try {
      fs.symlinkSync('real1', path.join(t.dirs.data, 'link'));
      assert.strictEqual(await read(t.broker, '/data/link/f'), 'one');
      fs.unlinkSync(path.join(t.dirs.data, 'link'));
      fs.symlinkSync(t.dirs.outside, path.join(t.dirs.data, 'link'));
      await assert.rejects(t.broker.handle('readFile', ['/data/link/f', 'r']), (e) => e.code === 'ENOENT');
      assert.ok(t.reports.some((r) => r.startsWith('escape /data/link/f')), t.reports.join('\n'));
    } finally { await t.done(); }
  });
});

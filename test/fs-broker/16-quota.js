// The per-module disk quota on /data and /tmp (spec section 3, "Quota").
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {Quota} = require('../../lib/fs-broker/quota');
const {mkdtemp} = require('../helpers/test-tmp');

async function setup(mode, opts) {
  opts = opts || {};
  const base = mkdtemp('quota-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  const reports = [];
  const report = (rule, target) => reports.push(`${rule} ${target}`);
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await namespace.prepare();
  const quota = opts.quota == null ? null : new Quota(Object.assign({}, opts.quota, {enforce: mode === 'enforce', report: report}));
  const broker = new FsBroker({name: 'm', mode: mode, namespace: namespace, cwd: '/', report: report, quota: quota});
  return {base, dirs, broker, reports, done: () => broker.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
}

describe('fs-broker 16: the disk quota', function() {
  this.timeout(20000);

  it('enforce: a write past diskMb is ENOSPC and writes nothing', async () => {
    const t = await setup('enforce', {quota: {maxBytes: 1000, maxEntries: 100}});
    try {
      const fd = await t.broker.handle('open', ['/data/f', 'w']);
      await t.broker.handle('write', [fd, Buffer.alloc(900), null]);
      await assert.rejects(t.broker.handle('write', [fd, Buffer.alloc(200), null]), (e) => e.code === 'ENOSPC' && e.path === '/data/f');
      await t.broker.handle('close', [fd]);
      assert.strictEqual(fs.statSync(path.join(t.dirs.data, 'f')).size, 900);
    } finally { await t.done(); }
  });

  it('counts logical growth: an overwrite in place is free; ftruncate up counts; a sparse file counts its length', async () => {
    const t = await setup('enforce', {quota: {maxBytes: 1000, maxEntries: 100}});
    try {
      const fd = await t.broker.handle('open', ['/data/f', 'w']);
      await t.broker.handle('write', [fd, Buffer.alloc(800), null]);
      await t.broker.handle('write', [fd, Buffer.alloc(800), 0]);              // positional, no growth
      await assert.rejects(t.broker.handle('ftruncate', [fd, 1200]), (e) => e.code === 'ENOSPC');
      await t.broker.handle('ftruncate', [fd, 100]);                          // shrink releases
      await t.broker.handle('ftruncate', [fd, 900]);
      await t.broker.handle('close', [fd]);
    } finally { await t.done(); }
  });

  it('diskEntries counts names: files, directories, symlinks, links; unlink and rm give them back', async () => {
    const t = await setup('enforce', {quota: {maxBytes: 1e6, maxEntries: 3}});
    try {
      await t.broker.handle('mkdir', ['/data/d']);
      await t.broker.handle('close', [await t.broker.handle('open', ['/data/d/f', 'w'])]);
      await t.broker.handle('symlink', ['f', '/data/d/s']);
      await assert.rejects(t.broker.handle('link', ['/data/d/f', '/data/d/h']), (e) => e.code === 'ENOSPC');
      await t.broker.handle('rm', ['/data/d', {recursive: true}]);
      await t.broker.handle('mkdir', ['/data/e']);
    } finally { await t.done(); }
  });

  it('two writes racing at the edge: one gets ENOSPC', async () => {
    const t = await setup('enforce', {quota: {maxBytes: 1000, maxEntries: 100}});
    try {
      const a = await t.broker.handle('open', ['/data/a', 'w']);
      const b = await t.broker.handle('open', ['/data/b', 'w']);
      const results = await Promise.allSettled([t.broker.handle('write', [a, Buffer.alloc(600), null]), t.broker.handle('write', [b, Buffer.alloc(600), null])]);
      assert.deepStrictEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    } finally { await t.done(); }
  });

  it('copyFile counts the copy; rename over an existing file gives the replaced one back; /tmp shares the pool', async () => {
    const t = await setup('enforce', {quota: {maxBytes: 1000, maxEntries: 100}});
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'src'), Buffer.alloc(400));
      t.broker.quota.settle(0, 0, 400, 1);                                    // the file the test planted
      await t.broker.handle('copyFile', ['/data/src', '/tmp/copy']);
      await assert.rejects(t.broker.handle('copyFile', ['/data/src', '/tmp/copy2']), (e) => e.code === 'ENOSPC');
      const before = t.broker.quota.bytes;
      await t.broker.handle('rename', ['/tmp/copy', '/tmp/copy']);              // to itself: nothing changes (review I2)
      assert.strictEqual(t.broker.quota.bytes, before);
      await t.broker.handle('close', [await t.broker.handle('open', ['/tmp/small', 'w'])]);
      await t.broker.handle('rename', ['/tmp/small', '/tmp/copy']);             // over a different file: the replaced copy is given back
      await t.broker.handle('copyFile', ['/data/src', '/tmp/copy2']);
    } finally { await t.done(); }
  });

  it('removing one name of a hard-linked file gives nothing back (review I1)', async () => {
    const t = await setup('enforce', {quota: {maxBytes: 1500, maxEntries: 1000}});
    try {
      const fd = await t.broker.handle('open', ['/data/big', 'w']);
      await t.broker.handle('write', [fd, Buffer.alloc(1000), null]);
      await t.broker.handle('close', [fd]);
      for (let i = 0; i < 3; i++) {
        await t.broker.handle('mkdir', ['/data/d']);
        await t.broker.handle('link', ['/data/big', '/data/d/x']);
        await t.broker.handle('rm', ['/data/d', {recursive: true}]);
      }
      const f2 = await t.broker.handle('open', ['/data/more', 'w']);
      await assert.rejects(t.broker.handle('write', [f2, Buffer.alloc(600), null]), (e) => e.code === 'ENOSPC');
      await t.broker.handle('close', [f2]);
    } finally { await t.done(); }
  });

  it('audit: allowed past the limit, logged once at 75 % and once at 100 %', async () => {
    const t = await setup('audit', {quota: {maxBytes: 1000, maxEntries: 100}});
    try {
      const fd = await t.broker.handle('open', ['/data/f', 'w']);
      for (let i = 0; i < 12; i++) await t.broker.handle('write', [fd, Buffer.alloc(100), null]);
      await t.broker.handle('close', [fd]);
      assert.deepStrictEqual(t.reports.filter((r) => r.startsWith('quota')), ['quota 75% of diskMb (800 of 1000 bytes)', 'quota 100% of diskMb (1000 of 1000 bytes)']);
    } finally { await t.done(); }
  });

  it('a brokered writeFile past diskMb is ENOSPC and writes nothing (plan 5 Task 4b, B)', async () => {
    const t = await setup('enforce', {quota: {maxBytes: 1000, maxEntries: 100}});
    try {
      await assert.rejects(t.broker.handle('writeFile', ['/data/big', Buffer.alloc(2000), 'w', 0o666]), (e) => e.code === 'ENOSPC');
      await t.broker.handle('writeFile', ['/data/ok', Buffer.alloc(500), 'w', 0o666]);
      assert.strictEqual(fs.statSync(path.join(t.dirs.data, 'ok')).size, 500);
    } finally { await t.done(); }
  });

  it('declared paths and off are not counted', async () => {
    const t = await setup('off', {quota: null});
    try {
      const fd = await t.broker.handle('open', ['/data/f', 'w']);
      await t.broker.handle('write', [fd, Buffer.alloc(5000), null]);
      await t.broker.handle('close', [fd]);
    } finally { await t.done(); }
  });
});

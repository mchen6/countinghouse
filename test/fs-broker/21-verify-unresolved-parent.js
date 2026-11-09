// FB2: under enforce, an open whose parent directory did not resolve when
// the broker checked it (it was missing) was not verified at all after the
// open (verifyOpened returned at placed.ident == null). A host process that
// creates the parent in between, as a link to elsewhere, steered the open
// there. Now the broker decides on where the descriptor really landed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {mkdtemp} = require('../helpers/test-tmp');

async function setup(mode, afterCheck) {
  const base = mkdtemp('broker-fb2-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp'),
    outside: path.join(base, 'outside'), ro: path.join(base, 'ro')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  fs.writeFileSync(path.join(dirs.outside, 'secret'), 'no');
  fs.writeFileSync(path.join(dirs.ro, 'config'), 'ro');
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp,
    declared: [{path: dirs.ro, access: 'r'}], protectedPaths: []});
  await namespace.prepare();
  const reports = [];
  const broker = new FsBroker({name: 'm', mode: mode, namespace: namespace, cwd: '/',
    report: (rule, target) => reports.push(`${rule} ${target}`), hooks: {afterCheck: (s, h) => afterCheck(s, h, dirs)}});
  return {base, dirs, broker, reports, done: () => broker.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
}

// The parent is missing at the check; the hook then makes it a link to `to`.
function plantParent(name, to) {
  return (syscall, host, dirs) => {
    if (syscall === 'open' && path.basename(path.dirname(host)) === name) fs.symlinkSync(dirs[to], path.dirname(host));
  };
}

const enoent = (v) => (e) => e.code === 'ENOENT' && e.path === v;

describe('fs-broker 21: an open whose parent was missing at the check is verified after it (FB2)', function() {
  this.timeout(10000);

  it('a read through a parent created as a link to the outside is refused under enforce, and reported', async () => {
    const t = await setup('enforce', plantParent('late', 'outside'));
    try {
      await assert.rejects(t.broker.handle('open', ['/data/late/secret', 'r']), enoent('/data/late/secret'));
      assert.ok(t.reports.includes('escape /data/late/secret'), t.reports.join(', '));
      assert.strictEqual(t.broker.fds.size, 0);
    } finally { await t.done(); }
  });

  it('a write-open through a parent created as a link to a read-only root is refused under enforce', async () => {
    for (const [p, flags] of [['/data/late/config', 'r+'], ['/data/late/new', 'w']]) {
      const t = await setup('enforce', plantParent('late', 'ro'));
      try {
        await assert.rejects(t.broker.handle('open', [p, flags]), enoent(p));
        assert.strictEqual(fs.readFileSync(path.join(t.dirs.ro, 'config'), 'utf8'), 'ro');
      } finally { await t.done(); }
    }
  });

  it('a copyfile whose destination parent is created as a link to the outside is refused under enforce', async () => {
    const t = await setup('enforce', (syscall, host, dirs) => {
      if (syscall === 'copyfile' && path.basename(path.dirname(host)) === 'late') fs.symlinkSync(dirs.outside, path.dirname(host));
    });
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'src'), 'payload');
      await assert.rejects(t.broker.handle('copyFile', ['/data/src', '/data/late/out']), enoent('/data/late/out'));
      const out = path.join(t.dirs.outside, 'out');
      assert.ok(!fs.existsSync(out) || fs.readFileSync(out, 'utf8') === '', 'nothing written outside');
    } finally { await t.done(); }
  });

  it('a parent created as a real directory inside the root in between is fine', async () => {
    const t = await setup('enforce', (syscall, host) => {
      if (syscall === 'open' && path.basename(path.dirname(host)) === 'late') fs.mkdirSync(path.dirname(host));
    });
    try {
      const fd = await t.broker.handle('open', ['/data/late/f', 'w']);
      await t.broker.handle('close', [fd]);
      assert.ok(fs.existsSync(path.join(t.dirs.data, 'late', 'f')));
    } finally { await t.done(); }
  });

  it('audit does not refuse it: the check after open is enforce-only, as before', async () => {
    const t = await setup('audit', plantParent('late', 'outside'));
    try {
      const fd = await t.broker.handle('open', ['/data/late/secret', 'r']);
      await t.broker.handle('close', [fd]);
    } finally { await t.done(); }
  });
});

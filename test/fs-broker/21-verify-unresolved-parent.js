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
const {Quota} = require('../../lib/fs-broker/quota');
const {DeniedSet} = require('../../lib/fs-broker/denied');

async function setup(mode, afterCheck, quota, deniedNames) {
  const base = mkdtemp('broker-fb2-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp'),
    outside: path.join(base, 'outside'), ro: path.join(base, 'ro')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  fs.writeFileSync(path.join(dirs.outside, 'secret'), 'no');
  fs.writeFileSync(path.join(dirs.ro, 'config'), 'ro');
  fs.writeFileSync(path.join(dirs.data, 'denied-secret'), 'denied');
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp,
    declared: [{path: dirs.ro, access: 'r'}], protectedPaths: []});
  await namespace.prepare();
  const reports = [];
  const broker = new FsBroker({name: 'm', mode: mode, namespace: namespace, cwd: '/',
    report: (rule, target) => reports.push(`${rule} ${target}`), hooks: {afterCheck: (s, h) => afterCheck(s, h, dirs)}, quota,
    denied: deniedNames != null ? new DeniedSet(deniedNames.map((n) => path.join(dirs.data, n))) : undefined});
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

  // (the FB2 follow-up, ruled 11-10: a creating open refused after it
  // leaves no empty file behind -- removed only when this open made it)
  it('a creating open refused after it leaves no file behind, in a read-only root or outside; an existing one is kept', async () => {
    for (const [to, name] of [['ro', 'made-ro'], ['outside', 'made-out']]) {
      const t = await setup('enforce', plantParent('late', to));
      try {
        await assert.rejects(t.broker.handle('open', [`/data/late/${name}`, 'w']), enoent(`/data/late/${name}`));
        // (removed where /proc says the descriptor is: Linux; elsewhere it
        // stays, never removed by a path a host process could swap)
        if (process.platform === 'linux') assert.strictEqual(fs.existsSync(path.join(t.dirs[to], name)), false, `${to}: the file the refused open made is gone`);
      } finally { await t.done(); }
    }
    // (an 'a' open creates only when there is nothing: the existing file
    // it found is no file of its making, and stays)
    const t = await setup('enforce', plantParent('late', 'ro'));
    try {
      await assert.rejects(t.broker.handle('open', ['/data/late/config', 'a']), enoent('/data/late/config'));
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.ro, 'config'), 'utf8'), 'ro');
    } finally { await t.done(); }
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
      // (and on Linux the file the refused copy made there is gone)
      if (process.platform === 'linux') assert.strictEqual(fs.existsSync(out), false, 'the destination the refused copy made is gone');
    } finally { await t.done(); }
  });

  // (a creating open refused after it, whose file is removed: its new
  // entry is given back -- Linux, where the removal is made)
  it('a refused creating open whose file is removed gives its quota entry back', async function() {
    if (process.platform !== 'linux') return this.skip();
    const quota = new Quota({maxBytes: 1 << 20, maxEntries: 100, enforce: true, report: () => {}});
    const t = await setup('enforce', plantParent('late', 'outside'), quota);
    try {
      await assert.rejects(t.broker.handle('open', ['/data/late/made-new', 'a']), enoent('/data/late/made-new'));
      assert.strictEqual(fs.existsSync(path.join(t.dirs.outside, 'made-new')), false);
      assert.strictEqual(quota.entries, 0);
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

  // (the FB2 follow-up, ruled 11-10 (L1): a leaf that is a link, appeared
  // with its parent in the race that left checkHost nothing to decide, is
  // refused under enforce wherever it leads -- reported as link-appeared,
  // never as an escape; the leaf check runs ahead of /proc's, on every
  // platform)
  it('a leaf that is a link, appeared with its parent, is refused wherever it leads, reported as link-appeared', async () => {
    for (const [target, flags] of [['data', 'r'], ['ro', 'r'], ['ro', 'r+'], ['outside', 'r']]) {
        const t = await setup('enforce', (syscall, host, dirs) => {
          if (syscall === 'open' && path.basename(path.dirname(host)) === 'late') {
            fs.mkdirSync(path.dirname(host));
            const file = path.join(dirs[target], {data: 'inside-file', ro: 'config', outside: 'secret'}[target]);
            if (target === 'data') fs.writeFileSync(file, 'inside');
            fs.symlinkSync(file, host);
          }
        });
        try {
          await assert.rejects(t.broker.handle('open', ['/data/late/leaf', flags]), enoent('/data/late/leaf'), `${target} ${flags}`);
          assert.ok(t.reports.includes('link-appeared /data/late/leaf'), `${target} ${flags}: ${t.reports.join(', ')}`);
          assert.ok(!t.reports.some((r) => r.startsWith('escape')), `${target} ${flags}: ${t.reports.join(', ')}`);
          assert.strictEqual(t.broker.fds.size, 0);
        } finally { await t.done(); }
      }
  });

  // (the high review of #466, item 1: the same race with the parent there --
  // no leaf when checkHost ran ({parent}), a link planted before the open --
  // refused as link-appeared wherever it leads: outside, in this root, to a
  // denied file in it)
  it('a leaf link planted in an existing parent after the check is refused as link-appeared, wherever it leads', async () => {
    for (const [target, flags] of [['outside/secret', 'r'], ['data/inside-file', 'r'], ['data/denied-secret', 'r'], ['data/inside-file', 'r+']]) {
      const t = await setup('enforce', (syscall, host, dirs) => {
        if (syscall === 'open' && path.basename(host) === 'planted') {
          const [root, name] = target.split('/');
          if (name === 'inside-file') fs.writeFileSync(path.join(dirs.data, name), 'inside');
          fs.symlinkSync(path.join(dirs[root], name), host);
        }
      }, null, ['denied-secret']);
      try {
        await assert.rejects(t.broker.handle('open', ['/data/planted', flags]), enoent('/data/planted'), `${target} ${flags}`);
        assert.ok(t.reports.includes('link-appeared /data/planted'), `${target} ${flags}: ${t.reports.join(', ')}`);
        assert.strictEqual(t.broker.fds.size, 0);
      } finally { await t.done(); }
    }
    // (the denied file by its own name: refused as place() refuses it)
    const t = await setup('enforce', () => {}, null, ['denied-secret']);
    try {
      await assert.rejects(t.broker.handle('open', ['/data/denied-secret', 'r']), (e) => e.code === 'EACCES');
    } finally { await t.done(); }
  });

  // (ruled D1: a name that is a link to nothing when checkHost runs is
  // refused under enforce before the open -- (a) leading outside, nothing is
  // made there; (b) pointed in the race at a denied file in the root, it is
  // never read -- reported link-dangling, its errno first)
  it('an open of a link to nothing is refused under enforce before it follows: nothing made outside, no denied file read', async () => {
    const t = await setup('enforce', (syscall, host, dirs) => {
      // ((b): pointed, after the check, at the denied file)
      if (syscall === 'open' && path.basename(host) === 'dangling-repointed') {
        fs.unlinkSync(host);
        fs.symlinkSync(path.join(dirs.data, 'denied-secret'), host);
      }
    }, null, ['denied-secret']);
    try {
      fs.symlinkSync(path.join(t.dirs.outside, 'made-by-link'), path.join(t.dirs.data, 'dangling-out'));
      await assert.rejects(t.broker.handle('open', ['/data/dangling-out', 'w']), enoent('/data/dangling-out'));
      assert.strictEqual(fs.existsSync(path.join(t.dirs.outside, 'made-by-link')), false, 'nothing made outside');
      fs.symlinkSync(path.join(t.dirs.data, 'nothing-yet'), path.join(t.dirs.data, 'dangling-repointed'));
      await assert.rejects(t.broker.handle('open', ['/data/dangling-repointed', 'r']), enoent('/data/dangling-repointed'));
      for (const v of ['/data/dangling-out', '/data/dangling-repointed']) assert.ok(t.reports.includes(`link-dangling ENOENT ${v}`), t.reports.join(', '));
      assert.strictEqual(t.broker.fds.size, 0);
    } finally { await t.done(); }
  });

  it('audit reports an open of a link to nothing and opens it as before', async () => {
    const t = await setup('audit', () => {});
    try {
      fs.symlinkSync('made-inside', path.join(t.dirs.data, 'dangling-in'));
      const fd = await t.broker.handle('open', ['/data/dangling-in', 'w']);
      await t.broker.handle('close', [fd]);
      assert.ok(fs.existsSync(path.join(t.dirs.data, 'made-inside')));
      assert.ok(t.reports.includes('link-dangling ENOENT /data/dangling-in'), t.reports.join(', '));
    } finally { await t.done(); }
  });

  it('audit does not refuse it: the check after open is enforce-only, as before', async () => {
    const t = await setup('audit', plantParent('late', 'outside'));
    try {
      const fd = await t.broker.handle('open', ['/data/late/secret', 'r']);
      await t.broker.handle('close', [fd]);
    } finally { await t.done(); }
  });

  // (a file swapped after the check for one whose inode number differs only
  // past 2^53, as a Windows file index can: as Numbers they compare alike,
  // and the open would be taken as the file checked)
  it('a file swapped after the check is refused even when the two inode numbers collide as Numbers', async () => {
    const X1 = (2n ** 60n) + 1n;
    const X2 = (2n ** 60n) + 2n;
    const t = await setup('enforce', (syscall, host, dirs) => {
      if (syscall === 'open' && path.basename(host) === 'f') {
        fs.writeFileSync(path.join(dirs.data, 'g'), 'other');
        fs.renameSync(path.join(dirs.data, 'g'), host);
      }
    });
    fs.writeFileSync(path.join(t.dirs.data, 'f'), 'mine');
    const fake = (st, big, x) => {
      Object.defineProperty(st, 'ino', {value: big ? x : Number(x), configurable: true});
      Object.defineProperty(st, 'dev', {value: big ? 1n : 1, configurable: true});
      return st;
    };
    const realLstat = fs.promises.lstat;
    const probe = await fs.promises.open(__filename);
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    const realStat = proto.stat;
    fs.promises.lstat = async function(p, o) {
      const st = await realLstat.call(this, p, o);
      return path.basename(String(p)) === 'f' ? fake(st, o != null && o.bigint === true, X1) : st;
    };
    proto.stat = async function(o) { return fake(await realStat.call(this, o), o != null && o.bigint === true, X2); };
    try {
      await assert.rejects(t.broker.handle('open', ['/data/f', 'r']), enoent('/data/f'));
      assert.ok(t.reports.includes('escape /data/f'), t.reports.join(', '));
      assert.strictEqual(t.broker.fds.size, 0);
    } finally {
      fs.promises.lstat = realLstat;
      proto.stat = realStat;
      await t.done();
    }
  });
});

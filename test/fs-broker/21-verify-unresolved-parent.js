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
    outside: path.join(base, 'outside'), ro: path.join(base, 'ro'), rw: path.join(base, 'rw')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  fs.writeFileSync(path.join(dirs.outside, 'secret'), 'no');
  fs.writeFileSync(path.join(dirs.ro, 'config'), 'ro');
  fs.writeFileSync(path.join(dirs.data, 'denied-secret'), 'denied');
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp,
    declared: [{path: dirs.ro, access: 'r'}, {path: dirs.rw, access: 'rw'}], protectedPaths: []});
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

  // (the medium review of 6c55f584: copyfile's source refused as an open's
  // is; an exclusive create follows no link, EEXIST as ever, unreported;
  // a missing source still fails on the source)
  it('D1 by copyfile and by exclusive creates: the source refused, an exclusive create EEXIST, a missing source named', async () => {
    const t = await setup('enforce', () => {});
    try {
      fs.symlinkSync(path.join(t.dirs.outside, 'secret'), path.join(t.dirs.data, 'src-link'));
      fs.unlinkSync(path.join(t.dirs.outside, 'secret'));
      fs.writeFileSync(path.join(t.dirs.data, 'plain'), 'p');
      await assert.rejects(t.broker.handle('copyFile', ['/data/src-link', '/data/out']), (e) => e.code === 'ENOENT');
      assert.ok(t.reports.includes('link-dangling ENOENT /data/src-link'), t.reports.join(', '));
      fs.symlinkSync('nothing-here', path.join(t.dirs.data, 'lock'));
      await assert.rejects(t.broker.handle('open', ['/data/lock', 'wx']), (e) => e.code === 'EEXIST');
      await assert.rejects(t.broker.handle('copyFile', ['/data/plain', '/data/lock', fs.constants.COPYFILE_EXCL]), (e) => e.code === 'EEXIST');
      assert.ok(!t.reports.includes('link-dangling ENOENT /data/lock'), t.reports.join(', '));
      // (O_EXCL without O_CREAT follows a link like any open: refused as one)
      await assert.rejects(t.broker.handle('open', ['/data/lock', fs.constants.O_RDONLY | fs.constants.O_EXCL]), enoent('/data/lock'));
      assert.ok(t.reports.includes('link-dangling ENOENT /data/lock'), t.reports.join(', '));
      await assert.rejects(t.broker.handle('copyFile', ['/data/missing', '/data/lock']), (e) => e.code === 'ENOENT' && e.path === '/data/missing');
    } finally { await t.done(); }
  });

  // (descriptors: a refused open that held one -- link-appeared, escape --
  // closes it exactly once; one refused before any open -- EISDIR by the
  // kernel, link-dangling -- holds none. The process's own count the same
  // after as before, on Linux, where it can be read)
  it('refused opens leave the process\'s descriptors as they were', async function() {
    if (process.platform !== 'linux') return this.skip();
    const count = () => fs.readdirSync('/proc/self/fd').length;
    const t = await setup('enforce', (syscall, host, dirs) => {
      if (syscall === 'open' && path.basename(host) === 'planted') fs.symlinkSync(path.join(dirs.outside, 'secret'), host);
      if (syscall === 'open' && path.basename(path.dirname(host)) === 'late') fs.symlinkSync(dirs.outside, path.dirname(host));
    });
    try {
      fs.mkdirSync(path.join(t.dirs.data, 'adir'));
      fs.symlinkSync(path.join(t.dirs.outside, 'nope'), path.join(t.dirs.data, 'dangling'));
      const before = count();
      for (let i = 0; i < 3; i++) {
        await assert.rejects(t.broker.handle('open', ['/data/planted', 'r']), enoent('/data/planted'));
        fs.unlinkSync(path.join(t.dirs.data, 'planted'));
        await assert.rejects(t.broker.handle('open', ['/data/late/secret', 'r']), enoent('/data/late/secret'));
        fs.unlinkSync(path.join(t.dirs.data, 'late'));
        await assert.rejects(t.broker.handle('open', ['/data/adir', 'r+']), (e) => e.code === 'EISDIR');
        await assert.rejects(t.broker.handle('open', ['/data/dangling', 'w']), enoent('/data/dangling'));
      }
      assert.strictEqual(count(), before);
      assert.strictEqual(t.broker.fds.size, 0);
    } finally { await t.done(); }
  });

  // (#466's second high round: the kernel never follows a leaf link that
  // checkHost didn't see -- O_NOFOLLOW wherever it saw no link there -- so
  // nothing is made outside: (a) a link planted where it saw nothing,
  // through the EEXIST fallback; (b) a plain file swapped for a link before
  // an append; refused as link-appeared. POSIX, where O_NOFOLLOW is.)
  it('a link that appears where checkHost saw no link makes nothing outside: the kernel never follows it', async function() {
    if (fs.constants.O_NOFOLLOW === undefined) return this.skip();
    for (const [name, flags, plain] of [['appeared', 'w', false], ['swapped', 'a', true]]) {
      const t = await setup('enforce', (syscall, host, dirs) => {
        if (syscall === 'open' && path.basename(host) === name) {
          if (plain) fs.unlinkSync(host);
          fs.symlinkSync(path.join(dirs.outside, `made-${name}`), host);
        }
      });
      try {
        if (plain) fs.writeFileSync(path.join(t.dirs.data, name), 'plain');
        await assert.rejects(t.broker.handle('open', [`/data/${name}`, flags]), enoent(`/data/${name}`), name);
        assert.strictEqual(fs.existsSync(path.join(t.dirs.outside, `made-${name}`)), false, `${name}: nothing made outside`);
        assert.ok(t.reports.includes(`link-appeared /data/${name}`), `${name}: ${t.reports.join(', ')}`);
      } finally { await t.done(); }
    }
  });

  // (#466's second high round, 3: a denied file landing at the name in the
  // race -- a hard link to it, same dev and ino -- is refused by the
  // opened file's own identity)
  it('a hard link to a denied file, made at the name after the check, is refused', async () => {
    const t = await setup('enforce', (syscall, host, dirs) => {
      if (syscall === 'open' && path.basename(host) === 'hard') fs.linkSync(path.join(dirs.data, 'denied-secret'), host);
    }, null, ['denied-secret']);
    try {
      await assert.rejects(t.broker.handle('open', ['/data/hard', 'r']), (e) => e.code === 'EACCES' && e.path === '/data/hard');
      assert.ok(t.reports.includes('denied /data/hard'), t.reports.join(', '));
      assert.strictEqual(t.broker.fds.size, 0);
    } finally { await t.done(); }
  });

  // (#466's second high round, 4: under audit no write leaves the module's
  // own area, so a creating write through a link to nothing is refused
  // too, reported; a read is unaffected)
  it('audit refuses a creating write through a link to nothing, and reports it', async () => {
    const t = await setup('audit', () => {});
    try {
      fs.symlinkSync(path.join(t.dirs.outside, 'audit-made'), path.join(t.dirs.data, 'dangling-audit'));
      await assert.rejects(t.broker.handle('open', ['/data/dangling-audit', 'w']), (e) => e.code === 'ENOENT' || e.code === 'EACCES');
      assert.strictEqual(fs.existsSync(path.join(t.dirs.outside, 'audit-made')), false);
      assert.ok(t.reports.includes('link-dangling ENOENT /data/dangling-audit'), t.reports.join(', '));
      await assert.rejects(t.broker.handle('open', ['/data/dangling-audit', 'r']), (e) => e.code === 'ENOENT');
    } finally { await t.done(); }
  });

  // (#466's second high round, 5: a refused copy settles its quota from
  // what it left, as open does: its destination's new entry given back
  // when removed, kept counted when it stays -- here its removal made to
  // fail, as off Linux)
  it('a refused copy keeps its destination\'s entry counted when the file stays, and gives it back when removed', async function() {
    if (process.platform !== 'linux') return this.skip();
    for (const removable of [true, false]) {
      const quota = new Quota({maxBytes: 1 << 20, maxEntries: 100, enforce: true, report: () => {}});
      const t = await setup('enforce', (syscall, host, dirs) => {
        if (syscall === 'copyfile' && path.basename(path.dirname(host)) === 'late') fs.symlinkSync(dirs.outside, path.dirname(host));
      }, quota);
      const realUnlink = fs.promises.unlink;
      if (!removable) fs.promises.unlink = async() => { throw Object.assign(new Error('kept'), {code: 'EPERM'}); };
      try {
        fs.writeFileSync(path.join(t.dirs.data, 'src'), 'payload');
        await assert.rejects(t.broker.handle('copyFile', ['/data/src', '/data/late/out']), enoent('/data/late/out'));
        assert.strictEqual(fs.existsSync(path.join(t.dirs.outside, 'out')), !removable);
        assert.strictEqual(quota.entries, removable ? 0 : 1, `removable ${removable}`);
      } finally { fs.promises.unlink = realUnlink; await t.done(); }
    }
  });

  // (#466's second high round, 6: an open that completes after closeAll
  // closes its descriptor and answers EIO, never registered)
  it('an open completing after closeAll is closed, truncates nothing, and answers EIO', async () => {
    const t = await setup('enforce', (syscall, host) => {
      if (syscall === 'open' && path.basename(host) === 'late-close') t.broker.closeAll();
    });
    const count = () => (process.platform === 'linux' ? fs.readdirSync('/proc/self/fd').length : 0);
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'late-close'), 'kept');
      const before = count();
      await assert.rejects(t.broker.handle('open', ['/data/late-close', 'w']), (e) => e.code === 'EIO');
      assert.strictEqual(t.broker.fds.size, 0);
      assert.strictEqual(count(), before, 'its descriptor closed');
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'late-close'), 'utf8'), 'kept', 'nothing truncated');
    } finally { await t.done(); }
  });

  // (the medium review of b0076daf: 1, a closeAll during the O_TRUNC
  // truncate -- the open still answers EIO, never registered; 2, a file that
  // appeared in the race with more than one link refused for writing, the
  // general rule that covers a hard link to a file protected by its path
  // alone (a pin record), whatever file it is; 3,
  // copyfile's source swapped for a link after the check -- never followed;
  // 4, copyfile onto an in-root link to a file -- its quota from that file)
  it('the open path\'s last gaps: closeAll mid-truncate, a hard link appeared, copyfile\'s source, copyfile\'s old size', async function() {
    if (fs.constants.O_NOFOLLOW === undefined || process.platform !== 'linux') return this.skip();
    const count = () => fs.readdirSync('/proc/self/fd').length;
    // 1
    {
      const t = await setup('enforce', () => {});
      const probeFh = await fs.promises.open(__filename);
      const proto = Object.getPrototypeOf(probeFh);
      await probeFh.close();
      const realTruncate = proto.truncate;
      proto.truncate = async function(...a) { t.broker.closeAll(); return realTruncate.apply(this, a); };
      try {
        fs.writeFileSync(path.join(t.dirs.data, 'mid'), 'x');
        const before = count();
        await assert.rejects(t.broker.handle('open', ['/data/mid', 'w']), (e) => e.code === 'EIO');
        assert.strictEqual(t.broker.fds.size, 0);
        assert.strictEqual(count(), before);
      } finally { proto.truncate = realTruncate; await t.done(); }
    }
    // 2
    {
      const t = await setup('enforce', (syscall, host, dirs) => {
        if (syscall === 'open' && path.basename(host) === 'hl') fs.linkSync(path.join(dirs.data, 'protected'), host);
      });
      try {
        fs.writeFileSync(path.join(t.dirs.data, 'protected'), 'keep');
        await assert.rejects(t.broker.handle('open', ['/data/hl', 'r+']), (e) => e.code === 'EACCES');
        assert.ok(t.reports.includes('denied /data/hl'), t.reports.join(', '));
      } finally { await t.done(); }
    }
    // 3
    {
      const t = await setup('enforce', (syscall, host, dirs) => {
        if (syscall === 'copyfile' && path.basename(host) === 'src2') {
          fs.unlinkSync(host);
          fs.symlinkSync(path.join(dirs.outside, 'secret'), host);
        }
      });
      try {
        fs.writeFileSync(path.join(t.dirs.data, 'src2'), 'plain');
        await assert.rejects(t.broker.handle('copyFile', ['/data/src2', '/data/out2']), (e) => e.code === 'ENOENT');
        assert.ok(t.reports.includes('link-appeared /data/src2'), t.reports.join(', '));
        assert.strictEqual(fs.existsSync(path.join(t.dirs.data, 'out2')), false);
      } finally { await t.done(); }
    }
    // 4
    {
      const quota = new Quota({maxBytes: 1 << 20, maxEntries: 100, enforce: true, report: () => {}, bytes: 1000 + 10, entries: 3});
      const t = await setup('enforce', () => {}, quota);
      try {
        fs.writeFileSync(path.join(t.dirs.data, 'big'), 'b'.repeat(1000));
        fs.writeFileSync(path.join(t.dirs.data, 'small'), 's'.repeat(10));
        fs.symlinkSync(path.join(t.dirs.data, 'big'), path.join(t.dirs.data, 'l'));
        await t.broker.handle('copyFile', ['/data/small', '/data/l']);
        assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'big'), 'utf8'), 's'.repeat(10));
        assert.strictEqual(quota.bytes, 10 + 10, 'the real file\'s old size given back');
        assert.strictEqual(quota.entries, 3);
      } finally { await t.done(); }
    }
  });

  // (the medium review of 9d16b00b: copyfile onto a link into a declared rw
  // root, which the quota doesn't count -- the size there is never given
  // back from /data's count)
  it('copyfile onto a link into an uncounted root counts in /data, by the root its path names, and gives back nothing it never counted', async () => {
    const quota = new Quota({maxBytes: 1 << 20, maxEntries: 100, enforce: true, report: () => {}, bytes: 10, entries: 2});
    const t = await setup('enforce', () => {}, quota);
    try {
      fs.writeFileSync(path.join(t.dirs.rw, 'big'), 'b'.repeat(1000));
      fs.writeFileSync(path.join(t.dirs.data, 'small'), 's'.repeat(10));
      fs.symlinkSync(path.join(t.dirs.rw, 'big'), path.join(t.dirs.data, 'l2'));
      await t.broker.handle('copyFile', ['/data/small', '/data/l2']);
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.rw, 'big'), 'utf8'), 's'.repeat(10), 'the copy landed in the rw file');
      // (ruled Q1: counted by the root its path names, /data -- the 10 bytes
      // written there; the rw file's 1000 never counted, never given back)
      assert.strictEqual(quota.bytes, 20);
      assert.strictEqual(quota.entries, 2);
    } finally { await t.done(); }
  });

  // (the medium review of 4ac385de: the module's own O_NOFOLLOW on an
  // in-root link answers ELOOP, as on master -- never the link's target)
  it('an open with the module\'s own O_NOFOLLOW on an in-root link answers ELOOP, as master does', async function() {
    if (fs.constants.O_NOFOLLOW === undefined) return this.skip();
    const t = await setup('enforce', () => {});
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'target'), 't');
      fs.symlinkSync(path.join(t.dirs.data, 'target'), path.join(t.dirs.data, 'lnk'));
      await assert.rejects(t.broker.handle('open', ['/data/lnk', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW]), (e) => e.code === 'ELOOP');
      await assert.rejects(t.broker.handle('open', ['/data/lnk', fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW]), (e) => e.code === 'ELOOP');
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'target'), 'utf8'), 't', 'the target untouched');
      // (a dangling link, the lock idiom: ELOOP too, never link-dangling)
      fs.symlinkSync(path.join(t.dirs.data, 'nothing'), path.join(t.dirs.data, 'lock'));
      await assert.rejects(t.broker.handle('open', ['/data/lock', fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW]), (e) => e.code === 'ELOOP');
      assert.ok(!t.reports.some((r) => r.startsWith('link-appeared') || r.startsWith('link-dangling')), t.reports.join(', '));
      assert.strictEqual(t.broker.fds.size, 0);
    } finally { await t.done(); }
  });

  // (the medium review of 2fd8af4f: a link that appears after the check is
  // reported as link-appeared whether the module asked O_NOFOLLOW -- its
  // ELOOP passed on -- or not -- ENOENT; and where the check reached a file
  // through a link, the real file becoming a link is one too)
  it('a link that appeared after the check is reported, with the module\'s O_NOFOLLOW or without, at the name or at the real path', async function() {
    if (fs.constants.O_NOFOLLOW === undefined) return this.skip();
    const t = await setup('enforce', (syscall, host, dirs) => {
      if (syscall !== 'open') return;
      if (path.basename(host) === 'appears') fs.symlinkSync(path.join(dirs.data, 'other'), host);
      if (path.basename(host) === 'via') {
        fs.unlinkSync(path.join(dirs.data, 'realfile'));
        fs.symlinkSync(path.join(dirs.data, 'other'), path.join(dirs.data, 'realfile'));
      }
    });
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'other'), 'o');
      await assert.rejects(t.broker.handle('open', ['/data/appears', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW]), (e) => e.code === 'ELOOP');
      assert.ok(t.reports.includes('link-appeared /data/appears'), t.reports.join(', '));
      fs.writeFileSync(path.join(t.dirs.data, 'realfile'), 'r');
      fs.symlinkSync(path.join(t.dirs.data, 'realfile'), path.join(t.dirs.data, 'via'));
      await assert.rejects(t.broker.handle('open', ['/data/via', 'r']), enoent('/data/via'));
      assert.ok(t.reports.includes('link-appeared /data/via'), t.reports.join(', '));
      assert.strictEqual(t.broker.fds.size, 0);
    } finally { await t.done(); }
  });

  // (ruled R-a, and the medium review of 5df938b7: where the check saw a
  // file -- through an in-root link it followed, or plain with a parent --
  // the open never creates: a link re-pointed outside, or a parent swapped
  // for a link outside, in between, makes nothing there)
  it('a seen link re-pointed, or a parent swapped, after the check creates nothing outside: the approved file opens, or nothing', async function() {
    if (fs.constants.O_NOFOLLOW === undefined) return this.skip();
    const t = await setup('enforce', (syscall, host, dirs) => {
      if (syscall !== 'open') return;
      if (path.basename(host) === 'seen-link') {
        fs.unlinkSync(host);
        fs.symlinkSync(path.join(dirs.outside, 'via-link'), host);
      }
      if (path.basename(path.dirname(host)) === 'sub') {
        fs.renameSync(path.dirname(host), path.join(dirs.data, 'sub-moved'));
        fs.symlinkSync(dirs.outside, path.dirname(host));
      }
    });
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'real'), 'real');
      fs.symlinkSync(path.join(t.dirs.data, 'real'), path.join(t.dirs.data, 'seen-link'));
      // (the real file the check approved is what opens: the re-pointed
      // link is never followed)
      const fd = await t.broker.handle('open', ['/data/seen-link', 'a']);
      await t.broker.handle('write', [fd, Buffer.from('+'), null]);
      await t.broker.handle('close', [fd]);
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'real'), 'utf8'), 'real+');
      assert.strictEqual(fs.existsSync(path.join(t.dirs.outside, 'via-link')), false, 'nothing made through the re-pointed link');
      fs.mkdirSync(path.join(t.dirs.data, 'sub'));
      fs.writeFileSync(path.join(t.dirs.data, 'sub', 'f'), 'f');
      await assert.rejects(t.broker.handle('open', ['/data/sub/f', 'a']));
      assert.strictEqual(fs.existsSync(path.join(t.dirs.outside, 'f')), false, 'nothing made through the swapped parent');
      assert.strictEqual(t.broker.fds.size, 0);
    } finally { await t.done(); }
  });

  it('audit reports a read of a link to nothing, which finds nothing, as before', async () => {
    const t = await setup('audit', () => {});
    try {
      fs.symlinkSync('made-inside', path.join(t.dirs.data, 'dangling-in'));
      await assert.rejects(t.broker.handle('open', ['/data/dangling-in', 'r']), (e) => e.code === 'ENOENT');
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

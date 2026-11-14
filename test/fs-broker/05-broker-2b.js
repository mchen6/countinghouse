const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {mkdtemp} = require('../helpers/test-tmp');

async function setup(mode, extra) {
  const base = mkdtemp('broker2b-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  const reports = [];
  const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await ns.prepare();
  const broker = new FsBroker(Object.assign({name: 'm', mode: mode, namespace: ns, cwd: '/',
    report: (r, t) => reports.push(`${r} ${t}`)}, extra || {}));
  return {base, dirs, broker, reports, done: () => broker.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
}

const quick = async(fn) => {
  const t0 = Date.now();
  let out;
  try { out = {ok: await fn()}; } catch (e) { out = {code: e.code}; }
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  return out;
};

const WIN = process.platform === 'win32';

describe('fs-broker 05: broker additions for the bridge', function() {
  this.timeout(10000);

  it('runs each operation through schedule(), after taking the lock', async () => {
    const events = [];
    const t = await setup('enforce', {schedule: (fn) => { events.push('slot'); return fn(); }});
    try {
      await t.broker.handle('stat', ['/data']);
      await t.broker.handle('mkdir', ['/data/d', {}]);
      assert.deepStrictEqual(events, ['slot', 'slot']);
    } finally { await t.done(); }
  });

  it('readFile returns a whole file in one call, and EFBIG past 16 MB', async () => {
    const t = await setup('enforce');
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'small'), 'hello');
      assert.strictEqual(Buffer.from(await t.broker.handle('readFile', ['/data/small', 'r'])).toString(), 'hello');
      fs.writeFileSync(path.join(t.dirs.data, 'big'), Buffer.alloc(16 * 1024 * 1024 + 10));
      await assert.rejects(t.broker.handle('readFile', ['/data/big', 'r']), (e) => e.code === 'EFBIG' && e.path === '/data/big');
      assert.strictEqual(t.broker.fds.size, 0, 'readFile leaves no descriptor open');
    } finally { await t.done(); }
  });

  // procfs is Linux's (no /proc on Windows or macOS)
  (process.platform === 'linux' ? it : it.skip)('readFile reads files whose stat size is 0 but which have content (procfs)', async () => {
    const t = await setup('audit');
    try {
      const r = Buffer.from(await t.broker.handle('readFile', ['/proc/self/status', 'r'])).toString();
      assert.ok(r.includes('Name:'), r.slice(0, 100));
    } finally { await t.done(); }
  });

  // Windows makes no FIFO in a directory: its pipes and devices are named
  // \\.\pipe\..., \\.\NUL and so on, which are no namespace paths. Refused
  // under enforce, without blocking.
  (WIN ? it : it.skip)('Windows, enforce: a pipe or device path is refused, without blocking', async () => {
    const t = await setup('enforce');
    try {
      for (const p of ['\\\\.\\pipe\\ch-probe', '\\\\.\\NUL', 'NUL', '\\\\?\\GLOBALROOT\\Device\\Null', 'CON']) {
        const r = await quick(() => t.broker.handle('open', [p, 'r']));
        assert.ok(r.code === 'ENOENT' || r.code === 'EPERM', `${p}: ${JSON.stringify(r)}`);
        const c = await quick(() => t.broker.handle('copyFile', [p, '/data/copy']));
        assert.ok(c.code === 'ENOENT' || c.code === 'EPERM', `copyFile ${p}: ${JSON.stringify(c)}`);
      }
      assert.strictEqual(t.broker.fds.size, 0);
      assert.ok(!fs.existsSync(path.join(t.dirs.data, 'copy')));
    } finally { await t.done(); }
  });

  // Under off and audit a path outside the namespace passes through to the
  // host by design (audit logs it): there a pipe or device path is opened
  // and copied as the host has it, and never blocks (CON, the console, is
  // left out: it would wait for input like a terminal anywhere).
  (WIN ? it : it.skip)('Windows, off and audit: a pipe or device path passes through without blocking', async () => {
    for (const mode of ['off', 'audit']) {
      const t = await setup(mode);
      try {
        for (const p of ['\\\\.\\pipe\\ch-probe-none', '\\\\.\\NUL', 'NUL']) {
          const c = await quick(() => t.broker.handle('copyFile', [p, '/data/copy']));
          assert.ok(c != null && (c.ok !== undefined || typeof(c.code) === 'string'), `${mode} copyFile ${p}: ${JSON.stringify(c)}`);
        }
      } finally { await t.done(); }
    }
  });

  (WIN ? it.skip : it)('enforce: a FIFO is EPERM, without blocking', async () => {
    const t = await setup('enforce');
    try {
      execFileSync('mkfifo', [path.join(t.dirs.data, 'pipe')]);
      assert.deepStrictEqual(await quick(() => t.broker.handle('open', ['/data/pipe', 'r'])), {code: 'EPERM'});
      assert.strictEqual(t.broker.fds.size, 0);
    } finally { await t.done(); }
  });

  (WIN ? it.skip : it)('audit: a FIFO is reported and opened without blocking, whatever the flags', async () => {
    const t = await setup('audit');
    try {
      execFileSync('mkfifo', [path.join(t.dirs.data, 'pipe')]);
      const r = await quick(() => t.broker.handle('open', ['/data/pipe', 'r']));
      await t.broker.handle('close', [r.ok]);
      const as = await quick(() => t.broker.handle('open', ['/data/pipe', 'as']));
      assert.ok(as.ok != null || as.code === 'ENXIO', JSON.stringify(as));   // no reader: ENXIO at once
      assert.ok(t.reports.includes('special /data/pipe'), t.reports.join('\n'));
    } finally { await t.done(); }
  });

  (WIN ? it.skip : it)('copyFile refuses a FIFO source in every mode, without blocking', async () => {
    for (const mode of ['off', 'audit', 'enforce']) {
      const t = await setup(mode);
      try {
        execFileSync('mkfifo', [path.join(t.dirs.data, 'pipe')]);
        assert.deepStrictEqual(await quick(() => t.broker.handle('copyFile', ['/data/pipe', '/data/copy'])), {code: 'EPERM'}, mode);
      } finally { await t.done(); }
    }
  });

  it('copyFile copies content and honours COPYFILE_EXCL', async () => {
    const t = await setup('enforce');
    try {
      fs.writeFileSync(path.join(t.dirs.data, 'a'), 'abc');
      await t.broker.handle('copyFile', ['/data/a', '/data/b', 0]);
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'b'), 'utf8'), 'abc');
      await assert.rejects(t.broker.handle('copyFile', ['/data/a', '/data/b', fs.constants.COPYFILE_EXCL]), (e) => e.code === 'EEXIST' && e.path === '/data/a');
    } finally { await t.done(); }
  });

  it('a truncating open swapped toward another file is refused before anything is truncated', async () => {
    let victim = null;
    const t = await setup('enforce', {hooks: {afterCheck: (syscall, host) => {
      if (syscall === 'open' && host.replace(/\\/g, '/').endsWith('/target')) {
        fs.rmSync(host);
        fs.symlinkSync(victim, host);
      }
    }}});
    try {
      victim = path.join(t.base, 'victim');
      fs.writeFileSync(victim, 'keep me');
      fs.writeFileSync(path.join(t.dirs.data, 'target'), 'x');
      await assert.rejects(t.broker.handle('open', ['/data/target', 'w']), (e) => e.code === 'ENOENT');
      assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep me');
    } finally { await t.done(); }
  });

  it('a listing past maxEntries is ENOBUFS, recursive or not', async () => {
    const t = await setup('enforce', {maxEntries: 3});
    try {
      fs.mkdirSync(path.join(t.dirs.data, 'sub'));
      ['a', 'b', 'sub/c', 'sub/d'].forEach((f) => fs.writeFileSync(path.join(t.dirs.data, f), 'x'));
      assert.strictEqual((await t.broker.handle('readdir', ['/data', {}])).length, 3);
      await assert.rejects(t.broker.handle('readdir', ['/data', {recursive: true}]), (e) => e.code === 'ENOBUFS');
      fs.writeFileSync(path.join(t.dirs.data, 'e'), 'x');
      await assert.rejects(t.broker.handle('readdir', ['/data', {}]), (e) => e.code === 'ENOBUFS');
    } finally { await t.done(); }
  });
});

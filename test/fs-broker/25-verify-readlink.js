// Broker performance, proposal 2 (docs/superpowers/specs/2026-11-09-fs-
// broker-performance-design.md, section 4): under enforce, an open of a file
// that existed when checked, in /data or /tmp, is verified by its dev/ino
// alone, without the readlink of /proc/self/fd. Only this module (and the
// host, which the sandbox does not defend against) changes those trees, and
// each of its own exclusive operations clears its cache. Every open on a
// declared path keeps the readlink: in a shared rw directory another module
// can rename a host-made link that leads outside onto a directory name this
// broker has cached, and the readlink is then the only guard left.
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {mkdtemp} = require('../helpers/test-tmp');

const LINUX = process.platform === 'linux';

async function brokerOver(base, name, shared) {
  const dirs = {app: path.join(base, `${name}-app`), data: path.join(base, `${name}-data`), tmp: path.join(base, `${name}-tmp`)};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp,
    declared: [{path: shared, access: 'rw'}], protectedPaths: []});
  await namespace.prepare();
  return {dirs, broker: new FsBroker({name, mode: 'enforce', namespace, cwd: '/', report: () => {}})};
}

// The readlinks of /proc/self/fd made while fn runs.
async function readlinks(fn) {
  const orig = fsp.readlink;
  let n = 0;
  fsp.readlink = (p, ...a) => { if (String(p).startsWith('/proc/self/fd/')) n += 1; return orig(p, ...a); };
  try { await fn(); } finally { fsp.readlink = orig; }
  return n;
}

describe('fs-broker 25: the readlink after an enforce open (performance proposal 2)', function() {
  this.timeout(10000);
  let base = null;
  beforeEach(() => { base = mkdtemp('broker-p2-'); });
  afterEach(() => { fs.rmSync(base, {recursive: true, force: true}); });

  it('an open of an existing file in /data or /tmp makes no readlink; one on a declared path still does', async function() {
    if (!LINUX) this.skip();
    const shared = path.join(base, 'shared');
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'f'), 'shared');
    const {dirs, broker} = await brokerOver(base, 'm', shared);
    try {
      fs.writeFileSync(path.join(dirs.data, 'f'), 'data');
      fs.writeFileSync(path.join(dirs.tmp, 'f'), 'tmp');
      for (const p of ['/data/f', '/tmp/f']) {
        assert.strictEqual(await readlinks(async () => broker.handle('close', [await broker.handle('open', [p, 'r'])])), 0, p);
      }
      assert.strictEqual(await readlinks(async () => broker.handle('close', [await broker.handle('open', [`${shared}/f`, 'r'])])), 1, 'a declared path');
      // a create (no dev/ino to compare yet) keeps it
      assert.strictEqual(await readlinks(async () => broker.handle('close', [await broker.handle('open', ['/data/new', 'w'])])), 1, 'a create');
    } finally {
      await broker.closeAll();
    }
  });

  it('a shared rw directory: another module renaming a host-made link that leads outside onto a cached name does not let an open out', async function() {
    if (!LINUX) this.skip();   // the readlink is Linux's
    const shared = path.join(base, 'shared');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(shared, 'sub'), {recursive: true});
    fs.writeFileSync(path.join(shared, 'sub', 'f'), 'inside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'f'), 'outside');
    fs.symlinkSync(outside, path.join(shared, 'hostlink'));   // made by a host process
    const a = await brokerOver(base, 'a', shared);
    const b = await brokerOver(base, 'b', shared);
    try {
      // b's open caches sub's real path
      await b.broker.handle('close', [await b.broker.handle('open', [`${shared}/sub/f`, 'r'])]);
      // a moves sub aside and renames the host's link onto its name
      await a.broker.handle('rename', [`${shared}/sub`, `${shared}/sub-old`]);
      await a.broker.handle('rename', [`${shared}/hostlink`, `${shared}/sub`]);
      // b's next open below the cached name lands outside: refused
      await assert.rejects(b.broker.handle('open', [`${shared}/sub/f`, 'r']), (e) => e.code === 'ENOENT');
    } finally {
      await a.broker.closeAll();
      await b.broker.closeAll();
    }
  });
});

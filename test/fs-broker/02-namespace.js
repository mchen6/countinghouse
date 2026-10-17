const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ns = require('../../lib/fs-broker/namespace');

// Paths that do not exist: prepare() keeps them as they are (real = host).
const CFG = {
  moduleRoot: '/srv/modules/weather', dataDir: '/srv/data/weather/data', tmpDir: '/srv/data/weather/tmp',
  declared: [{path: '/var/log/app', access: 'rw'}, {path: '/etc/weather', access: 'r'}],
  protectedPaths: ['/srv/countinghouse', '/srv/modules', '/srv/data', '/srv/countinghouse/auth.json']
};

async function prepared(cfg) {
  const n = ns.createNamespace(cfg);
  await n.prepare();
  return n;
}

function pick(r) {
  return {kind: r.kind, host: r.host, name: r.root.name, writable: r.root.writable};
}

describe('fs-broker 02: namespace', () => {
  it('maps the three virtual roots and declared paths, longest match first', async () => {
    const n = await prepared(CFG);
    assert.deepStrictEqual(pick(n.resolve('/app/handlers/x.js', '/')), {kind: 'root', host: '/srv/modules/weather/handlers/x.js', name: 'app', writable: false});
    assert.deepStrictEqual(pick(n.resolve('/data', '/')), {kind: 'root', host: '/srv/data/weather/data', name: 'data', writable: true});
    assert.deepStrictEqual(pick(n.resolve('/tmp/a/../b', '/')), {kind: 'root', host: '/srv/data/weather/tmp/b', name: 'tmp', writable: true});
    assert.deepStrictEqual(pick(n.resolve('/var/log/app/x.log', '/')), {kind: 'root', host: '/var/log/app/x.log', name: 'declared', writable: true});
    assert.deepStrictEqual(pick(n.resolve('/etc/weather/k', '/')), {kind: 'root', host: '/etc/weather/k', name: 'declared', writable: false});
  });

  it('does not treat a sibling with a common prefix as inside a root', async () => {
    const n = await prepared(CFG);
    assert.strictEqual(n.resolve('/database/x', '/').kind, 'outside');
    assert.strictEqual(n.resolve('/apps', '/').kind, 'outside');
  });

  it('synthesises ancestors that list only the next component, with its type', async () => {
    const n = await prepared(CFG);
    assert.deepStrictEqual(n.resolve('/', '/'), {kind: 'ancestor', virtual: '/',
      children: [{name: 'app', type: 'dir'}, {name: 'data', type: 'dir'}, {name: 'etc', type: 'dir'}, {name: 'tmp', type: 'dir'}, {name: 'var', type: 'dir'}]});
    assert.deepStrictEqual(n.resolve('/var/log', '/'), {kind: 'ancestor', virtual: '/var/log', children: [{name: 'app', type: 'dir'}]});
  });

  it('a declared root that is a file is listed as a file', async () => {
    // Not under os.tmpdir(): /tmp is itself a virtual root, and the validator
    // forbids declaring paths there.
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.ch-ns-')));
    try {
      fs.writeFileSync(path.join(base, 'w.conf'), 'x');
      const n = await prepared(Object.assign({}, CFG, {declared: [{path: path.join(base, 'w.conf'), access: 'r'}]}));
      const parent = n.resolve(base, '/');
      assert.deepStrictEqual(parent.children, [{name: 'w.conf', type: 'file'}]);
    } finally { fs.rmSync(base, {recursive: true, force: true}); }
  });

  it('a declared root that covers an ancestor answers as that root', async () => {
    const n = await prepared(Object.assign({}, CFG, {declared: [{path: '/var', access: 'r'}, {path: '/var/log/app', access: 'rw'}]}));
    assert.strictEqual(n.resolve('/var/log', '/').kind, 'root');
    assert.strictEqual(n.resolve('/var/log/app/x', '/').root.writable, true);
  });

  it('resolves relative paths against the given cwd', async () => {
    const n = await prepared(CFG);
    assert.strictEqual(n.resolve('handlers/x.js', '/app').host, '/srv/modules/weather/handlers/x.js');
    assert.strictEqual(n.resolve('x', '/home/u').kind, 'outside');
  });

  it('accepts Buffers and file: URLs', async () => {
    const n = await prepared(CFG);
    assert.strictEqual(n.resolve(Buffer.from('/data/x'), '/').host, '/srv/data/weather/data/x');
    assert.strictEqual(n.resolve(new URL('file:///tmp/y'), '/').host, '/srv/data/weather/tmp/y');
  });

  it('maps host paths back to virtual ones', async () => {
    const n = await prepared(CFG);
    assert.strictEqual(n.toVirtual('/srv/data/weather/tmp/q'), '/tmp/q');
    assert.strictEqual(n.toVirtual('/srv/modules/weather'), '/app');
    assert.strictEqual(n.toVirtual('/var/log/app/x'), '/var/log/app/x');
    assert.strictEqual(n.toVirtual('/etc/passwd'), null);
  });

  it('refuses a declared path that overlaps a protected path, either way round', async () => {
    const n = await prepared(Object.assign({}, CFG, {declared: [{path: '/srv', access: 'r'}, {path: '/srv/data/other', access: 'rw'}, {path: '/opt/ok', access: 'r'}]}));
    assert.deepStrictEqual(n.refused.map((r) => r.path), ['/srv', '/srv/data/other']);
    assert.strictEqual(n.resolve('/srv/data/other/x', '/').kind, 'outside');
    assert.strictEqual(n.resolve('/opt/ok/x', '/').kind, 'root');
  });

  // /home -> /var/home on Fedora Silverblue/CoreOS: textually disjoint, really the same.
  it('refuses an overlap that only shows after resolving symlinks', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ns-')));
    try {
      fs.mkdirSync(path.join(base, 'var', 'home', 'u', 'data'), {recursive: true});
      fs.symlinkSync(path.join(base, 'var', 'home'), path.join(base, 'home'));
      fs.mkdirSync(path.join(base, 'elsewhere'));
      fs.symlinkSync(path.join(base, 'var', 'home', 'u'), path.join(base, 'elsewhere', 'into-home'));
      const n = await prepared(Object.assign({}, CFG, {
        protectedPaths: [path.join(base, 'home', 'u', 'data')],
        declared: [{path: path.join(base, 'var'), access: 'r'}, {path: path.join(base, 'elsewhere', 'into-home'), access: 'rw'}]
      }));
      assert.deepStrictEqual(n.refused.map((r) => r.path).sort(), [path.join(base, 'elsewhere', 'into-home'), path.join(base, 'var')].sort());
    } finally { fs.rmSync(base, {recursive: true, force: true}); }
  });

  it('a root whose host path is a symlink maps its real paths back too', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ns-')));
    try {
      fs.mkdirSync(path.join(base, 'real-data'));
      fs.symlinkSync(path.join(base, 'real-data'), path.join(base, 'data-link'));
      const n = await prepared(Object.assign({}, CFG, {dataDir: path.join(base, 'data-link')}));
      assert.strictEqual(n.toVirtual(path.join(base, 'real-data', 'sub', 'x')), '/data/sub/x');
      assert.strictEqual(n.toVirtual(path.join(base, 'data-link', 'sub', 'x')), '/data/sub/x');
      assert.strictEqual(n.rootForReal(path.join(base, 'real-data', 'y')).name, 'data');
    } finally { fs.rmSync(base, {recursive: true, force: true}); }
  });
});

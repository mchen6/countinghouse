// Issue #40, round 3: on Windows store/05's module never loaded: "Cannot find
// module '\app\handlers\probeService\remember.js'". A module worker's /app is
// a virtual path, POSIX on every OS, and the handlers/ tree's paths were
// built with the platform's path functions. lib/fs-broker/identity.js
// pathFor picks path.posix for a path under /app and the platform's for any
// other; every place that builds a path under /app (the handlers/ walk, the
// handler map's schema and api files, CHUtil.loadFile, the validator, the
// load) uses it. These run on every system (the stdio job: ubuntu, macos,
// windows); store/05 on the Windows leg is the end-to-end proof.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {pathFor, resolveModulePath} = require('../../lib/fs-broker/identity');
const {loadConventionHandlers} = require('../../lib/handler-map');
const tmp = require('../helpers/test-tmp');

describe('stdio 06: paths under the module\'s /app (issue #40, round 3)', () => {
  it('a path under /app takes path.posix; any other path the platform\'s', () => {
    assert.strictEqual(pathFor('/app'), path.posix);
    assert.strictEqual(pathFor('/app/handlers/probeService/remember.js'), path.posix);
    assert.strictEqual(pathFor('/application/x.js'), path);
    assert.strictEqual(pathFor(os.tmpdir()), path);
    assert.strictEqual(pathFor(null), path);
  });

  it('built under /app, a handler\'s path is /app/handlers/<svc>/<action>.js, joined or resolved', () => {
    assert.strictEqual(pathFor('/app').join('/app', 'handlers', 'probeService', 'remember.js'), '/app/handlers/probeService/remember.js');
    assert.strictEqual(pathFor('/app/handlers/probeService/remember.js').resolve('/app/handlers/probeService/remember.js'),
      '/app/handlers/probeService/remember.js');
  });

  // CHUtil.loadFile's name: in a worker the cwd is VROOT, so a relative name
  // resolves under /app with the path functions of that base, not the
  // name's. process.cwd is stubbed for the case, never pinned for real.
  it('a relative module file name, with the cwd at /app, is /app/...; an absolute one is as given', () => {
    const cwd = process.cwd;
    process.cwd = () => '/app';
    try {
      assert.strictEqual(resolveModulePath('./device.js'), '/app/device.js');
      assert.strictEqual(resolveModulePath('handlers/probeService/remember.js'), '/app/handlers/probeService/remember.js');
      assert.strictEqual(resolveModulePath('/app/device.js'), '/app/device.js');
    } finally {
      process.cwd = cwd;
    }
    const host = path.join(os.tmpdir(), 'x.js');
    assert.strictEqual(resolveModulePath(host), path.resolve(host));
  });

  // The handlers/ walk over a module's /app, as a worker sees it: fs answers
  // for the virtual tree (stubbed here, as the broker answers there), and the
  // walk asks for each handler by its /app path.
  it('the handlers/ walk asks for each handler by its /app path, and the handler runs', () => {
    const tree = {'/app/handlers': ['probeService'], '/app/handlers/probeService': ['remember.js']};
    const saved = {existsSync: fs.existsSync, statSync: fs.statSync, readdirSync: fs.readdirSync};
    fs.existsSync = (p) => (p in tree ? true : saved.existsSync(p));
    fs.statSync = (p, o) => (p in tree ? {isDirectory: () => true} : saved.statSync(p, o));
    fs.readdirSync = (p, o) => (p in tree ? tree[p].slice() : saved.readdirSync(p, o));
    const asked = [];
    let map;
    try {
      map = loadConventionHandlers('/app', (file) => { asked.push(file); return (args) => ({remembered: args.value}); });
    } finally {
      Object.assign(fs, saved);
    }
    assert.deepStrictEqual(asked, ['/app/handlers/probeService/remember.js']);
    assert.deepStrictEqual(map.probeService.remember({value: 'kept'}), {remembered: 'kept'});
  });

  it('on a host path (single-thread mode) the walk is as before: the platform\'s paths, and the handler runs', () => {
    const root = tmp.mkdtemp('ch-handlers-');
    try {
      fs.mkdirSync(path.join(root, 'handlers', 'probeService'), {recursive: true});
      fs.writeFileSync(path.join(root, 'handlers', 'probeService', 'remember.js'), 'module.exports = (args) => ({remembered: args.value});\n');
      const asked = [];
      const map = loadConventionHandlers(root, (file) => { asked.push(file); return require(file); });
      assert.deepStrictEqual(asked, [path.join(root, 'handlers', 'probeService', 'remember.js')]);
      assert.deepStrictEqual(map.probeService.remember({value: 'kept'}), {remembered: 'kept'});
    } finally {
      tmp.remove(root);
    }
  });
});

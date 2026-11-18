const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {mkdtemp} = require('../helpers/test-tmp');
// Required where used, so the server tests run before identity.js exists.
const identity = () => require('../../lib/fs-broker/identity');
const {toolOutput} = require('../helpers/tool-result');

// A module's own path as it sees it: /app/... on POSIX; on Windows the same
// in its virtual drive's form, <V>:\app\... (#195), the letter picked per
// process.
const WIN = process.platform === 'win32';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asSeen = (posix) => (WIN ? new RegExp(`^[A-Z]:${escapeRe(posix.replace(/\//g, '\\'))}$`) : null);
const seen = (actual, posix, msg) => (WIN ? assert.match(String(actual), asSeen(posix), msg) : assert.strictEqual(actual, posix, msg));

describe('fs-broker 12: virtual identity', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  afterEach(() => { stopServer(server); server = null; if (base) fs.rmSync(base, {recursive: true, force: true}); base = null; });

  function start(mode, mod) {
    base = mkdtemp('identity-');
    return startServer(testPort(9630), ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', mode,
      '--moduleDataPath', path.join(base, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', mod)]);
  }

  ['off', 'audit', 'enforce'].forEach((mode) => {
    it(`${mode}: a module sees /app, cwd /app, tmpdir /tmp, and reads its own files via __dirname`, async () => {
      server = await start(mode, 'fs-probe');
      const res = await mcpCall(testPort(9630), 'k', 'fs_probe_probeservice_where', {});
      const r = toolOutput(res);
      seen(r.dirname, '/app/handlers/probeService', JSON.stringify(res));
      seen(r.filename, '/app/handlers/probeService/where.js');
      seen(r.cwd, '/app');
      // os.tmpdir() is /tmp everywhere: on Windows it names \\tmp on the cwd's drive, <V>:
      assert.strictEqual(r.tmpdir, '/tmp');
      seen(r.resolve, '/app/handlers/probeService/read.js');
      seen(r.dirResolve, '/app/handlers/probeService/read.js');
      assert.ok(WIN ? /[A-Z]:\\app\\handlers\\probeService\\where\.js/.test(r.frame) : r.frame.includes('/app/handlers/probeService/where.js'), r.frame);
      assert.strictEqual(r.own, 'fs-probe');
    });
  });

  it('an ES-module package loads through virtual URLs; a dependency without "type" stays CommonJS', async () => {
    server = await start('enforce', 'esm-probe');
    const res = await mcpCall(testPort(9630), 'k', 'esm_probe_probeservice_where', {});
    const r = toolOutput(res);
    if (WIN) assert.match(r.url, /^file:\/\/\/[A-Z]:\/app\/handlers\/probeService\/where\.js$/, JSON.stringify(res));
    else assert.strictEqual(r.url, 'file:///app/handlers/probeService/where.js', JSON.stringify(res));
    seen(r.dirname, '/app/handlers/probeService');
    assert.strictEqual(r.helper, 'helped');
    assert.strictEqual(r.dep, 'plain');
    // Pins identity.js's one host-URL case: a CommonJS file reached by import
    // keeps its host filename, because Node 24's resolveSync marks a resolve
    // that ran the default resolver as not resolved by hooks
    // (internal/modules/esm/loader.js, isResolvedBySyncHooks) and the
    // commonjs translator then re-resolves the filename with the hooks
    // skipped (internal/modules/esm/translators.js,
    // loadCJSModuleWithModuleLoad). When a Node release makes this the
    // virtual path, remove the importedCjs case in identity.js.
    assert.strictEqual(r.depFile, path.join(fs.realpathSync(ROOT), 'test', 'fixtures', 'esm-probe', 'node_modules', 'plain-dep', 'where.js'));
  });

  // #406's high review: under enforce `module` is the lockdown's reduced one,
  // which an ES module's import must reach on every Node line (from 24.21
  // the CommonJS translator loaded it through Module._load with no parent,
  // which no hook knew once the lockdown dropped _load's internal argument);
  // under audit, the real one
  ['enforce', 'audit'].forEach((mode) => {
    it(`${mode}: an ES module imports the module built-in by both names`, async () => {
      server = await start(mode, 'esm-probe');
      const res = await mcpCall(testPort(9630), 'k', 'esm_probe_probeservice_moduleimport', {});
      assert.deepStrictEqual(toolOutput(res), {named: 'function', prefixed: 'function', byDefault: 'function'}, JSON.stringify(res));
    });
  });

  // Review C2's cases, restated for decision 12: countinghouse's own code is
  // never under /app (refused below), so a parent under /app is the module's.
  // POSIX host paths in file URLs; on Windows file:///opt/... is no path.
  // There the forms are fs-broker 26's and stdio 16's, and the module
  // scheme's refusal is the case below.
  (WIN ? it.skip : it)('maps parents and specifiers: countinghouse parents stay host, /app parents are the module\'s', () => {
    const m = identity().mapper('/app/modules/x');
    const ch = m.parent('file:///opt/ch/lib/handler-ctx.js');
    assert.deepStrictEqual(ch, {host: '/opt/ch/lib/handler-ctx.js', fromModule: false});
    assert.strictEqual(m.specifier('./x.js', ch), '/opt/ch/lib/x.js');
    assert.strictEqual(m.specifier('/app/lib/x.js', ch), '/app/lib/x.js', 'a bare /app from countinghouse is a host path');
    const mod = m.parent('file:///app/index.js');
    assert.deepStrictEqual(mod, {host: '/app/modules/x/index.js', fromModule: true});
    assert.strictEqual(m.specifier('/app/lib/y.js', mod), '/app/modules/x/lib/y.js');
    assert.strictEqual(m.specifier('./y.js', mod), '/app/modules/x/y.js');
    assert.strictEqual(m.specifier(identity().moduleSpecifier('/app/package.json'), ch), '/app/modules/x/package.json');
    assert.strictEqual(m.specifier('countinghouse-module:/../../etc/passwd', mod), '/app/modules/x/etc/passwd', 'the module scheme never leaves /app');
    assert.deepStrictEqual(m.parent('data:text/javascript,1'), {host: null, fromModule: true});
    assert.deepStrictEqual(m.parent(undefined), {host: null, fromModule: true});
  });

  (WIN ? it : it.skip)('Windows: the module scheme never leaves the module\'s root', () => {
    const m = identity().mapper('C:\\mods\\x');
    const mod = {host: 'C:\\mods\\x\\index.js', fromModule: true};
    // each either maps inside the module's root or is refused (MODULE_NOT_FOUND)
    for (const spec of ['countinghouse-module:/../../etc/passwd', 'countinghouse-module:/..\\..\\Windows\\win.ini',
      'countinghouse-module:/a/..\\..\\..\\Windows\\win.ini', 'countinghouse-module:\\..\\..\\x', 'countinghouse-module:/lib/..\\../..\\y',
      'countinghouse-module:/%2e%2e%5c%2e%2e%5cWindows', 'countinghouse-module:/C:/Windows/win.ini', 'countinghouse-module:/x.js:stream',
      'countinghouse-module://server/share/x', 'countinghouse-module:/\\\\server\\share\\x']) {
      let host;
      try { host = m.specifier(spec, mod); } catch (e) { assert.strictEqual(e.code, 'MODULE_NOT_FOUND', spec); continue; }
      const real = path.win32.resolve(host);
      assert.ok(real === 'C:\\mods\\x' || real.startsWith('C:\\mods\\x\\'), `${spec} -> ${host} (${real})`);
    }
  });

  it('refuses when countinghouse code is under /app (Node caches are keyed by filename)', () => {
    assert.deepStrictEqual(identity().codeUnderVroot('/opt/ch', ['/opt/ch/lib/a.js']), []);
    assert.deepStrictEqual(identity().codeUnderVroot('/app', []), ['/app']);
    assert.deepStrictEqual(identity().codeUnderVroot('/opt/ch', ['/app/node_modules/countinghouse/lib/a.js']),
      ['/app/node_modules/countinghouse/lib/a.js']);
    assert.deepStrictEqual(identity().codeUnderVroot('/application', []), []);
  });

  it('enforce: module code cannot register a loader hook after set-options', async () => {
    server = await start('enforce', 'route-probe');
    const res = await mcpCall(testPort(9630), 'k', 'route_probe_probeservice_attempt', {what: 'registerHooks', target: '/x'});
    const r = toolOutput(res);
    assert.deepStrictEqual(r, {outcome: 'refused', code: 'ERR_ACCESS_DENIED'}, JSON.stringify(res));
  });

  // Two targets (review I3): one outside everything, and one inside the
  // install directory but outside lib/, node_modules/ and package.json,
  // where <installDir>/auth.json lives.
  const targets = {
    home: () => { const d = fs.mkdtempSync(path.join(os.homedir(), '.ch-route-')); return {file: path.join(d, 'secret.json'), cleanup: d}; },
    installDir: () => { const f = path.join(ROOT, `.ch-route-secret-${process.pid}.json`); return {file: f, cleanup: f}; }
  };
  ['parentRequire', 'cacheRequire', 'moduleLoad', 'protoRequire', 'vmImport', 'getter', 'moduleScheme'].forEach((what) => Object.keys(targets).forEach((where) => {
    it(`enforce: ${what} cannot read a secret in ${where}`, async () => {
      const t = targets[where]();
      fs.writeFileSync(t.file, '{"secret": true}');
      try {
        server = await start('enforce', 'route-probe');
        const res = await mcpCall(testPort(9630), 'k', 'route_probe_probeservice_attempt', {what: what, target: t.file});
        const r = toolOutput(res);
        assert.strictEqual(r.outcome, 'refused', JSON.stringify(res));
      } finally {
        fs.rmSync(t.cleanup, {recursive: true, force: true});
      }
    });
  }));
});

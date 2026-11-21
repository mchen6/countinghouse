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
      assert.deepStrictEqual(toolOutput(res), {named: 'function', prefixed: 'function', byDefault: 'function', reduced: mode === 'enforce', linked: true}, JSON.stringify(res));
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
        const res = await mcpCall(testPort(9630), 'k', 'route_probe_probeservice_attempt', {what: what, target: t.file, libFile: path.join(ROOT, 'lib', 'logger.js')});
        const r = toolOutput(res);
        // (cacheRequire's route is gone since #194's PR 2: require.cache holds
        // no Module of the runtime's to require through)
        assert.strictEqual(r.outcome, what === 'cacheRequire' ? 'no-key' : 'refused', JSON.stringify(res));
      } finally {
        fs.rmSync(t.cleanup, {recursive: true, force: true});
      }
    });
  }));

  // F4-1: the load hook granted Node's read of any host file it was given,
  // so a route that reaches it with a path of the module's choosing read
  // past the broker: Node's extension handlers (a) and a Module of its own.
  // Now Node's read meets the broker with the module's own rights: under
  // enforce refused; under audit a file outside is read and reported, and
  // one in the denied set (the install directory) is refused in both.
  ['extJs', 'extJson', 'moduleNewLoad'].forEach((what) => Object.keys(targets).forEach((where) => {
    it(`F4-1: enforce refuses ${what} on a secret in ${where}; audit ${where === 'home' ? 'reads it and reports it' : 'refuses it too'}`, async () => {
      const t = targets[where]();
      fs.writeFileSync(t.file, '{"secret": true}');
      try {
        server = await start('enforce', 'route-probe');
        const refused = toolOutput(await mcpCall(testPort(9630), 'k', 'route_probe_probeservice_attempt', {what, target: t.file}));
        assert.strictEqual(refused.outcome, 'refused', JSON.stringify(refused));
        stopServer(server);
        server = null;
        fs.rmSync(base, {recursive: true, force: true});
        server = await start('audit', 'route-probe');
        const audit = toolOutput(await mcpCall(testPort(9630), 'k', 'route_probe_probeservice_attempt', {what, target: t.file}));
        if (where !== 'home') return assert.deepStrictEqual(audit, {outcome: 'refused', code: 'EACCES'});
        assert.strictEqual(audit.outcome, 'read', JSON.stringify(audit));
        // (the log is JSON: a Windows path's backslashes are escaped there)
        const shown = JSON.stringify(t.file).slice(1, -1);
        const reported = () => server.output.split('\n').some((l) => l.includes('module sandbox: route-probe file outside') && (l.includes(t.file) || l.includes(shown)));
        for (let i = 0; i < 40 && !reported(); i++) await new Promise((r) => setTimeout(r, 50));
        assert.ok(reported(), server.output.slice(-3000));
      } finally {
        fs.rmSync(t.cleanup, {recursive: true, force: true});
      }
    });
  }));

  // (F4-1's follow-ups: a countinghouse code-root file -- the install's
  // package.json, a lib file the worker never loaded -- through the same
  // routes: refused under enforce, the runtime's grant never module code's.
  // A grant stands only between a resolve the runtime made and its load;
  // after the seal the runtime resolves nothing (sandbox 66), so no module
  // code runs while one stands.)
  ['extJs', 'extJson', 'moduleNewLoad'].forEach((what) => [path.join(ROOT, 'package.json'), path.join(ROOT, 'lib', 'couchdb-adapter', 'init-db.js')].forEach((file) => {
    it(`F4-1: enforce refuses ${what} on countinghouse's own ${path.relative(ROOT, file)}`, async () => {
      server = await start('enforce', 'route-probe');
      const refused = toolOutput(await mcpCall(testPort(9630), 'k', 'route_probe_probeservice_attempt', {what, target: file}));
      assert.strictEqual(refused.outcome, 'refused', JSON.stringify(refused));
    });
  }));

  // (and a code-root file that exists answers as one that doesn't: no
  // answer says which of the install's files are there)
  ['extJs', 'moduleNewLoad'].forEach((what) => {
    it(`F4-1: enforce's ${what} answers a code-root file there and one not there alike`, async () => {
      server = await start('enforce', 'route-probe');
      const there = toolOutput(await mcpCall(testPort(9630), 'k', 'route_probe_probeservice_attempt', {what, target: path.join(ROOT, 'lib', 'couchdb-adapter', 'init-db.js')}));
      const notThere = toolOutput(await mcpCall(testPort(9630), 'k', 'route_probe_probeservice_attempt', {what, target: path.join(ROOT, 'lib', 'couchdb-adapter', 'no-such-f41.js')}));
      assert.deepStrictEqual(there, notThere);
    });
  });

  // #194's revision 6, item 9: F4-1's fix 2 resolves a module request with
  // Node's own resolver against the host parent; a not-found names only the
  // request, never Node's require stack (the host parent's path)
  ['enforce', 'audit'].forEach((mode) => {
    it(`${mode}: a module's own request that is not found names only the request`, async () => {
      server = await start(mode, 'route-probe');
      const r = toolOutput(await mcpCall(testPort(9630), 'k', 'route_probe_probeservice_attempt', {what: 'notFoundShape', target: '/x'}));
      assert.deepStrictEqual(r, {outcome: 'refused', code: 'EXACT'});
    });
  });

  // F4-1's review: since fix 2 the lockdown's resolve hook no longer sees a
  // module's CommonJS not-found, so identity says it of a bare name that
  // would reach countinghouse's lib/ (a file, or a directory with an
  // index): tagged under enforce, reported under audit. Any other name is
  // reported nowhere: under audit a plain not-found, under enforce the same
  // tagged refusal, as any bare name module code can't resolve gets one
  // there, so whether a lib/ file of that name exists is no answer (#194's
  // PR 3)
  ['enforce', 'audit'].forEach((mode) => {
    it(`${mode}: a bare name of a lib/ file is the sandbox's (${mode === 'enforce' ? 'tagged' : 'reported'}); a lib/ directory with no index is ${mode === 'enforce' ? 'tagged too, unreported' : 'not'}`, async () => {
      server = await start(mode, 'route-probe');
      const from = server.output.length;
      const lib = toolOutput(await mcpCall(testPort(9630), 'k', 'route_probe_probeservice_attempt', {what: 'libName', target: 'cli-options'}));
      assert.deepStrictEqual(lib, {outcome: 'refused', code: mode === 'enforce' ? 'TAGGED' : 'PLAIN'});
      const reported = () => server.output.slice(from).split('\n').some((l) => l.includes('module sandbox: route-probe violation require cli-options'));
      for (let i = 0; i < 40 && !reported(); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(reported(), server.output.slice(-2000));
      // (under enforce one refusal for any bare name module code can't
      // resolve, so whether a lib/ file of that name exists is no answer:
      // #194's PR 3; reported only for the name that reaches lib/)
      const dir = toolOutput(await mcpCall(testPort(9630), 'k', 'route_probe_probeservice_attempt', {what: 'libName', target: 'routes'}));
      assert.deepStrictEqual(dir, {outcome: 'refused', code: mode === 'enforce' ? 'TAGGED' : 'PLAIN'});
      assert.ok(!server.output.slice(from).includes('violation require routes'), 'a name that reaches nothing was reported');
    });
  });

  // F4-1 (b): Node's createRequire assigns require.resolve, so an accessor on
  // Function.prototype swallowed it and answered the resolve hook's own
  // lookup with a path under the module's root, lexically, that climbs out.
  // The hook now calls Node's own resolver directly: the accessor decides
  // nothing, in either mode, and the request is simply not found.
  // (skipped on Windows: Windows module workers are not claimed, #480)
  (WIN ? it.skip : it)('F4-1: an accessor on Function.prototype.resolve never decides a resolution, under enforce or audit', async () => {
    const t = targets.home();
    fs.writeFileSync(t.file, '{"secret": true}');
    try {
      for (const mode of ['enforce', 'audit']) {
        server = await start(mode, 'route-probe');
        const r = toolOutput(await mcpCall(testPort(9630), 'k', 'route_probe_probeservice_attempt', {what: 'resolveAccessor', target: t.file}));
        assert.deepStrictEqual(r, {outcome: 'refused', code: 'MODULE_NOT_FOUND'}, `${mode}: ${JSON.stringify(r)}`);
        stopServer(server);
        server = null;
        fs.rmSync(base, {recursive: true, force: true});
        base = null;
      }
    } finally {
      fs.rmSync(t.cleanup, {recursive: true, force: true});
    }
  });
});

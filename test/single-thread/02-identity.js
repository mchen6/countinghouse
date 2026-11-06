const assert = require('assert');
const vm = require('vm');
const facade = require('../../lib/single-thread-facade');
const {toolOutput} = require('../helpers/tool-result');

const run = (src) => {
  const fn = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${src}\n})`);
  const m = {exports: {}};
  fn(m.exports, require, m, '/host/x/lib/a.js', '/host/x/lib');
  return m.exports;
};

describe('single-thread 02: the identity prefix', () => {
  it('sets the virtual __filename and __dirname, keeping strict mode and line numbers', () => {
    const src = "'use strict';\n// a comment\nmodule.exports = {f: __filename, d: __dirname, strict: (function() { return this === undefined; })(), line: new Error().stack.split('\\n')[1]};";
    const out = run(facade.prefixSource(src, '/app/lib/a.js'));
    assert.deepStrictEqual([out.f, out.d, out.strict], ['/app/lib/a.js', '/app/lib', true]);
    assert.ok(/:3:/.test(out.line), out.line);
  });

  it('keeps a hashbang first and parsing', () => {
    const src = "#!/usr/bin/env node\n'use strict';\nmodule.exports = __dirname;";
    const prefixed = facade.prefixSource(src, '/app/bin/cli.js');
    assert.ok(prefixed.startsWith('#!/usr/bin/env node\n'));
    assert.strictEqual(prefixed.split('\n').length, src.split('\n').length);
  });

  it('a file with no directive gets the prefix on its first line', () => {
    const prefixed = facade.prefixSource('module.exports = __filename;', '/app/index.js');
    assert.strictEqual(prefixed.split('\n').length, 1);
    assert.strictEqual(run(prefixed), '/app/index.js');
  });

  it('a string that starts an expression is not a directive (review I2)', () => {
    assert.deepStrictEqual(run(facade.prefixSource("module.exports = 'abc'.split('').length + __dirname.length;", '/app/a.js')), 3 + '/app'.length);
    const src = "'abc'.split('');\nmodule.exports = __dirname;";
    assert.strictEqual(run(facade.prefixSource(src, '/app/lib/a.js')), '/app/lib');
  });

  it('"use strict" followed by a line that continues the expression is not a directive (no ASI there)', () => {
    const src = '"use strict"\n.length;\nmodule.exports = __dirname;';
    assert.strictEqual(run(facade.prefixSource(src, '/app/lib/a.js')), '/app/lib');
  });

  it('a BOM before the hashbang', () => {
    const src = '\uFEFF#!/usr/bin/env node\nmodule.exports = __dirname;';
    const prefixed = facade.prefixSource(src, '/app/bin/x.js');
    assert.ok(prefixed.startsWith('\uFEFF#!/usr/bin/env node\n'));
    assert.strictEqual(prefixed.split('\n').length, 2);
  });
});

describe('single-thread 02: identity in a running server', function() {
  this.timeout(120000);
  const fs = require('fs');
  const path = require('path');
  const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
  const {mkdtemp} = require('../helpers/test-tmp');
  const FIXTURES = path.join(ROOT, 'test', 'fixtures');
  const out = (r) => toolOutput(r);
  let server = null;
  let base = null;
  afterEach(() => { stopServer(server); server = null; if (base) fs.rmSync(base, {recursive: true, force: true}); base = null; });
  const start = (modules) => {
    base = mkdtemp('single-id-');
    return startServer(9636, ['--no-workerThread', '--debug', '--debugKey', 'k', '--moduleDataPath', path.join(base, 'store')]
      .concat(...modules.map((m) => ['--loadModule', path.join(FIXTURES, m)])));
  };

  it('two modules each see their own /app, and read their own package.json through __dirname', async () => {
    server = await start(['fs-probe', 'fs-probe-twin']);
    const ra = await mcpCall(9636, 'k', 'fs_probe_probeservice_where', {});
    const rb = await mcpCall(9636, 'k', 'fs_probe_twin_probeservice_where', {});
    assert.ok(ra.isError === false && toolOutput(ra) && rb.isError === false && toolOutput(rb), JSON.stringify([ra, rb]).slice(0, 1500));
    const a = out(ra);
    const b = out(rb);
    assert.deepStrictEqual([a.dirname, a.filename, a.own], ['/app/handlers/probeService', '/app/handlers/probeService/where.js', 'fs-probe']);
    assert.deepStrictEqual([b.dirname, b.own], ['/app/handlers/probeService', 'fs-probe-twin']);
    // documented differences: require.resolve stays host; a virtual createRequire path is not mapped
    assert.ok(a.resolve.startsWith(path.join(FIXTURES, 'fs-probe')), a.resolve);
    assert.strictEqual(a.dirResolve, 'MODULE_NOT_FOUND');
  });

  it('CHUtil.loadFile finds its caller even when the module rewrites stack traces (review I3)', async () => {
    server = await start(['stack-rewriter']);
    assert.deepStrictEqual(out(await mcpCall(9636, 'k', 'stack_rewriter_probeservice_where', {})), {dirname: '/app/lib'});
  });

  it('the test helper rejects an unknown tool, so a mistyped name cannot pass silently (review)', async () => {
    server = await start(['fs-probe']);
    await assert.rejects(mcpCall(9636, 'k', 'fs_probe_probeservice_noSuchAction', {}), /unknown tool/);
    const allowed = await mcpCall(9636, 'k', 'fs_probe_probeservice_noSuchAction', {}, {allowUnknownTool: true});
    assert.ok(/unknown tool/.test(JSON.stringify(allowed)), JSON.stringify(allowed));
  });
});

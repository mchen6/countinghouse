'use strict';
// sandbox 72 (C-bare R0): a module root always has its own package.json.
// The one native read on a bare require's path -- trySelf's walk up from
// the parent's file (lib/fs-broker/identity.js, above requireRequest) --
// stops there at the latest, so a module whose root has none never loads,
// by either route: the start list's check (any mode), and -- for a load
// after start, where worker-thread mode skips the main thread's own read --
// the module sandbox's own refusal under enforce. (fs-broker 24: the module
// can't take its package.json away once loaded.)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall, post} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {mkdtemp} = require('../helpers/test-tmp');

describe('sandbox 72: a module root with no package.json never loads (C-bare R0)', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  afterEach(() => { stopServer(server); server = null; if (base) fs.rmSync(base, {recursive: true, force: true}); base = null; });

  // (a load after start, by the admin route: worker-thread mode skips the
  // main thread's own package.json read there)
  it('a load after start of a root with no package.json is refused, with its package.json it loads', async () => {
    base = mkdtemp('root-pkg-');
    const mods = {};
    for (const withPkg of [true, false]) {
      mods[withPkg] = path.join(base, withPkg ? 'with' : 'without', 'fs-probe');
      fs.mkdirSync(path.dirname(mods[withPkg]), {recursive: true});
      fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'fs-probe'), mods[withPkg], {recursive: true});
      if (!withPkg) fs.rmSync(path.join(mods[withPkg], 'package.json'));
    }
    server = await startServer(testPort(9760), ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', 'enforce',
      '--moduleDataPath', path.join(base, 'store')]);
    const without = await post(testPort(9760), 'k', '/load-module', {path: mods[false], name: 'fs-probe', version: '1.0.0'});
    assert.strictEqual(without.body && without.body.code, 'MODULE_SANDBOX_REFUSED', JSON.stringify(without).slice(0, 600));
    assert.ok(/package\.json could not be read/.test(without.body.message), without.body.message);
    const withIt = await post(testPort(9760), 'k', '/load-module', {path: mods[true], name: 'fs-probe', version: '1.0.0'});
    assert.deepStrictEqual(withIt.body, {loaded: true, name: 'fs-probe', version: '1.0.0'}, JSON.stringify(withIt).slice(0, 300));
  });

  for (const withPkg of [true, false]) {
    it(withPkg ? 'from the start list, with its package.json, the module loads (the control)' : 'from the start list, without it, the load is refused and no tool of the module\'s is listed', async () => {
      base = mkdtemp('root-pkg-');
      const mod = path.join(base, 'fs-probe');
      fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'fs-probe'), mod, {recursive: true});
      if (!withPkg) fs.rmSync(path.join(mod, 'package.json'));
      server = await startServer(testPort(9760), ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', 'enforce',
        '--moduleDataPath', path.join(base, 'store'), '--loadModule', mod]);
      const res = await mcpCall(testPort(9760), 'k', 'fs_probe_probeservice_where', {}, {allowUnknownTool: !withPkg});
      if (withPkg) {
        assert.ok(!JSON.stringify(res).includes('"isError":true'), JSON.stringify(res).slice(0, 500));
      } else {
        assert.ok(/MODULE_NOT_LISTED|unknown tool/i.test(JSON.stringify(res)), JSON.stringify(res).slice(0, 500));
        assert.ok(/package\.json file not found/.test(String(server.output)), String(server.output).slice(-1500));
      }
    });
  }
});

'use strict';
// sandbox 72 (C-bare R0): a module root always has its own package.json.
// The one native read on a bare require's path -- trySelf's walk up from
// the parent's file (lib/fs-broker/identity.js, above requireRequest) --
// stops there at the latest, so a module whose root has none never loads:
// in worker-thread mode, the runtime's own, under enforce. (fs-broker 24:
// the module can't take its package.json away once loaded.)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {mkdtemp} = require('../helpers/test-tmp');

describe('sandbox 72: a module root with no package.json never loads (C-bare R0)', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  afterEach(() => { stopServer(server); server = null; if (base) fs.rmSync(base, {recursive: true, force: true}); base = null; });

  for (const withPkg of [true, false]) {
    it(withPkg ? 'with its package.json, the module loads (the control)' : 'without it, the load is refused and no tool of the module\'s is listed', async () => {
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
        assert.ok(/unknown tool|not found|MODULE_NOT_LISTED|isError/i.test(JSON.stringify(res)), JSON.stringify(res).slice(0, 500));
        assert.ok(/package\.json file not found/.test(String(server.output)), String(server.output).slice(-1500));
      }
    });
  }
});

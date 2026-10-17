const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');

// Countinghouse installed under /app is refused, not supported (spec decision
// 12): Node's module caches are keyed by filename. An install at /app needs
// root on a test machine, so 12-identity.js's mapper and codeUnderVroot unit
// tests cover that side.
describe('fs-broker 13: virtual and host paths do not collide', function() {
  this.timeout(120000);
  let server = null;
  const made = [];
  afterEach(() => { stopServer(server); server = null; made.splice(0).forEach((d) => fs.rmSync(d, {recursive: true, force: true})); });
  const tmp = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };

  ['off', 'audit', 'enforce'].forEach((mode) => {
    it(`${mode}: a module installed under /tmp with its data under /tmp sees /app and its own private /tmp`, async () => {
      const mod = path.join(tmp('ch-col-mod-'), 'fs-probe');
      fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'fs-probe'), mod, {recursive: true});
      const store = tmp('ch-col-store-');
      server = await startServer(9631, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', mode,
        '--moduleDataPath', store, '--loadModule', mod]);
      const res = await mcpCall(9631, 'k', 'fs_probe_probeservice_where', {});
      const where = res.structuredContent != null ? res.structuredContent.output : res;
      assert.strictEqual(where.dirname, '/app/handlers/probeService', JSON.stringify(res));
      assert.strictEqual(where.own, 'fs-probe');
      await mcpCall(9631, 'k', 'fs_probe_probeservice_write', {path: '/tmp/t', content: 'mine'});
      assert.strictEqual(fs.readFileSync(path.join(store, 'fs-probe', 'tmp', 't'), 'utf8'), 'mine');
      const hostTmpPath = path.join(mod, 'package.json');
      const r = (await mcpCall(9631, 'k', 'fs_probe_probeservice_read', {path: hostTmpPath})).structuredContent.output;
      assert.strictEqual(r.code, 'ENOENT', 'a host path under /tmp is the module\'s own /tmp, not the host\'s');
    });
  });
});

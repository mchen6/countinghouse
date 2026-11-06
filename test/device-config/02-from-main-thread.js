const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const os = require('os');
const {toolOutput} = require('../helpers/tool-result');

describe('device-config 02: config reaches a worker from the main thread', function() {
  this.timeout(90000);
  let server = null;
  let base = null;
  afterEach(() => { stopServer(server); server = null; if (base) fs.rmSync(base, {recursive: true, force: true}); });

  ['off', 'enforce'].forEach((mode) => {
    it(`${mode}: the module sees its config without reading the file itself`, async () => {
      // Outside the install directory and outside /tmp (the module's own
      // /tmp), so a worker-side read would go to the broker and be logged.
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-devcfg-'));
      fs.writeFileSync(path.join(base, 'fs-probe.json'), JSON.stringify({greeting: 'hi'}));
      server = await startServer(9629, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', mode,
        '--deviceConfigPath', base, '--moduleDataPath', path.join(base, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'fs-probe')]);
      const r = await mcpCall(9629, 'k', 'fs_probe_probeservice_config', {});
      assert.deepStrictEqual(toolOutput(r), {config: {greeting: 'hi'}}, JSON.stringify(r));
      assert.ok(!server.output.includes(`file outside ${path.join(base, 'fs-probe.json')}`), 'the worker read the config file itself');
    });
  });
});

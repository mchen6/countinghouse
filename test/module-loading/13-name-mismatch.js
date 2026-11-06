// A load whose request name differs from the module's package.json name is
// refused in every mode, so code cannot be loaded under another module's
// name (and so get its policy entry and, from part 2, its data).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const {ROOT, startServer, stopServer, mcpCall, post} = require('../helpers/sandbox-server');
const {toolErrorCode} = require('../helpers/tool-result');

const KEY = 'aabbcc';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'sandbox-probe');   // package.json name: sandbox-probe

describe('module-loading 13: request name must match package.json', function() {
  this.timeout(90000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  [['worker mode, off', ['--workerThread', '--moduleSandbox', 'off']],
   ['worker mode, enforce', ['--workerThread', '--moduleSandbox', 'enforce']],
   ['single-thread mode', ['--no-workerThread']]].forEach(([label, flags]) => {
    it(`${label}: refuses a mismatched name and loads the matching one`, async () => {
      server = await startServer(9615, flags.concat(['--debug', '--debugKey', KEY, '--authoringTools']));
      const bad = await mcpCall(9615, KEY, 'countinghouse_load_module', {path: PROBE, name: 'weather', version: '1.0.0'});
      assert.strictEqual(toolErrorCode(bad), 'MODULE_NAME_MISMATCH', JSON.stringify(bad));
      const good = await mcpCall(9615, KEY, 'countinghouse_load_module', {path: PROBE, name: 'sandbox-probe', version: '1.0.0'});
      assert.strictEqual(good.structuredContent.loaded, true, JSON.stringify(good));
    });
  });
});

describe('module-loading 13: a mismatched registry entry at startup', function() {
  this.timeout(90000);
  let server = null;
  let dir = null;
  afterEach(() => { stopServer(server); server = null; if (dir) fs.rmSync(dir, {recursive: true, force: true}); });

  it('logs MODULE_NAME_MISMATCH and still reaches ready', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-registry-'));
    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(path.join(dir, 'countinghouse-modules.db'));
      db.serialize(() => {
        db.run('CREATE TABLE IF NOT EXISTS module_info(name TEXT PRIMARY KEY, version TEXT, path TEXT, deviceList TEXT)');
        db.run('INSERT INTO module_info VALUES (?, ?, ?, ?)', ['weather', '1.0.0', PROBE, '{}'], (e) => (e ? reject(e) : db.close(resolve)));
      });
    });
    // startServer resolves only on the ready line, so getting here proves startup was not hung
    server = await startServer(9615, ['--workerThread', '--debug', '--debugKey', KEY, '--modulePath', dir]);
    assert.ok(/names a module differently from its package\.json/.test(server.output), server.output.slice(-3000));
  });
});

describe('module-loading 13: /load-module without a name', function() {
  this.timeout(90000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  it('loads under the package.json name', async () => {
    server = await startServer(9615, ['--workerThread', '--debug', '--debugKey', KEY]);
    const r = await post(9615, KEY, '/load-module', {path: PROBE, version: '1.0.0'});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.name, 'sandbox-probe', JSON.stringify(r.body));
  });
});

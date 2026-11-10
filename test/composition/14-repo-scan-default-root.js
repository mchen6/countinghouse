// repo-scan's default root is the operator's choice, never inferred.
//
// It used to climb "up five" from its handler's __dirname to the
// countinghouse repository. Since sandbox part 2 a module's __dirname is
// virtual (/app/handlers/scanService), so the climb landed on '/', and a
// repo_review call with no `path` walked the host's whole filesystem -- too
// slow to finish within the request timeout, and reading files it had no
// business reading (allowed and logged under audit). Now the default comes
// from repo-scan's device config (`defaultRoot`); with none, `path` is
// required. A filesystem root is refused either way.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {toolOutput, toolErrorCode} = require('../helpers/tool-result');

const PORT = 9605;
const KEY  = 'k';
const SCAN = 'repo_scan_scanservice_scan';

describe('composition 14: repo-scan reads only the directory an operator or caller names', function() {
  this.timeout(90000);
  let server = null;
  let base = null;

  // Outside /tmp (a module's own) and outside the install directory.
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.homedir(), '.ch-repo-scan-')); });
  afterEach(() => {
    stopServer(server); server = null;
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  const start = (configDir) => startServer(PORT, ['--workerThread', '--debug', '--debugKey', KEY,
    '--moduleDataPath', path.join(base, 'store')].concat(configDir != null ? ['--deviceConfigPath', configDir] : [])
    .concat(['--loadModule', path.join(ROOT, 'examples', 'repo-review', 'repo-scan')]));

  it('with no path and no configured default, refuses promptly and reads nothing outside its namespace', async () => {
    server = await start(null);
    const started = Date.now();
    const r = await mcpCall(PORT, KEY, SCAN, {});
    assert.ok(Date.now() - started < 10000, `took ${Date.now() - started} ms`);
    assert.strictEqual(r.isError, true, JSON.stringify(r));
    assert.strictEqual(toolErrorCode(r), 'INPUT_REJECTED', JSON.stringify(r));
    // Only the code crosses the worker hop (lib/handler-ctx.js re-wraps by
    // code); the handler's hint about defaultRoot reaches REST and
    // single-thread callers.
    assert.ok(!/module sandbox: repo-scan file outside/.test(server.output), server.output.split('\n').filter((l) => /file outside/.test(l)).slice(0, 3).join('\n'));
  });

  it('with a configured defaultRoot and no path, scans exactly that directory', async () => {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"scan-me"}\n');
    fs.writeFileSync(path.join(repo, 'index.js'), 'module.exports = 1;\n');
    const configDir = path.join(base, 'config');
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'repo-scan.json'), JSON.stringify({defaultRoot: repo}));
    server = await start(configDir);
    const r = await mcpCall(PORT, KEY, SCAN, {});
    assert.strictEqual(r.isError, false, JSON.stringify(r));
    const out = toolOutput(r);
    assert.strictEqual(out.root, repo);
    assert.deepStrictEqual(out.files.map((f) => f.path).sort(), ['index.js', 'package.json']);
  });

  it('refuses a filesystem root, given as path or as the configured default', async () => {
    const configDir = path.join(base, 'config');
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'repo-scan.json'), JSON.stringify({defaultRoot: '/'}));
    server = await start(configDir);
    const viaPath = await mcpCall(PORT, KEY, SCAN, {path: '/'});
    assert.strictEqual(toolErrorCode(viaPath), 'INPUT_REJECTED', JSON.stringify(viaPath));
    const viaConfig = await mcpCall(PORT, KEY, SCAN, {});
    assert.strictEqual(toolErrorCode(viaConfig), 'INPUT_REJECTED', JSON.stringify(viaConfig));
    assert.ok(!/module sandbox: repo-scan file outside \/var/.test(server.output), 'walked the host filesystem');
  });
});

// --hardened re-launches under Node's permission model: a module cannot read
// the process's memory or environment files, and every module must live
// under --modulePath.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');

const KEY = 'aabbcc';

function moduleRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-hardened-'));
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'sandbox-probe'), path.join(root, 'sandbox-probe'), {recursive: true});
  // A handler that reads a file it names, so the test can aim it at /proc.
  fs.writeFileSync(path.join(root, 'sandbox-probe', 'handlers', 'probeService', 'attempt.js'),
    'module.exports = async (input) => { try { require("fs").readFileSync(input.arg); return {output: {outcome: "allowed", code: null}}; }' +
    ' catch (e) { return {output: {outcome: e.code === "ERR_ACCESS_DENIED" ? "blocked" : "allowed", code: String(e.code)}}; } };');
  return root;
}

describe('sandbox 09: --hardened', function() {
  this.timeout(90000);
  let server = null;
  let root = null;
  beforeEach(() => { root = moduleRoot(); });
  afterEach(() => { stopServer(server); server = null; fs.rmSync(root, {recursive: true, force: true}); });

  it('runs under the permission model and blocks /proc/self/environ and /proc/self/mem', async () => {
    server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened',
      '--modulePath', root, '--loadModule', path.join(root, 'sandbox-probe')]);
    assert.ok(server.output.includes('module sandbox: hardened -- running under --permission'), server.output.slice(-2000));
    for (const file of ['/proc/self/environ', '/proc/self/mem']) {
      const r = await mcpCall(9614, KEY, 'sandbox_probe_probeservice_attempt', {what: 'read', arg: file});
      assert.strictEqual(r.structuredContent.output.outcome, 'blocked', `${file}: ${JSON.stringify(r)}`);
    }
  });

  it('refuses a module outside --modulePath', async () => {
    server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened', '--authoringTools',
      '--modulePath', root]);
    const r = await mcpCall(9614, KEY, 'countinghouse_load_module',
      {path: path.join(ROOT, 'test', 'fixtures', 'handler-map-convention'), name: 'handler-map-convention', version: '1.0.0'});
    assert.strictEqual(r.structuredContent.code, 'MODULE_PATH_OUTSIDE_ROOT', JSON.stringify(r));
  });

  // Review Focus 5.
  it('accepts a relative --loadModule path that resolves inside --modulePath', async () => {
    server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened',
      '--modulePath', root, '--loadModule', path.relative(ROOT, path.join(root, 'sandbox-probe'))]);
    const r = await mcpCall(9614, KEY, 'sandbox_probe_probeservice_env', {});
    assert.strictEqual(r.isError, false, JSON.stringify(r));
  });

  // The default file auth provider reads ./auth.json, and writes it with a
  // demo key on first run; neither may be blocked by the permission model.
  it('starts with the default file auth, first run and after', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-hardened-cwd-'));
    try {
      for (const run of ['first', 'second']) {
        server = await startServer(9614, ['--workerThread', '--hardened', '--modulePath', root], {cwd: cwd});
        assert.ok(fs.existsSync(path.join(cwd, 'auth.json')), `${run} run: ${server.output.slice(-2000)}`);
        stopServer(server);
        server = null;
      }
    } finally {
      fs.rmSync(cwd, {recursive: true, force: true});
    }
  });

  it('needs --workerThread', async () => {
    server = await startServer(9614, ['--debug', '--hardened', '--modulePath', root], {expectExit: true});
    assert.strictEqual(server.exitCode, 2);
    assert.ok(server.output.includes('--hardened needs --workerThread'), server.output);
  });
});

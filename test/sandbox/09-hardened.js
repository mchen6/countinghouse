// --hardened re-launches under Node's permission model: a module cannot read
// the process's memory or environment files, and every module must live
// under --modulePath.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
const {toolOutput, toolErrorCode} = require('../helpers/tool-result');

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
      assert.strictEqual(toolOutput(r).outcome, 'blocked', `${file}: ${JSON.stringify(r)}`);
    }
  });

  it('refuses a module outside --modulePath', async () => {
    server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened', '--authoringTools',
      '--modulePath', root]);
    const r = await mcpCall(9614, KEY, 'countinghouse_load_module',
      {path: path.join(ROOT, 'test', 'fixtures', 'handler-map-convention'), name: 'handler-map-convention', version: '1.0.0'});
    assert.strictEqual(toolErrorCode(r), 'MODULE_PATH_OUTSIDE_ROOT', JSON.stringify(r));
  });

  it('refuses a module outside --modulePath on restart, reload, and through a symlink', async () => {
    server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened', '--authoringTools',
      '--modulePath', root, '--loadModule', path.join(root, 'sandbox-probe')]);
    const outside = path.join(ROOT, 'test', 'fixtures', 'sandbox-probe');
    fs.symlinkSync(outside, path.join(root, 'linked-probe'));
    const restart = await post(9614, KEY, '/restart-module', {path: outside, name: 'sandbox-probe', version: '1.0.0'});
    assert.ok(JSON.stringify(restart.body).includes('MODULE_PATH_OUTSIDE_ROOT'), JSON.stringify(restart));
    const reload = await post(9614, KEY, '/reload-module', {path: outside});
    assert.ok(JSON.stringify(reload.body).includes('MODULE_PATH_OUTSIDE_ROOT'), JSON.stringify(reload));
    const linked = await mcpCall(9614, KEY, 'countinghouse_load_module',
      {path: path.join(root, 'linked-probe'), name: 'sandbox-probe', version: '1.0.0'});
    assert.strictEqual(toolErrorCode(linked), 'MODULE_PATH_OUTSIDE_ROOT', JSON.stringify(linked));
    // The running module was left alone by all three.
    const r = await mcpCall(9614, KEY, 'sandbox_probe_probeservice_env', {});
    assert.strictEqual(r.isError, false, JSON.stringify(r));
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

  // The broker under the permission model: a module writes and reads /data.
  // --moduleDataPath is a sibling of the install dir whose name extends it
  // (<repo>_data-…), the grant layout that tripped Node 24's prefix bug
  // (test/fs-broker/10-permission-prefix.js) with the default under $HOME.
  it('a module writes and reads /data under --hardened', async () => {
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'fs-probe'), path.join(root, 'fs-probe'), {recursive: true});
    const data = `${fs.realpathSync(ROOT)}_data-${process.pid}`;
    try {
      server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened',
        '--modulePath', root, '--moduleDataPath', data, '--loadModule', path.join(root, 'fs-probe')]);
      const w = await mcpCall(9614, KEY, 'fs_probe_probeservice_write', {path: '/data/x', content: 'hardened'});
      assert.deepStrictEqual(toolOutput(w), {ok: true, code: null}, JSON.stringify(w));
      const r = await mcpCall(9614, KEY, 'fs_probe_probeservice_read', {path: '/data/x'});
      assert.deepStrictEqual(toolOutput(r), {content: 'hardened', code: null});
      assert.strictEqual(fs.readFileSync(path.join(data, 'fs-probe', 'data', 'x'), 'utf8'), 'hardened');
    } finally {
      fs.rmSync(data, {recursive: true, force: true});
    }
  });

  // Load, restart and file I/O under --hardened with enforce live: every
  // main-thread and worker path, with the loader's grants acting on files
  // inside the grant roots, never on a root itself (plan 3, Task 4).
  it('a module restarts and still reads /data under --hardened (enforce)', async () => {
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'fs-probe'), path.join(root, 'fs-probe'), {recursive: true});
    const data = `${fs.realpathSync(ROOT)}_data-${process.pid}`;
    try {
      server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened', '--moduleSandbox', 'enforce',
        '--modulePath', root, '--moduleDataPath', data, '--loadModule', path.join(root, 'fs-probe')]);
      await mcpCall(9614, KEY, 'fs_probe_probeservice_write', {path: '/data/x', content: 'kept'});
      const restarted = await post(9614, KEY, '/restart-module', {name: 'fs-probe'});
      assert.strictEqual(restarted.status, 200, JSON.stringify(restarted.body));
      await waitFor(async () => {
        const r = await mcpCall(9614, KEY, 'fs_probe_probeservice_read', {path: '/data/x'});
        return r.isError === false && toolOutput(r).content === 'kept';
      }, 15000, 'read after restart');
      const where = await mcpCall(9614, KEY, 'fs_probe_probeservice_where', {});
      assert.strictEqual(toolOutput(where).dirname, '/app/handlers/probeService', JSON.stringify(where));
    } finally {
      fs.rmSync(data, {recursive: true, force: true});
    }
  });

  it('needs --workerThread', async () => {
    server = await startServer(9614, ['--no-workerThread', '--debug', '--hardened', '--modulePath', root], {expectExit: true});
    assert.strictEqual(server.exitCode, 2);
    assert.ok(server.output.includes('--hardened needs --workerThread'), server.output);
  });
});

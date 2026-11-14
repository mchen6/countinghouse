// A module's remote call works under --moduleSandbox enforce (reviewer,
// 2026-11-12; ch-local's acceptance run). handler-ctx's callRemoteAddress
// required worker_threads lazily, at call time, inside the module's worker,
// where the lockdown refuses it ("Cannot find module 'worker_threads'
// (countinghouse module sandbox)"). So every remote call from a sandboxed
// module failed with DEVICE_INVOKE_EXCEPTION, and the client profile always
// enforces the sandbox. test/remote/05 calls from a worker, but not under
// enforce.
//
// --store local (no Redis), HTTP on 127.0.0.1 with --debug, which allows the
// probe's loopback stand-in. No real host is ever declared.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');
const {startRemoteServer} = require('../helpers/remote-mcp-server');
const {testPort} = require('../helpers/test-env');

const PORT = testPort(9747);
const STAND_IN = testPort(9746);
const KEY = 'remote-09-key';
const TOKEN = `ghp_${'C'.repeat(36)}`;

describe('remote 09: a module\'s remote call under --moduleSandbox enforce', function() {
  this.timeout(120000);
  let standIn = null;
  let server = null;
  let root = null;
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-09-'));
    const probe = path.join(root, 'remote-probe');
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'remote-probe'), probe, {recursive: true});
    const pkgPath = path.join(probe, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.countinghouse.remotes[0].url = `http://127.0.0.1:${STAND_IN}/mcp`;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));
    const allowance = path.join(root, 'remote-credentials.json');
    fs.writeFileSync(allowance, JSON.stringify({[`http://127.0.0.1:${STAND_IN}`]: ['CH_TEST_REMOTE_TOKEN']}));
    standIn = await startRemoteServer(STAND_IN);
    // --store local keeps no Redis: startServer gives it no --redisUrl
    // (test/helpers/test-env.js redisArgsFor).
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', 'enforce',
      '--store', 'local', '--storePath', path.join(root, 'store'), '--moduleDataPath', path.join(root, 'module_data'), '--modulePath', path.join(root, 'modules'),
      '--remoteCredentials', allowance, '--loadModule', probe], {env: {CH_TEST_REMOTE_TOKEN: TOKEN}});
  });
  after(async () => {
    if (server != null) await stopServer(server);
    if (standIn != null) await standIn.close();
    if (root != null) fs.rmSync(root, {recursive: true, force: true});
  });

  it('answers with the remote\'s result, the credential sent to the declared stand-in', async () => {
    assert.match(server.output, /module sandbox: mode enforce/);
    const out = await mcpCall(PORT, KEY, 'remote_probe_probeservice_calltool', {tool: 'echo_text', args: {a: 1}}).then(toolOutput);
    assert.deepStrictEqual(out, {result: {content: [{type: 'text', text: '{"a":1}'}]}}, server.output.slice(-1500));
    assert.ok(standIn.headers.some((h) => h.authorization === `Bearer ${TOKEN}`));
  });

  // ctx.usage() (the reviewer, 2026-11-13): asked from the module's worker
  // under enforce, answered on the main thread with the call's counts so far.
  it('ctx.usage() in the sandboxed worker: the call\'s two server calls so far, and nothing of the call itself', async () => {
    const out = await mcpCall(PORT, KEY, 'remote_probe_probeservice_callthenusage', {times: 2, args: {a: 1}}).then(toolOutput);
    // echo_text answers '{"a":1}': 7 bytes, one line, twice
    assert.deepStrictEqual(out, {usage: {calls: 2, linesIn: 2, bytesIn: 14, tokensInEst: 4, servers: {probe: 2}, sentence: 'read 2 lines (14 B) in 2 calls to probe'}}, server.output.slice(-1500));
    const none = await mcpCall(PORT, KEY, 'remote_probe_probeservice_callthenusage', {times: 0}).then(toolOutput);
    assert.deepStrictEqual(none, {usage: {calls: 0, linesIn: 0, bytesIn: 0, tokensInEst: 0, servers: {}, sentence: 'no server was called'}}, 'a fresh call starts at nothing');
  });
});

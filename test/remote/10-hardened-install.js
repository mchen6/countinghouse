// A module that declares a remote, in countinghouse installed the way the
// README documents (npm hoists the dependencies beside
// node_modules/countinghouse) or with node_modules as a symlink, under
// --hardened. The MCP SDK loads on the main thread at the first remote call
// (lib/remote/client.js), and under --hardened the main thread runs under
// Node's permission model too, so the SDK's directory must be among what it
// may read: the first call answers, it is not refused ERR_ACCESS_DENIED
// (reviewer, 2026-11-12). fs-broker 14 holds the same layouts for a module
// with no remote.
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');
const {toolOutput} = require('../helpers/tool-result');
const {testPort} = require('../helpers/test-env');
const {startRemoteServer} = require('../helpers/remote-mcp-server');

const SERVER = testPort(9726);
const REMOTE = testPort(9699);
const KEY = 'remote-hardened-key';
const TOKEN = `ghp_${'A'.repeat(36)}`;
const PUBLISHED = ['framework.js', 'package.json', 'bin', 'lib', 'spec'];

// remote-probe, with its url at this file's port.
function probeIn(project) {
  const dir = path.join(project, 'modules', 'remote-probe');
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'remote-probe'), dir, {recursive: true});
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.countinghouse.remotes[0].url = `http://127.0.0.1:${REMOTE}/mcp`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  return dir;
}

// npm's layout: countinghouse's published files in node_modules/countinghouse,
// its dependencies hoisted beside it.
function hoisted(project) {
  const nm = path.join(project, 'node_modules');
  const installed = path.join(nm, 'countinghouse');
  fs.mkdirSync(installed, {recursive: true});
  PUBLISHED.forEach((p) => fs.cpSync(path.join(ROOT, p), path.join(installed, p), {recursive: true}));
  for (const entry of fs.readdirSync(path.join(ROOT, 'node_modules'))) {
    fs.cpSync(path.join(ROOT, 'node_modules', entry), path.join(nm, entry), {recursive: true, verbatimSymlinks: true});
  }
  assert.strictEqual(fs.existsSync(path.join(installed, 'node_modules')), false);
  return installed;
}

// A checkout whose node_modules is one symlink to another tree's.
function linkedNodeModules(project) {
  const installed = path.join(project, 'countinghouse');
  fs.mkdirSync(installed, {recursive: true});
  PUBLISHED.forEach((p) => fs.cpSync(path.join(ROOT, p), path.join(installed, p), {recursive: true}));
  fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(installed, 'node_modules'));
  return installed;
}

describe('remote 10: a remote\'s first call under --hardened, countinghouse installed as npm or with linked node_modules', function() {
  this.timeout(240000);
  let remote = null;
  let server = null;
  let project = null;
  before(async () => { remote = await startRemoteServer(REMOTE); });
  after(async () => { if (remote != null) await remote.close(); });
  afterEach(() => {
    stopServer(server);
    server = null;
    if (project != null) fs.rmSync(project, {recursive: true, force: true});
    project = null;
  });

  [['a hoisted npm install', hoisted], ['a symlinked node_modules', linkedNodeModules]].forEach(([label, make]) => {
    it(`${label}: the first remote call answers`, async () => {
      project = mkdtemp('remote-hardened-');
      const installed = make(project);
      const probe = probeIn(project);
      const allowance = path.join(project, 'remote-credentials.json');
      fs.writeFileSync(allowance, JSON.stringify({[`http://127.0.0.1:${REMOTE}`]: ['CH_TEST_REMOTE_TOKEN']}));
      server = await startServer(SERVER, ['--workerThread', '--hardened', '--debug', '--debugKey', KEY, '--moduleSandbox', 'enforce',
        // Under --hardened a module is loaded from inside --modulePath, the
        // granted module folder (fs-broker 14).
        '--modulePath', path.dirname(probe), '--moduleDataPath', path.join(project, 'store'),
        '--remoteCredentials', allowance, '--loadModule', probe],
      {root: installed, env: {CH_TEST_REMOTE_TOKEN: TOKEN}});
      const out = toolOutput(await mcpCall(SERVER, KEY, 'remote_probe_probeservice_calltool', {tool: 'echo_text', args: {n: 1}}));
      assert.deepStrictEqual(out, {result: {content: [{type: 'text', text: JSON.stringify({n: 1})}]}},
        `${JSON.stringify(out)}\n${server.output.slice(-3000)}`);
    });
  });
});

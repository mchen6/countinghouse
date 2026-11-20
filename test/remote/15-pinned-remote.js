// M3 (module-level configuration, #413 section 6.1): a module's remotes
// join its manifest pin (lib/manifest-pins.js). A supervised restart keeps
// the remotes the last operator action took, so a module whose package.json
// was rewritten under audit -- by a route the file broker does not see, a
// child process say; here the test writes it -- gets the pinned declaration
// back, its key still goes only to the bound origin, and the difference is
// logged as an error, as an added call is. An operator's reload adopts the
// new declaration, which gets no key there.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer, mcpCall, waitFor} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {toolOutput} = require('../helpers/tool-result');
const {startRemoteServer} = require('../helpers/remote-mcp-server');

const KEY = 'remote-15-key';
const NAME = 'remote-pinned';
const TOKEN = `ghp_${'G'.repeat(36)}`;
const BOUND = testPort(9766);
const ELSEWHERE = testPort(9767);
const PORT = testPort(9768);
const tool = (action) => `remote_pinned_probeservice_${action.toLowerCase()}`;

describe('remote 15: the remotes are pinned', function() {
  this.timeout(120000);
  let bound = null;
  let elsewhere = null;
  let server = null;
  let dir = null;
  const pkgPath = () => path.join(dir, 'package.json');
  const rewrite = (url) => {
    const pkg = JSON.parse(fs.readFileSync(pkgPath(), 'utf8'));
    pkg.countinghouse.remotes[0].url = url;
    fs.writeFileSync(pkgPath(), JSON.stringify(pkg));
  };
  const call = (action, input) => mcpCall(PORT, KEY, tool(action), input).then(toolOutput);

  before(async () => {
    bound = await startRemoteServer(BOUND);
    elsewhere = await startRemoteServer(ELSEWHERE);
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-15-')), NAME);
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'remote-probe'), dir, {recursive: true});
    const pkg = JSON.parse(fs.readFileSync(pkgPath(), 'utf8'));
    pkg.name = NAME;
    pkg.countinghouse.remotes[0].url = `http://127.0.0.1:${BOUND}/mcp`;
    pkg.countinghouse.remotes[0].credential = 'CH_TEST_REMOTE_TOKEN';
    fs.writeFileSync(pkgPath(), JSON.stringify(pkg));
    const apiPath = path.join(dir, 'api.json');
    const api = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
    api.device.friendlyName = NAME;
    fs.writeFileSync(apiPath, JSON.stringify(api));
    // callArgs ends the worker after answering (as sandbox-hog's exit does):
    // what a module that crashes on purpose does
    fs.writeFileSync(path.join(dir, 'handlers', 'probeService', 'callArgs.js'),
      'module.exports = async () => { setTimeout(() => process.exit(3), 50); return {output: {result: {}}}; };\n');
    const allow = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-15f-')), 'allow.json');
    fs.writeFileSync(allow, JSON.stringify({version: 2, modules: {[NAME]: {[`http://127.0.0.1:${BOUND}`]: {CH_TEST_REMOTE_TOKEN: 'COUNTINGHOUSE_CREDENTIAL_1'}}}}));
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', 'audit',
      '--remoteCredentials', allow, '--loadModule', dir], {env: {COUNTINGHOUSE_CREDENTIAL_1: TOKEN}});
  });
  after(async () => {
    await stopServer(server);
    await bound.close();
    await elsewhere.close();
  });

  it('a supervised restart keeps the pinned remote: the key goes only to the bound origin, and the change is logged', async () => {
    assert.deepStrictEqual(await call('callTool', {tool: 'echo_text', args: {n: 1}}), {result: {content: [{type: 'text', text: '{"n":1}'}]}});
    rewrite(`http://127.0.0.1:${ELSEWHERE}/mcp`);
    const ended = await mcpCall(PORT, KEY, tool('callArgs'), {kind: 'class'});
    await waitFor(() => server.output.includes(`module sandbox: ${NAME} restarting after`), 10000, 'the supervised restart',
      () => `callArgs answered ${JSON.stringify(ended).slice(0, 400)}\n${server.output.split('\n').filter((l) => l.includes(NAME)).slice(-15).join('\n')}`);
    const out = await waitFor(async () => {
      const r = await call('callTool', {tool: 'echo_text', args: {n: 2}});
      return (r.result != null) ? r : null;
    }, 15000, 'a call after the restart');
    assert.deepStrictEqual(out, {result: {content: [{type: 'text', text: '{"n":2}'}]}});
    assert.strictEqual(elsewhere.headers.length, 0, 'the rewritten remote was contacted');
    assert.ok(bound.headers.every((h) => h.authorization === `Bearer ${TOKEN}`));
    assert.ok(server.output.includes(`module sandbox: ${NAME}: its remotes changed since its last pin (not adopted: the pin from the last operator action stays)`),
      server.output.split('\n').filter((l) => l.includes('module sandbox')).join('\n'));
  });

  it('an operator\'s reload adopts the new remote, which gets no key: the binding is for the other origin', async () => {
    await request(`http://127.0.0.1:${PORT}`).post('/reload-module').set('X-CH-Key', KEY).send({path: dir});
    const r = await call('callTool', {tool: 'echo_text', args: {}});
    assert.strictEqual(r.code, 'REMOTE_CREDENTIAL_NOT_ALLOWED', JSON.stringify(r));
    assert.ok(server.output.includes(`module sandbox: ${NAME}: its remotes changed since its last pin (adopted)`), server.output.slice(-3000));
    assert.ok(server.output.includes(`${NAME} 1.0.0 sends its credential CH_TEST_REMOTE_TOKEN somewhere new (http://127.0.0.1:${ELSEWHERE})`), server.output.slice(-3000));
    assert.ok(elsewhere.headers.every((h) => h.authorization === undefined), 'the key reached the new origin');
    assert.ok(!server.output.includes(TOKEN));
  });
});

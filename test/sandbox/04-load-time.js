// What the main thread decides before a module's worker starts: refusal in
// enforce, effective permissions, the worker's environment.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');

const KEY    = 'aabbcc';
const PROBE  = path.join(ROOT, 'test', 'fixtures', 'sandbox-probe');
const NATIVE = path.join(ROOT, 'test', 'fixtures', 'sandbox-native');

function policyFile(obj) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-policy-')), 'policy.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

async function load(port, modulePath, name) {
  return mcpCall(port, KEY, 'countinghouse_load_module', {path: modulePath, name: name, version: '1.0.0'});
}

describe('sandbox 04: load-time decisions', function() {
  this.timeout(90000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  it('enforce refuses a module with native code, naming the problem', async () => {
    server = await startServer(9607, ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', 'enforce']);
    const r = await load(9607, NATIVE, 'sandbox-native');
    assert.strictEqual(r.isError, true, JSON.stringify(r));
    assert.strictEqual(r.structuredContent.code, 'MODULE_SANDBOX_REFUSED');
    assert.ok(server.output.includes('fake.node'), server.output.slice(-2000));
  });

  it('audit loads the same module and logs the problem', async () => {
    server = await startServer(9607, ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread']);
    const r = await load(9607, NATIVE, 'sandbox-native');
    assert.strictEqual(r.structuredContent.loaded, true, JSON.stringify(r));
    assert.ok(server.output.includes('module sandbox: sandbox-native would be refused under enforce'), server.output.slice(-2000));
  });

  it('a module with no countinghouse key loads with no refusal and no violation lines', async () => {
    server = await startServer(9607, ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', 'enforce']);
    const r = await load(9607, path.join(ROOT, 'test', 'fixtures', 'handler-map-convention'), 'handler-map-convention');
    assert.strictEqual(r.structuredContent.loaded, true, JSON.stringify(r));
    const call = await mcpCall(9607, KEY, r.structuredContent.toolNames[0], {name: 'x'});
    assert.strictEqual(call.isError, false, JSON.stringify(call));
    assert.ok(!/module sandbox: handler-map-convention (violation|would be refused)/.test(server.output), server.output.slice(-2000));
  });

  it('logs effective permissions and gives the worker only approved env', async () => {
    const policy = policyFile({modules: {'sandbox-probe': {env: {PROBE_FROM_POLICY: 'p', PROBE_FROM_SERVER: null}}}});
    server = await startServer(9607,
      ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', 'enforce', '--modulePolicy', policy],
      {env: {PROBE_FROM_SERVER: 's', PROBE_UNAPPROVED: 'u', PROBE_FROM_POLICY: 'server-loses'}});
    const r = await load(9607, PROBE, 'sandbox-probe');
    assert.strictEqual(r.structuredContent.loaded, true, JSON.stringify(r));
    assert.ok(server.output.includes('module sandbox: sandbox-probe effective permissions'), server.output.slice(-2000));
    const env = await mcpCall(9607, KEY, 'sandbox_probe_probeservice_env', {});
    assert.deepStrictEqual(env.structuredContent.output.env, {PROBE_FROM_POLICY: 'p', PROBE_FROM_SERVER: 's'});
  });

  it('re-reads the policy file when the module restarts', async () => {
    const policy = policyFile({modules: {'sandbox-probe': {env: {PROBE_FROM_POLICY: 'first'}}}});
    server = await startServer(9607,
      ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', 'enforce', '--modulePolicy', policy]);
    await load(9607, PROBE, 'sandbox-probe');
    fs.writeFileSync(policy, JSON.stringify({modules: {'sandbox-probe': {env: {PROBE_FROM_POLICY: 'second'}}}}));
    await require('../helpers/sandbox-server').post(9607, KEY, '/restart-module', {path: PROBE, name: 'sandbox-probe', version: '1.0.0'});
    const env = await require('../helpers/sandbox-server').waitFor(async () => {
      const r = await mcpCall(9607, KEY, 'sandbox_probe_probeservice_env', {});
      return r.isError === false && r.structuredContent.output.env.PROBE_FROM_POLICY === 'second' ? r : null;
    }, 20000, 'env after restart');
    assert.ok(env);
  });

  it('enforce without a policy entry gives a module that declares env none of it', async () => {
    server = await startServer(9607,
      ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', 'enforce'],
      {env: {PROBE_FROM_SERVER: 's'}});
    await load(9607, PROBE, 'sandbox-probe');
    const env = await mcpCall(9607, KEY, 'sandbox_probe_probeservice_env', {});
    assert.deepStrictEqual(env.structuredContent.output.env, {});
  });
});

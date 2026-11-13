// A part reached by a hop can make its own remote calls (reviewer, 2026-11-12;
// ch-local's acceptance run). In worker mode a hop's args were {input,
// usageCall} only, and neither route (the main thread, or the direct peer
// channel) gave the callee a caller identity (no args.ctx). Its remote call then had
// no billing key, and lib/remote refused it with HOP_IDENTITY_UNRESOLVED. In
// pack 1, ci_failure_triage hops to ch-access-github, which calls GitHub, so
// no triage could ever complete. Single-thread mode set args.ctx and so did
// not show it.
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

const PORT = testPort(9742);
const STAND_IN = testPort(9743);
const KEY = 'remote-11-key';
const TOKEN = `ghp_${'D'.repeat(36)}`;

function writeCaller(dir) {
  fs.mkdirSync(path.join(dir, 'handlers', 'hopService'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'hop-caller', version: '1.0.0', countinghouse: {role: 'scenario', calls: ['remote-probe/probeService.callTool']}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'hop-caller', manufacturer: 'countinghouse-test', modelDescription: 'remote 11: a hop into a part that calls its remote',
    serviceList: {'urn:countinghouse-test:serviceID:hopService': {actionList: [{name: 'via_part', description: 'Hops into remote-probe, whose handler calls its remote.',
      input: {schema: '/hopService/via_part/input'}, output: {schema: '/hopService/via_part/output'}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    hopService: {via_part: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'hopService', 'via_part.js'),
    "module.exports = async (input, ctx) => ({output: (await ctx.call('remote-probe/probeService.callTool', {tool: 'echo_text', args: {a: 1}})).output});\n");
}

// Both of a worker's hop routes: the direct peer channel (the default here)
// and the main thread (as the client profile runs, with no peer channels).
[['worker mode, by the direct peer channel', ['--workerThread']], ['worker mode, through the main thread', ['--workerThread', '--no-directPeerChannels']], ['single-thread mode', ['--no-workerThread']]].forEach(([mode, thread]) => {
  describe(`remote 11: a part reached by a hop calls its remote, ${mode}`, function() {
    this.timeout(120000);
    let standIn = null;
    let server = null;
    let root = null;
    before(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-11-'));
      // As a pack is: the scenario, and its part under its node_modules.
      const caller = path.join(root, 'hop-caller');
      const probe = path.join(caller, 'node_modules', 'remote-probe');
      fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'remote-probe'), probe, {recursive: true});
      const pkgPath = path.join(probe, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.countinghouse.remotes[0].url = `http://127.0.0.1:${STAND_IN}/mcp`;
      pkg.countinghouse.role = 'part';
      fs.writeFileSync(pkgPath, JSON.stringify(pkg));
      writeCaller(caller);
      // One key: the debug key and the identity that runs hop-caller's hops
      // (runsModules), as test/composition/04 does.
      const auth = path.join(root, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'remote-11', devices: ['*'], runsModules: ['hop-caller']}}));
      const allowance = path.join(root, 'remote-credentials.json');
      fs.writeFileSync(allowance, JSON.stringify({[`http://127.0.0.1:${STAND_IN}`]: ['CH_TEST_REMOTE_TOKEN']}));
      standIn = await startRemoteServer(STAND_IN);
      // --store local keeps no Redis; startServer would add the harness's --redisUrl.
      const redisUrl = process.env.CH_TEST_REDIS_URL;
      delete process.env.CH_TEST_REDIS_URL;
      try {
        server = await startServer(PORT, ['--debug', '--debugKey', KEY, ...thread,
          '--store', 'local', '--storePath', path.join(root, 'store'), '--moduleDataPath', path.join(root, 'module_data'), '--modulePath', path.join(root, 'modules'),
          '--authConfigPath', auth, '--remoteCredentials', allowance, '--loadModule', caller], {env: {CH_TEST_REMOTE_TOKEN: TOKEN}});
      } finally {
        if (redisUrl !== undefined) process.env.CH_TEST_REDIS_URL = redisUrl;
      }
    });
    after(async () => {
      if (server != null) await stopServer(server);
      if (standIn != null) await standIn.close();
      if (root != null) fs.rmSync(root, {recursive: true, force: true});
    });

    it('the part\'s remote call answers, billed to the hop\'s caller', async () => {
      const raw = await mcpCall(PORT, KEY, 'via_part', {});
      const out = toolOutput(raw);
      assert.deepStrictEqual(out, {result: {content: [{type: 'text', text: '{"a":1}'}]}}, JSON.stringify(raw).slice(0, 1500));
      assert.ok(standIn.headers.some((h) => h.authorization === `Bearer ${TOKEN}`));
    });
  });
});

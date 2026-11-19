'use strict';
// The CDIF-era module registry (lib/device-db, sqlite3) is opt-in:
// --moduleRegistry. Without it, a start with no --loadModule reads no
// registry and loads nothing from --modulePath: its discovery finishes at
// once with nothing, and it serves the platform tools. sqlite3 is optional
// and absent from a ch-local install, and a start with no pack (ch-local
// #55) crashed on the registry before it listened (#54's acceptance run).
// Its other readers follow the flag too: an unload removes no registry row,
// and --hardened grants native addons only when something needs them.
// Over real stdio (no port), with sqlite3 unloadable
// (test/fixtures/no-sqlite3-preload.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, MODERN_META} = require('../helpers/stdio-client');
const {permissionFlags} = require('../../lib/hardened-launch');
const {spawn} = require('child_process');
const http = require('http');
const waitForReady = require('../helpers/wait-for-ready');
const {testPort, redisArgs} = require('../helpers/test-env');

const PRELOAD = path.join(__dirname, '..', 'fixtures', 'no-sqlite3-preload.js');
const SVC = 'urn:countinghouse-test:serviceID:packService';

function pack(packs, scenario, tool) {
  const dir = path.join(packs, scenario, '1.0.0', 'node_modules', scenario);
  fs.mkdirSync(path.join(dir, 'handlers', 'packService'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: scenario, version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: scenario, manufacturer: 'countinghouse-test', modelDescription: scenario,
    serviceList: {[SVC]: {actionList: [{name: tool, description: `${tool} it`, input: {schema: `/packService/${tool}/input`}, output: {schema: `/packService/${tool}/output`}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    packService: {[tool]: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'packService', `${tool}.js`), 'module.exports = async () => ({output: {}});\n');
  return dir;
}

const {dirsOf} = require('../helpers/module-dirs');

describe('module-loading 33: the module registry is opt-in (--moduleRegistry)', function() {
  this.timeout(120000);
  const homes = [];
  let io = null;
  afterEach(async () => {
    if (io != null && io.child.exitCode == null) { io.child.kill(); await io.exited; }
    io = null;
  });
  after(() => { for (const h of homes) fs.rmSync(h, {recursive: true, force: true}); });
  const home = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ml-33-')); homes.push(h); fs.mkdirSync(path.join(h, 'modules')); return h; };
  const base = (h) => ['--workerThread', '--store', 'local', '--storePath', path.join(h, 'store'), '--modulePath', path.join(h, 'modules'),
    '--moduleDataPath', path.join(h, 'module_data')];

  it('a start with no --loadModule and no sqlite3 listens, and lists the platform tools', async () => {
    const h = home();
    io = startStdio(base(h), {nodeArgs: ['-r', PRELOAD]});
    const r = await io.request({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {_meta: MODERN_META}}, 60000);
    assert.ok(r != null && r.result != null, `${JSON.stringify(r)}\n${io.err.slice(-2000)}`);
    assert.ok(r.result.tools.some((t) => t.name === 'countinghouse_usage_report'), JSON.stringify(r.result.tools.map((t) => t.name)));
    assert.doesNotMatch(io.err, /sqlite3/, 'the registry was not reached');
  });

  it('a pack loaded and unloaded on such a start: the unload removes no registry row (no sqlite3 reached)', async () => {
    const h = home();
    const packs = path.join(h, 'packs');
    const dir = pack(packs, 'ch-pack-reg', 'reg_tool');
    io = startStdio(base(h).concat(['--controlChannel', 'ipc', '--modulesRoot', packs]), {ipc: true, nodeArgs: ['-r', PRELOAD]});
    const loaded = await io.control({type: 'load', name: 'ch-pack-reg', dirs: dirsOf(dir)});
    assert.strictEqual(loaded.ok, true, `${JSON.stringify(loaded)}\n${io.err.slice(-2000)}`);
    const gone = await io.control({type: 'unload', name: 'ch-pack-reg'});
    assert.strictEqual(gone.ok, true, `${JSON.stringify(gone)}\n${io.err.slice(-2000)}`);
  });

  it('--moduleRegistry with no sqlite3 still ends with the clear error', async () => {
    const h = home();
    io = startStdio(base(h).concat(['--moduleRegistry']), {nodeArgs: ['-r', PRELOAD]});
    const code = await io.exited;
    assert.notStrictEqual(code, 0);
    assert.match(io.err, /requires the optional "sqlite3" package/);
  });

  // A start with nothing to load finishes discovery at once, and
  // listen(port, host) binds only after resolving its host: discovery waits
  // for the bind, so "countinghouse ready" never comes before the port takes
  // connections (module-authoring 03's first request was refused).
  it('over HTTP: the first request right after the ready line is answered', (done) => {
    const ROOT = path.join(__dirname, '..', '..');
    const PORT = testPort(9594);
    const h = home();
    const server = spawn(process.execPath, ['-r', PRELOAD, path.join(ROOT, 'framework.js'), '--no-workerThread', '--debug', '--debugKey', 'aabbcc', '--bindAddr', '127.0.0.1',
      '--port', String(PORT), '--modulePath', path.join(h, 'modules'), '--moduleDataPath', path.join(h, 'module_data')].concat(redisArgs()),
    {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    const stop = (err) => { try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* gone */ } done(err); };
    waitForReady(server, (err) => {
      if (err) return stop(err);
      const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}});
      const req = http.request({host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-CH-Key': 'aabbcc', 'Content-Length': Buffer.byteLength(body)}}, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { assert.ok(JSON.parse(data).result.tools.length > 0, data.slice(0, 300)); stop(); } catch (e) { stop(e); }
        });
      });
      req.on('error', stop);
      req.end(body);
    });
  });

  // The review: the flag reads as every boolean flag does (#124): =true, and
  // repeated, by its last value; and it means nothing beside --loadModule.
  it('--moduleRegistry reads as a boolean flag: =true and repeated count; with --loadModule the registry is not used', () => {
    const {spawnSync} = require('child_process');
    const usesOf = (argv) => {
      const script = `const o = require(${JSON.stringify(path.join(__dirname, '..', '..', 'lib', 'cli-options'))}); o.setOptions(${JSON.stringify(argv)});
        process.stdout.write(JSON.stringify([o.moduleRegistry, o.usesModuleRegistry(), o.getOptions().moduleRegistry]));`;
      const run = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 20000});
      assert.strictEqual(run.status, 0, run.stderr);
      return JSON.parse(run.stdout);
    };
    assert.deepStrictEqual(usesOf({}), [false, false, false]);
    assert.deepStrictEqual(usesOf({moduleRegistry: true}), [true, true, true]);
    assert.deepStrictEqual(usesOf({moduleRegistry: 'true'}), [true, true, true]);
    assert.deepStrictEqual(usesOf({moduleRegistry: ['true', 'true']}), [true, true, true]);
    assert.deepStrictEqual(usesOf({moduleRegistry: true, loadModule: '/m/x'}), [true, false, true]);
  });

  it('--hardened grants native addons only for --moduleRegistry or the sqlite auth provider', () => {
    const flags = (o) => permissionFlags(Object.assign({modulePath: '/m', moduleDataPath: '/d'}, o), '/install', '/');
    assert.ok(!flags({}).includes('--allow-addons'), 'a bare start: none');
    assert.ok(!flags({localModulePath: '/m/x'}).includes('--allow-addons'));
    assert.ok(flags({moduleRegistry: true}).includes('--allow-addons'));
    assert.ok(flags({authProvider: 'sqlite'}).includes('--allow-addons'));
  });
});

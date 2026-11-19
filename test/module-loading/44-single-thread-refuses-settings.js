'use strict';
// Module settings run only with worker threads (the user's decision,
// 11-18): in single-thread mode (--no-workerThread) a module that declares
// settings is refused at its load, SETTINGS_NEED_WORKER_THREADS ("<pkg>
// declares settings, which run only with worker threads (--workerThread)"),
// and a reload to a version that declares them is refused before anything
// is unloaded, the loaded version serving on; a module that declares none
// loads as before. Spawned over HTTP (the admin reload route, POST
// /reload-module).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {spawn} = require('child_process');
const waitForReady = require('../helpers/wait-for-ready');
const {testPort, redisArgs} = require('../helpers/test-env');

const ROOT = path.join(__dirname, '..', '..');
const PORT = testPort(9640);
const KEY = 'aabbcc';
const SVC = 'urn:countinghouse-test:serviceID:showService';

function moduleAt(dir, name, version, settings) {
  fs.mkdirSync(path.join(dir, 'handlers', 'showService'), {recursive: true});
  const pkg = {name, version, license: 'Apache-2.0'};
  if (settings != null) pkg.countinghouse = {settings};
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'countinghouse-test', modelDescription: name,
    serviceList: {[SVC]: {actionList: [{name: 'show', description: 'show it', input: {schema: '/showService/show/input'}, output: {schema: '/showService/show/output'}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    showService: {show: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'showService', 'show.js'), `module.exports = async () => ({output: {version: '${version}'}});\n`);
  return dir;
}

function post(route, body) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request({host: '127.0.0.1', port: PORT, path: route, method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-CH-Key': KEY, 'Content-Length': Buffer.byteLength(text)}}, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({status: res.statusCode, body: data}));
    });
    req.on('error', reject);
    req.end(text);
  });
}

describe('module-loading 44: single-thread mode refuses a module that declares settings; one that declares none loads', function() {
  this.timeout(60000);
  let home = null;
  let server = null;
  let stderr = '';
  after(() => {
    if (server != null) { try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });

  const toolNames = async () => JSON.parse((await post('/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}})).body).result.tools.map((t) => t.name);

  it('at load and at reload; the loaded version serving on', (done) => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ml-44-'));
    const settings = {units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric'}};
    const declaring = moduleAt(path.join(home, 'declaring'), 'declaring-mod', '1.0.0', settings);
    const plainV1 = moduleAt(path.join(home, 'plain-v1'), 'plain-mod', '1.0.0', null);
    const plainV2 = moduleAt(path.join(home, 'plain-v2'), 'plain-mod', '2.0.0', settings);
    server = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--no-workerThread', '--debug', '--debugKey', KEY, '--bindAddr', '127.0.0.1', '--port', String(PORT),
      '--moduleDataPath', path.join(home, 'module_data'), '--loadModule', declaring, '--loadModule', plainV1].concat(redisArgs()),
    {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    server.stderr.on('data', (d) => { stderr += d; });
    server.stdout.on('data', (d) => { stderr += d; });
    waitForReady(server, async (err) => {
      try {
        if (err) throw err;
        const names = await toolNames();
        assert.ok(names.some((n) => /plain_mod/.test(n)), `the one that declares none loads: ${JSON.stringify(names)}`);
        assert.ok(!names.some((n) => /declaring_mod/.test(n)), `the one that declares settings is not loaded: ${JSON.stringify(names)}`);
        assert.match(stderr, /declaring-mod declares settings, which run only with worker threads \(--workerThread\)/);
        // a reload to a version that declares settings: refused, v1 serving on
        const reload = await post('/reload-module', {path: plainV2});
        assert.notStrictEqual(reload.status, 200, reload.body);
        assert.match(reload.body, /SETTINGS_NEED_WORKER_THREADS|run only with worker threads/);
        const tool = (await toolNames()).find((n) => /plain_mod/.test(n));
        assert.ok(tool != null, 'still loaded');
        const res = JSON.parse((await post('/mcp', {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: tool, arguments: {}}})).body);
        assert.deepStrictEqual(res.result.structuredContent, {version: '1.0.0'});
        done();
      } catch (e) {
        done(e);
      }
    });
  });
});

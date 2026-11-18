'use strict';
// Single-thread mode: a reload of a module that declares settings makes the
// new instance's settings state (lib/module-manager.js reloadModule: its own
// ticket, which then serves), so its calls run with the settings, never
// refused SETTING_NOT_READY for want of a state (lib/settings-gate.js, fail
// closed). Spawned over HTTP (the admin reload route, POST /reload-module),
// the values from --moduleSettings.
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

function moduleAt(dir, version) {
  fs.mkdirSync(path.join(dir, 'handlers', 'showService'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'settings-reload', version, license: 'Apache-2.0',
    countinghouse: {settings: {units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric'}}}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'settings-reload', manufacturer: 'countinghouse-test', modelDescription: 'settings-reload',
    serviceList: {[SVC]: {actionList: [{name: 'show', description: 'show the settings', input: {schema: '/showService/show/input'}, output: {schema: '/showService/show/output'}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    showService: {show: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'showService', 'show.js'),
    `module.exports = async (input, ctx) => ({output: {version: '${version}', settings: Object.assign({}, ctx.settings)}});\n`);
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

describe('module-loading 44: single-thread mode: a reload of a module that declares settings runs with them', function() {
  this.timeout(60000);
  let home = null;
  let server = null;
  after(() => {
    if (server != null) { try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });

  const show = async () => {
    const list = JSON.parse((await post('/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}})).body);
    const tool = list.result.tools.find((t) => /settings_reload/.test(t.name));
    assert.ok(tool != null, JSON.stringify(list.result.tools.map((t) => t.name)));
    const res = JSON.parse((await post('/mcp', {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: tool.name, arguments: {}}})).body);
    return res.result;
  };

  it('before and after the reload: the values from --moduleSettings, never SETTING_NOT_READY', (done) => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ml-44-'));
    const v1 = moduleAt(path.join(home, 'v1'), '1.0.0');
    const v2 = moduleAt(path.join(home, 'v2'), '2.0.0');
    const settings = path.join(home, 'module-settings.json');
    fs.writeFileSync(settings, JSON.stringify({'settings-reload': {units: 'imperial'}}));
    server = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--no-workerThread', '--debug', '--debugKey', KEY, '--bindAddr', '127.0.0.1', '--port', String(PORT),
      '--moduleDataPath', path.join(home, 'module_data'), '--moduleSettings', settings, '--loadModule', v1].concat(redisArgs()),
    {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    waitForReady(server, async (err) => {
      try {
        if (err) throw err;
        const before = await show();
        assert.notStrictEqual(before.isError, true, JSON.stringify(before));
        assert.deepStrictEqual(before.structuredContent, {version: '1.0.0', settings: {units: 'imperial'}});
        const reload = await post('/reload-module', {path: v2});
        assert.strictEqual(reload.status, 200, reload.body);
        const after = await show();
        assert.ok(after._meta == null || after._meta['countinghouse/code'] !== 'SETTING_NOT_READY', JSON.stringify(after));
        assert.deepStrictEqual(after.structuredContent, {version: '2.0.0', settings: {units: 'imperial'}});
        done();
      } catch (e) {
        done(e);
      }
    });
  });
});

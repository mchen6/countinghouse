'use strict';
// MCP completeness M2, the review: in single-thread mode a reload whose
// version declares an icon the load refuses (here an SVG) is refused before
// the loaded version is unloaded, as every other refusal of a reload's
// files is (lib/module-manager.js layoutRefused), and as worker mode refuses
// it at the spawn. The loaded version keeps serving, its icon as it was.
// Spawned over HTTP (the admin reload route, POST /reload-module).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {spawn} = require('child_process');
const waitForReady = require('../helpers/wait-for-ready');
const {testPort, redisArgs} = require('../helpers/test-env');

const ROOT = path.join(__dirname, '..', '..');
const PORT = testPort(9600);
const KEY = 'aabbcc';
const SVC = 'urn:countinghouse-test:serviceID:iconService';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('one')]);

function moduleAt(dir, version, icon, file) {
  fs.mkdirSync(path.join(dir, 'handlers', 'iconService'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'icons'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'icon-reload', version, license: 'Apache-2.0'}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'icon-reload', manufacturer: 'countinghouse-test', modelDescription: 'icon-reload',
    serviceList: {[SVC]: {actionList: [{name: 'go', description: 'go it', title: `go ${version}`, icons: [{file}], input: {schema: '/iconService/go/input'}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    iconService: {go: {input: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'iconService', 'go.js'), 'module.exports = async () => ({output: {}});\n');
  fs.writeFileSync(path.join(dir, file), icon);
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

describe('module-loading 34: single-thread mode refuses a reload\'s bad icon before unloading (M2)', function() {
  this.timeout(60000);
  let home = null;
  let server = null;
  after(() => {
    if (server != null) { try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });

  it('a reload to an SVG icon is refused; the loaded version still serves, its icon as it was', (done) => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ml-34-'));
    const v1 = moduleAt(path.join(home, 'v1'), '1.0.0', PNG, 'icons/go.png');
    const v2 = moduleAt(path.join(home, 'v2'), '2.0.0', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'icons/go.svg');
    server = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--no-workerThread', '--debug', '--debugKey', KEY, '--bindAddr', '127.0.0.1', '--port', String(PORT),
      '--moduleDataPath', path.join(home, 'module_data'), '--loadModule', v1].concat(redisArgs()), {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    waitForReady(server, async (err) => {
      try {
        if (err) throw err;
        const reload = await post('/reload-module', {path: v2});
        assert.notStrictEqual(reload.status, 200, reload.body);
        assert.match(reload.body, /SVG is refused/);
        const list = JSON.parse((await post('/mcp', {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}})).body);
        const tool = list.result.tools.find((t) => /icon_reload/.test(t.name));
        assert.ok(tool != null, `the loaded version was unloaded: ${JSON.stringify(list.result.tools.map((t) => t.name))}`);
        assert.deepStrictEqual([tool.title, tool.icons[0].src], ['go 1.0.0', `data:image/png;base64,${PNG.toString('base64')}`]);
        done();
      } catch (e) {
        done(e);
      }
    });
  });
});

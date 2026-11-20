'use strict';
// countinghouse_overview on a hosted runtime (B-firstrun): each caller sees
// only the modules its own tools/list shows -- the same scope -- so the
// answer is no oracle of what else is loaded; nothing of ch-local (no
// install record, no command); and it changes nothing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {deviceIDForName} = require('../../lib/call-address');
const tmp = require('../helpers/test-tmp').forFile(['ch-auth-60-']);

describe('auth 60: countinghouse_overview\'s scope on a hosted runtime (B-firstrun)', function() {
  this.timeout(60000);
  const ALL = `ka${require('crypto').randomBytes(12).toString('hex')}`;
  const ECHO_ONLY = `ke${require('crypto').randomBytes(12).toString('hex')}`;
  const NONE = `kn${require('crypto').randomBytes(12).toString('hex')}`;
  const port = testPort(9826);
  let server = null;
  after(() => { if (server != null) stopServer(server); });

  const rpc = (key, method, params) => new Promise((resolve, reject) => {
    const data = JSON.stringify({jsonrpc: '2.0', id: 1, method, params});
    const rq = http.request({host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: {'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data), 'X-CH-Key': key}}, (r) => {
      let t = '';
      r.on('data', (c) => { t += c; });
      r.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { resolve({raw: t}); } });
    });
    rq.on('error', reject);
    rq.end(data);
  });
  const overviewOf = async (key) => {
    const r = await rpc(key, 'tools/call', {name: 'countinghouse_overview', arguments: {}});
    assert.ok(r.result != null && r.result.isError === false, JSON.stringify(r));
    return r.result;
  };

  before(async () => {
    const dir = tmp.mkdtemp('ch-auth-60-');
    const auth = path.join(dir, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[ALL]: {userName: 'all', devices: ['*']}, [ECHO_ONLY]: {userName: 'echo', devices: [deviceIDForName('echo-device')]},
      [NONE]: {userName: 'none', devices: []}}));
    server = await startServer(port, ['--workerThread', '--authProvider', 'file', '--authConfigPath', auth, '--moduleDataPath', path.join(dir, 'data'),
      '--loadModule', path.join(ROOT, 'pre-installed-packages', 'echo-device-module'), '--loadModule', path.join(ROOT, 'pre-installed-packages', 'composite-demo')]);
  });

  it('each caller sees the modules its own tools/list shows, and no more', async () => {
    const names = async (key) => (await overviewOf(key)).structuredContent.packs.map((p) => p.name).sort();
    const listedModules = async (key) => {
      const tools = (await rpc(key, 'tools/list', {})).result.tools.map((t) => t.name);
      return {echo: tools.some((t) => t.startsWith('echo_device_')), composite: tools.some((t) => t.startsWith('composite_demo_'))};
    };
    // (each by its package name, echo-device-module, not its api.json friendlyName, echo-device)
    const all = await names(ALL);
    assert.ok(all.includes('echo-device-module') && !all.includes('echo-device'), JSON.stringify(all));
    assert.deepStrictEqual(await names(ECHO_ONLY), ['echo-device-module']);
    assert.deepStrictEqual(await listedModules(ECHO_ONLY), {echo: true, composite: false}, 'the same scope as its tools/list');
    const none = await overviewOf(NONE);
    assert.deepStrictEqual(none.structuredContent.packs, []);
    assert.ok(none.content[0].text.includes('No packs are installed.'), none.content[0].text);
  });

  it('nothing of ch-local on a hosted runtime: no command, no record; every pack listed is ready', async () => {
    const r = await overviewOf(ALL);
    assert.ok(!/ch-local|credentials add/.test(r.content[0].text), r.content[0].text);
    assert.ok(r.structuredContent.packs.every((p) => p.state === 'ready' && p.next == null), JSON.stringify(r.structuredContent));
    const tools = (await rpc(ALL, 'tools/list', {})).result.tools.map((t) => t.name);
    for (const p of r.structuredContent.packs) for (const t of p.tools) assert.ok(tools.includes(t), `${t} is not in the caller's tools/list`);
  });

  tmp.hooks();
});

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
  const inProcessPort = testPort(9827);
  let server = null;
  let inProcess = null;
  after(() => { for (const s of [server, inProcess]) if (s != null) stopServer(s); });

  const rpc = (key, method, params, at = port) => new Promise((resolve, reject) => {
    const data = JSON.stringify({jsonrpc: '2.0', id: 1, method, params});
    const rq = http.request({host: '127.0.0.1', port: at, path: '/mcp', method: 'POST', headers: {'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data), 'X-CH-Key': key}}, (r) => {
      let t = '';
      r.on('data', (c) => { t += c; });
      r.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { resolve({raw: t}); } });
    });
    rq.on('error', reject);
    rq.end(data);
  });
  const overviewOf = async (key, at = port) => {
    const r = await rpc(key, 'tools/call', {name: 'countinghouse_overview', arguments: {}}, at);
    assert.ok(r.result != null && r.result.isError === false, JSON.stringify(r));
    return r.result;
  };

  const start = (at, mode) => {
    const dir = tmp.mkdtemp('ch-auth-60-');
    const auth = path.join(dir, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[ALL]: {userName: 'all', devices: ['*']}, [ECHO_ONLY]: {userName: 'echo', devices: [deviceIDForName('echo-device')]},
      [NONE]: {userName: 'none', devices: []}}));
    return startServer(at, [...mode, '--authProvider', 'file', '--authConfigPath', auth, '--moduleDataPath', path.join(dir, 'data'),
      '--loadModule', path.join(ROOT, 'pre-installed-packages', 'echo-device-module'), '--loadModule', path.join(ROOT, 'pre-installed-packages', 'composite-demo')]);
  };
  before(async () => { server = await start(port, ['--workerThread']); });

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
    assert.strictEqual(none.structuredContent.notice, 'No packs are installed.');
  });

  it('nothing of ch-local on a hosted runtime: no command, no record; every pack listed is ready', async () => {
    const r = await overviewOf(ALL);
    assert.ok(!/ch-local|credentials add/.test(r.content[0].text), r.content[0].text);
    assert.ok(r.structuredContent.packs.every((p) => p.state === 'ready' && p.next == null), JSON.stringify(r.structuredContent));
    const tools = (await rpc(ALL, 'tools/list', {})).result.tools.map((t) => t.name);
    for (const p of r.structuredContent.packs) for (const t of p.tools) assert.ok(tools.includes(t), `${t} is not in the caller's tools/list`);
  });

  // (the high review of #490, 3) in-process, a device's module is its own
  // moduleName: the same packs, every one ready with its tools
  it('in-process (--workerThread false): the same packs and tools', async () => {
    const was = (await overviewOf(ALL)).structuredContent.packs.map((p) => [p.name, p.state, p.tools.slice().sort()]);
    inProcess = await start(inProcessPort, ['--workerThread', 'false']);
    const now = (await overviewOf(ALL, inProcessPort)).structuredContent;
    assert.strictEqual(now.notice, undefined, JSON.stringify(now));
    assert.deepStrictEqual(now.packs.map((p) => [p.name, p.state, p.tools.slice().sort()]), was);
    assert.ok(now.packs.length > 0 && now.packs.every((p) => p.tools.length > 0), JSON.stringify(now));
  });

  tmp.hooks();
});

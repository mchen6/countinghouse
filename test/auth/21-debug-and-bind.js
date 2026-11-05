// --debug without --debugKey makes every request an admin, load_module
// included. Together with binding a network address by default and JSON
// parsed from text/plain (a cross-site POST needs no preflight), anyone on
// the network, or any web page the developer opened, could drive the admin
// routes (review R1-2). Now: the default bind is 127.0.0.1 (user decision,
// 2026-11-04), --debug without --debugKey on any other address refuses to
// start, and text/plain is not parsed as JSON.
const assert = require('assert');
const path = require('path');
const {spawn} = require('child_process');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');

// framework.js with exactly these flags (no --bindAddr added); resolves on its
// listen line, or on exit.
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'framework.js')].concat(args),
      {cwd: ROOT, env: Object.assign({}, process.env, {NODE_PATH: path.join(ROOT, 'lib')}), stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    let out = '';
    const done = (r) => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } resolve(r); };
    const timer = setTimeout(() => done({timeout: true, out: out}), 30000);
    const see = (c) => {
      out += c;
      const m = /countinghouse listen on: ([^:\s]+):/.exec(out);
      if (m != null) { clearTimeout(timer); done({listen: m[1], out: out}); }
    };
    child.stdout.on('data', see);
    child.stderr.on('data', see);
    child.on('exit', (code) => { clearTimeout(timer); resolve({code: code, out: out}); });
  });
}

function post(port, type, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const req = require('http').request({host: '127.0.0.1', port: port, path: '/mcp', method: 'POST',
      headers: {'Content-Type': type, 'Accept': 'application/json, text/event-stream', 'X-CH-Key': 'k', 'Content-Length': data.length}}, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({status: res.statusCode, text: text}));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('auth 21: --debug, the default bind address and text/plain', function() {
  this.timeout(60000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  it('binds 127.0.0.1 when --bindAddr is not given', async () => {
    const r = await run(['--workerThread', '--port', '9662', '--debug', '--debugKey', 'k']);
    assert.strictEqual(r.listen, '127.0.0.1', r.out.slice(-1500));
  });

  it('refuses --debug without --debugKey on a non-loopback address, saying what to do', async () => {
    const r = await run(['--workerThread', '--port', '9662', '--debug', '--bindAddr', '0.0.0.0']);
    assert.strictEqual(r.code, 2, r.out.slice(-1500));
    ['--debug', '--debugKey', '127.0.0.1'].forEach((s) => assert.ok(r.out.includes(s), `${s} missing:\n${r.out}`));
  });

  it('allows --debug without --debugKey on loopback, and --debug with --debugKey anywhere', async () => {
    assert.strictEqual((await run(['--workerThread', '--port', '9662', '--debug'])).listen, '127.0.0.1');
    assert.strictEqual((await run(['--workerThread', '--port', '9662', '--debug', '--debugKey', 'k', '--bindAddr', '0.0.0.0'])).listen, '0.0.0.0');
  });

  it('does not parse a text/plain body as JSON', async () => {
    server = await startServer(9663, ['--workerThread', '--debug', '--debugKey', 'k']);
    const rpc = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}});
    const asJson = await post(9663, 'application/json', rpc);
    assert.ok(/"tools"/.test(asJson.text), asJson.text.slice(0, 300));
    const asText = await post(9663, 'text/plain', rpc);
    assert.ok(!/"tools"/.test(asText.text), `text/plain was handled as JSON: ${asText.text.slice(0, 300)}`);
  });
});

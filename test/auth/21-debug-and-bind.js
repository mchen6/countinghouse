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

  // A bare --debugKey (a typo, or a value starting with '-') is true to
  // minimist; turned into the key 'true' it would make "X-CH-Key: true" an
  // admin, from the network (review R1-5b). It is refused at startup.
  it('a --debugKey with no value refuses to start', async () => {
    const remote = await run(['--workerThread', '--port', '9662', '--debug', '--debugKey', '--bindAddr', '0.0.0.0']);
    assert.strictEqual(remote.code, 2, remote.out.slice(-1500));
    assert.ok(remote.out.includes('--debugKey needs a value'), remote.out);
    const local = await run(['--workerThread', '--port', '9662', '--debug', '--debugKey']);
    assert.strictEqual(local.code, 2, local.out.slice(-1500));
  });

  // minimist gives `--debugKey 12345` as a number; the key must still match
  // the X-CH-Key header, which is always a string (review).
  it('an all-digit --debugKey works', async () => {
    server = await startServer(9663, ['--workerThread', '--debug', '--debugKey', '12345']);
    // an admin route: answered only for a key that matches --debugKey
    const status = (key) => new Promise((resolve, reject) => {
      const body = Buffer.from('{}');
      const req = require('http').request({host: '127.0.0.1', port: 9663, path: '/get-module-device-list', method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-CH-Key': key, 'Content-Length': body.length}}, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(body);
    });
    // 403 is the auth refusal; past auth the route answers its own way
    assert.strictEqual(await status('wrong'), 403, 'a wrong key must be refused');
    assert.notStrictEqual(await status('12345'), 403, 'the digit key must pass auth');
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

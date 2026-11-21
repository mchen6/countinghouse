// MCP completeness M3, spec section 1: a hop's output is checked as a call's
// is. A part returning a Buffer is refused OUTPUT_NOT_JSON in its own worker,
// on the main-thread-routed path (lib/lean-worker.js) and over a direct peer
// channel (lib/peer-worker.js), and the calling module's ctx.call sees that
// refusal, naming the part and the field.
const assert = require('assert');
const path = require('path');
const request = require('supertest');
const {spawn} = require('child_process');
const {testPort} = require('../helpers/test-env');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function start(port, extra) {
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(port),
      '--authConfigPath', require('../helpers/private-auth').privateAuth(path.join(__dirname, 'fixtures-not-json-auth.json')),
      '--loadModule', path.join(FIXTURES, 'not-json-callee'), '--loadModule', path.join(FIXTURES, 'not-json-caller'), ...extra],
    {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    const timer = setTimeout(() => reject(new Error(`not ready: ${out.slice(-600)}`)), 60000);
    const onData = (b) => {
      out = (out + b).slice(-20000);
      if (/countinghouse ready/.test(out)) { clearTimeout(timer); resolve(server); }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the server exited (${code}): ${out.slice(-600)}`)); });
  });
}

async function viaHop(port) {
  const res = await request(`http://127.0.0.1:${port}`).post('/mcp').set('X-CH-Key', 'not-json-test-key')
    .set('Accept', 'application/json, text/event-stream')
    .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'not_json_caller_hopservice_viahop', arguments: {}}});
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.result.isError, false, JSON.stringify(res.body));
  return res.body.result.structuredContent;
}

for (const [label, port, extra] of [['main-thread routed', testPort(9577), []], ['a direct peer channel', testPort(9578), ['--directPeerChannels']]]) {
  describe(`validation 20: a part's output that is not JSON is refused OUTPUT_NOT_JSON in its worker (${label})`, function() {
    this.timeout(120000);
    let server = null;
    before(async () => { server = await start(port, extra); });
    after(() => {
      if (server != null) { server.removeAllListeners('exit'); server.kill('SIGKILL'); }
    });
    it('the calling module\'s ctx.call sees OUTPUT_NOT_JSON, naming the part and the field', async () => {
      const got = await viaHop(port);
      assert.strictEqual(got.code, 'OUTPUT_NOT_JSON', JSON.stringify(got));
      assert.match(got.message, /not-json-callee\/bytes: .* at \/data,/);
    });
  });
}

// countinghouse_check_balance returns the caller's user name and balance, and
// never its API key: tool output reaches model context, client transcripts
// and logs. A user name equal to the key -- which is what the file provider
// falls back to for an entry without userName -- is returned as null.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const net     = require('net');
const spawn   = require('child_process').spawn;
const request = require('supertest');
const Ajv2020 = require('ajv/dist/2020');
const waitForReady = require('../helpers/wait-for-ready');

const ROOT  = path.join(__dirname, '..', '..');
const ALICE = `k-alice-27-${process.pid}`;
const ANON  = `k-anon-27-${process.pid}`;
const DEBUG_KEY = `k-debug-27-${process.pid}`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
  });
}

async function start(extra) {
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--no-workerThread', '--bindAddr', '127.0.0.1',
    '--port', String(port)].concat(extra), {cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], detached: true});
  server.output = '';
  server.stdout.on('data', (c) => { server.output += c.toString(); });
  await new Promise((resolve, reject) => waitForReady(server, (err) => (err ? reject(err) : resolve())));
  return {port, server};
}

function stop(s) {
  if (s != null && s.server.pid != null) { try { process.kill(-s.server.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
}

function rpc(port, key, method, params) {
  return request(`http://127.0.0.1:${port}`).post('/mcp').set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream').set('X-CH-Key', key)
    .send({jsonrpc: '2.0', id: 1, method, params}).then((res) => ({body: res.body, text: res.text}));
}

const checkBalance = (port, key) => rpc(port, key, 'tools/call', {name: 'countinghouse_check_balance', arguments: {}});

describe('auth 27: check_balance returns userName and balance, never the key', function() {
  this.timeout(120000);

  describe('file auth', () => {
    let tmp, s;
    before(async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-auth-27-'));
      const auth = path.join(tmp, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[ALICE]: {userName: 'alice', devices: []}, [ANON]: {devices: []}}));
      s = await start(['--authProvider', 'file', '--authConfigPath', auth]);
    });
    after(() => { stop(s); fs.rmSync(tmp, {recursive: true, force: true}); });

    it('returns exactly userName and balance, and never the key', async () => {
      const {body, text} = await checkBalance(s.port, ALICE);
      assert.strictEqual(body.result.isError, false, text);
      assert.deepStrictEqual(Object.keys(body.result.structuredContent).sort(), ['balance', 'userName']);
      assert.strictEqual(body.result.structuredContent.userName, 'alice');
      assert.ok(body.result.structuredContent.balance === null || typeof(body.result.structuredContent.balance) === 'number');
      assert.ok(!text.includes(ALICE), text);
    });

    it('returns userName null when the entry has no userName', async () => {
      const {body, text} = await checkBalance(s.port, ANON);
      assert.strictEqual(body.result.isError, false, text);
      assert.strictEqual(body.result.structuredContent.userName, null);
      assert.ok(!text.includes(ANON), text);
    });

    it('conforms to its advertised schema', async () => {
      const list = (await rpc(s.port, ALICE, 'tools/list', {})).body.result.tools;
      const schema = list.find((t) => t.name === 'countinghouse_check_balance').outputSchema;
      const validate = new Ajv2020({allowUnionTypes: true}).compile(schema);
      const {body} = await checkBalance(s.port, ALICE);
      assert.ok(validate(body.result.structuredContent), JSON.stringify(validate.errors));
    });
  });

  describe('--debug', () => {
    let keyless, keyed;
    before(async () => {
      keyless = await start(['--debug']);
      keyed = await start(['--debug', '--debugKey', DEBUG_KEY]);
    });
    after(() => { stop(keyless); stop(keyed); });

    it('returns debug under keyless --debug', async () => {
      const {body, text} = await checkBalance(keyless.port, 'anything-27');
      assert.strictEqual(body.result.structuredContent.userName, 'debug', text);
      assert.ok(!text.includes('anything-27'), text);
    });

    it('returns debug under --debugKey', async () => {
      const {body, text} = await checkBalance(keyed.port, DEBUG_KEY);
      assert.strictEqual(body.result.structuredContent.userName, 'debug', text);
      assert.ok(!text.includes(DEBUG_KEY), text);
    });
  });
});

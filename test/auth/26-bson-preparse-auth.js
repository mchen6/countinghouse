// A BSON body (up to --maxBsonRequestBody, default 64 MB) is read only for a
// caller who may use the device: on invoke-action and add-job the key and the
// device id are known from the headers and the URL, so they are checked
// before the body. They used to be checked after it, which let a client with
// no key make the server buffer 64 MB per request (review R1-1 follow-up).
const assert = require('assert');
const fs     = require('fs');
const http   = require('http');
const BSON   = require('bson');
const {startServer, stopServer} = require('../helpers/sandbox-server');

const PORT       = 9662;
const AUTH_PATH  = `/tmp/countinghouse-test-auth-26-${process.pid}.json`;
const ALICE      = `alice-key-26-${process.pid}`;   // holds the echo device
const BOB        = `bob-key-26-${process.pid}`;     // holds no device
const DEVICE_ID  = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767'; // echo-device-module, deterministic UUID.v5
const SERVICE_ID = 'urn:countinghouse-com:serviceID:echoService';
const BIG        = 2 * 1024 * 1024;                 // over --maxBsonRequestBody 1

// body: a Buffer, or a byte count to stream as filler. Resolves with the
// status, the parsed JSON reply (when there is one) and whether the socket
// was reused; bounded, so a server that never answers fails the test.
function post(route, headers, body, agent) {
  return new Promise((resolve, reject) => {
    const size = Buffer.isBuffer(body) ? body.length : body;
    const req = http.request({host: '127.0.0.1', port: PORT, path: route, method: 'POST', agent: agent,
      headers: Object.assign({'Content-Length': size}, headers)}, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        clearTimeout(timer);
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({status: res.statusCode, body: json, text: text, reusedSocket: req.reusedSocket});
      });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`no answer from ${route} in 20 s`)); }, 20000);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (Buffer.isBuffer(body)) return req.end(body);
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let left = size;
    (function write() {
      while (left > 0) {
        const n = Math.min(left, chunk.length);
        left -= n;
        if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return req.once('drain', write);
      }
      req.end();
    })();
  });
}

const bson = (key) => Object.assign({'Content-Type': 'application/bson'}, key != null ? {'X-CH-Key': key} : {});

function refused(reply, code) {
  assert.strictEqual(reply.status, 500, `${reply.status} ${reply.text}`);
  assert.strictEqual(reply.body && reply.body.code, code, reply.text);
}

describe('auth 26: the caller is checked before a BSON body is read', function() {
  this.timeout(120000);

  describe('file provider', () => {
    let server = null;

    before(async () => {
      fs.writeFileSync(AUTH_PATH, JSON.stringify({
        [ALICE]: {userName: 'alice', devices: [DEVICE_ID]},
        [BOB]:   {userName: 'bob',   devices: []}
      }));
      server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', AUTH_PATH,
        '--maxBsonRequestBody', '1', '--loadModule', './pre-installed-packages/echo-device-module']);
    });

    after(() => {
      stopServer(server);
      try { fs.unlinkSync(AUTH_PATH); } catch (e) { /* already gone */ }
    });

    it('an unknown key is refused on invoke-action, not answered 413', async () => {
      refused(await post(`/devices/${DEVICE_ID}/invoke-action`, bson('nobody'), BIG), 'SYSTEM_ERROR_UNKNOWN_USER');
    });

    it('no key is refused on add-job, not answered 413', async () => {
      refused(await post(`/devices/${DEVICE_ID}/add-job`, bson(null), BIG), 'SYSTEM_ERROR_UNKNOWN_USER');
    });

    it('a key without the device is refused, not answered 413', async () => {
      refused(await post(`/devices/${DEVICE_ID}/invoke-action`, bson(BOB), BIG), 'USER_HAS_NO_DEVICE');
    });

    // express.raw matches the path case-insensitively and by prefix, and
    // reads `application/bson; charset=...` too: the check must cover both.
    it('an upper-case path and a charset parameter are checked too', async () => {
      refused(await post(`/DEVICES/${DEVICE_ID}/INVOKE-ACTION`, bson('nobody'), BIG), 'SYSTEM_ERROR_UNKNOWN_USER');
      refused(await post(`/devices/${DEVICE_ID}/add-job`,
        {'Content-Type': 'application/bson; charset=utf-8', 'X-CH-Key': 'nobody'}, BIG), 'SYSTEM_ERROR_UNKNOWN_USER');
    });

    it('a caller who holds the device still gets 413 over the limit', async () => {
      const reply = await post(`/devices/${DEVICE_ID}/invoke-action`, bson(ALICE), BIG);
      assert.strictEqual(reply.status, 413, reply.text);
      assert.strictEqual(reply.body.code, 'REQUEST_TOO_LARGE');
    });

    it('a caller who holds the device still invokes over BSON', async () => {
      const body = Buffer.from(BSON.serialize({serviceID: SERVICE_ID, actionName: 'echo', input: {foo: [{item1: 'x'}], bar: 'y'}}));
      const reply = await post(`/devices/${DEVICE_ID}/invoke-action`, bson(ALICE), body);
      assert.strictEqual(reply.status, 200, reply.text);
    });

    it('a keep-alive connection keeps working after a refusal', async () => {
      const agent = new http.Agent({keepAlive: true, maxSockets: 1});
      try {
        refused(await post(`/devices/${DEVICE_ID}/invoke-action`, bson('nobody'), BIG, agent), 'SYSTEM_ERROR_UNKNOWN_USER');
        const next = await post(`/devices/${DEVICE_ID}/invoke-action`, bson('nobody'), Buffer.alloc(16), agent);
        refused(next, 'SYSTEM_ERROR_UNKNOWN_USER');
        assert.strictEqual(next.reusedSocket, true, 'the second request opened a new connection');
      } finally {
        agent.destroy();
      }
    });
  });

  describe('--debug with --debugKey', () => {
    let server = null;
    before(async () => {
      server = await startServer(PORT, ['--workerThread', '--debug', '--debugKey', 'debug-26', '--maxBsonRequestBody', '1']);
    });
    after(() => stopServer(server));

    it('a wrong key is refused, not answered 413', async () => {
      refused(await post('/devices/x/invoke-action', bson('not-debug-26'), BIG), 'SYSTEM_ERROR_UNKNOWN_USER');
    });

    it('the right key still gets 413 over the limit', async () => {
      assert.strictEqual((await post('/devices/x/invoke-action', bson('debug-26'), BIG)).status, 413);
    });
  });
});

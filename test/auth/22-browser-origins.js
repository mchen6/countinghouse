// A loopback --debug server is still reachable from the developer's own
// browser (review R1-2a, R1-2b):
// - a form post is a cross-site request with no CORS preflight, and the form
//   parser fed /load-module its path: now nothing parses form bodies;
// - DNS rebinding makes attacker.example resolve to 127.0.0.1, so its page is
//   "same-origin": under --debug without --debugKey a request whose Host is not
//   this loopback server is refused, and /mcp refuses any request whose Origin
//   is not allowed (MCP Streamable HTTP: servers MUST validate Origin);
// - cross-origin access is opt-in, through --allowedOrigins (user decision,
//   2026-11-04); it was every origin.
const assert = require('assert');
const path = require('path');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');

function request(port, route, headers, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body || '');
    const req = require('http').request({host: '127.0.0.1', port: port, path: route, method: 'POST',
      headers: Object.assign({'Content-Length': data.length}, headers)}, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text: text}));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const RPC = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}});
const MCP = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'X-CH-Key': 'k'};

describe('auth 22: browser origins', function() {
  this.timeout(60000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  it('a form post cannot drive /load-module under --debug (R1-2a)', async () => {
    server = await startServer(9665, ['--workerThread', '--debug']);
    const fixture = path.join(ROOT, 'test', 'fixtures', 'handler-map-module');
    await request(9665, '/load-module', {'Content-Type': 'application/x-www-form-urlencoded'},
      `path=${encodeURIComponent(fixture)}&name=handler-map-module&version=1.0.0`);
    const list = await request(9665, '/mcp', MCP, RPC);
    assert.ok(!/handler_map_module/.test(list.text), `the form post loaded the module: ${list.text.slice(0, 300)}`);
  });

  it('under --debug without --debugKey, a Host that is not this loopback server is refused (rebinding)', async () => {
    server = await startServer(9665, ['--workerThread', '--debug']);
    const rebound = await request(9665, '/mcp', Object.assign({Host: 'attacker.example:9665'}, MCP), RPC);
    assert.strictEqual(rebound.status, 403, rebound.text);
    const own = await request(9665, '/mcp', Object.assign({Host: '127.0.0.1:9665'}, MCP), RPC);
    assert.strictEqual(own.status, 200, own.text);
    const named = await request(9665, '/mcp', Object.assign({Host: 'localhost:9665'}, MCP), RPC);
    assert.strictEqual(named.status, 200, named.text);
  });

  it('/mcp refuses an Origin that is not allowed, and serves a request with none', async () => {
    server = await startServer(9665, ['--workerThread', '--debug', '--debugKey', 'k']);
    const evil = await request(9665, '/mcp', Object.assign({Origin: 'http://evil.example'}, MCP), RPC);
    assert.strictEqual(evil.status, 403, evil.text);
    const none = await request(9665, '/mcp', MCP, RPC);
    assert.strictEqual(none.status, 200, none.text);
  });

  it('no CORS headers by default; --allowedOrigins opts an origin in', async () => {
    server = await startServer(9665, ['--workerThread', '--debug', '--debugKey', 'k']);
    const plain = await request(9665, '/mcp', MCP, RPC);
    assert.strictEqual(plain.headers['access-control-allow-origin'], undefined);
    stopServer(server);
    server = await startServer(9665, ['--workerThread', '--debug', '--debugKey', 'k', '--allowedOrigins', 'http://app.example,http://other.example']);
    const listed = await request(9665, '/mcp', Object.assign({Origin: 'http://app.example'}, MCP), RPC);
    assert.strictEqual(listed.status, 200, listed.text);
    assert.strictEqual(listed.headers['access-control-allow-origin'], 'http://app.example');
    const unlisted = await request(9665, '/mcp', Object.assign({Origin: 'http://evil.example'}, MCP), RPC);
    assert.strictEqual(unlisted.status, 403);
  });
});

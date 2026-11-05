// Request bodies are read before any route checks the caller's key, so their
// size is bounded app-wide: JSON, XML and form bodies by --maxRequestBody
// (MB, default 8), BSON bodies only on the two routes that take them
// (invoke-action and add-job) by --maxBsonRequestBody (MB, default 64).
// They were 1 GB everywhere, which let an unauthenticated client exhaust the
// main thread's memory with a few concurrent posts (review R1-1).
const assert = require('assert');
const {startServer, stopServer} = require('../helpers/sandbox-server');

function postRaw(port, route, type, size) {
  return new Promise((resolve, reject) => {
    const req = require('http').request({host: '127.0.0.1', port: port, path: route, method: 'POST',
      headers: {'Content-Type': type, 'Content-Length': size}}, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    // a server that refuses early may close before the whole body is sent
    req.on('error', (e) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? resolve('closed') : reject(e)));
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

describe('auth 20: request body limits', function() {
  this.timeout(120000);
  let server = null;
  afterEach(() => { stopServer(server); server = null; });

  it('refuses a JSON body over --maxRequestBody with 413, before any key is checked', async () => {
    server = await startServer(9661, ['--workerThread', '--maxRequestBody', '1']);
    assert.strictEqual(await postRaw(9661, '/mcp', 'application/json', 2 * 1024 * 1024), 413);
  });

  it('a JSON body under the limit still reaches the route', async () => {
    server = await startServer(9661, ['--workerThread', '--maxRequestBody', '1']);
    const status = await postRaw(9661, '/mcp', 'application/json', 512 * 1024);
    assert.notStrictEqual(status, 413);
  });

  it('defaults to 8 MB for JSON', async () => {
    server = await startServer(9661, ['--workerThread']);
    assert.strictEqual(await postRaw(9661, '/mcp', 'application/json', 9 * 1024 * 1024), 413);
  });

  it('parses BSON only on the routes that take it', async () => {
    server = await startServer(9661, ['--workerThread', '--maxBsonRequestBody', '1']);
    // /mcp does not take BSON, so its body is never read: over the BSON limit, yet no 413
    const status = await postRaw(9661, '/mcp', 'application/bson', 2 * 1024 * 1024);
    assert.notStrictEqual(status, 413);
  });

  it('refuses a BSON body over --maxBsonRequestBody with 413 on invoke-action', async () => {
    server = await startServer(9661, ['--workerThread', '--maxBsonRequestBody', '1']);
    assert.strictEqual(await postRaw(9661, '/devices/x/invoke-action', 'application/bson', 2 * 1024 * 1024), 413);
  });
});

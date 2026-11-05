// JSON and XML bodies are read before any route checks the caller's key, so
// their size is bounded app-wide by --maxRequestBody (MB, default 8). BSON
// bodies are read only on the two routes that take them (invoke-action and
// add-job), only for a caller who passes the key check (auth 26), and are
// bounded by --maxBsonRequestBody (MB, default 64). They were 1 GB
// everywhere, which let an unauthenticated client exhaust the main thread's
// memory with a few concurrent posts (review R1-1). The BSON cases run under
// keyless --debug, which admits every caller, so the body is read.
const assert = require('assert');
const {startServer, stopServer} = require('../helpers/sandbox-server');

function postRaw(port, route, type, size, full) {
  return new Promise((resolve, reject) => {
    const req = require('http').request({host: '127.0.0.1', port: port, path: route, method: 'POST',
      headers: {'Content-Type': type, 'Content-Length': size}}, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve(full ? {status: res.statusCode, type: String(res.headers['content-type']), text: text} : res.statusCode));
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

  it('the XML parser and add-job\'s BSON parser are bounded too (review)', async () => {
    server = await startServer(9661, ['--workerThread', '--debug', '--maxRequestBody', '1', '--maxBsonRequestBody', '1']);
    assert.strictEqual(await postRaw(9661, '/mcp', 'application/xml', 2 * 1024 * 1024), 413);
    assert.strictEqual(await postRaw(9661, '/devices/x/add-job', 'application/bson', 2 * 1024 * 1024), 413);
  });

  // Express's default error page is HTML and, with NODE_ENV unset, carries
  // the stack trace; anyone can now provoke a 413 or a 400 (review R1-1).
  it('a refused body is answered in JSON, without a stack trace', async () => {
    server = await startServer(9661, ['--workerThread', '--maxRequestBody', '1']);
    const big = await postRaw(9661, '/mcp', 'application/json', 2 * 1024 * 1024, true);
    assert.strictEqual(big.status, 413);
    assert.ok(/application\/json/.test(big.type), big.type);
    assert.strictEqual(JSON.parse(big.text).code, 'REQUEST_TOO_LARGE', big.text);
    assert.ok(!/\bat \S+ \(/.test(big.text) && !/node_modules/.test(big.text), `a stack: ${big.text}`);
    const bad = await new Promise((resolve, reject) => {
      const req = require('http').request({host: '127.0.0.1', port: 9661, path: '/mcp', method: 'POST',
        headers: {'Content-Type': 'application/json'}}, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({status: res.statusCode, text: text}));
      });
      req.on('error', reject);
      req.end('{"not json');
    });
    assert.strictEqual(bad.status, 400, bad.text);
    assert.ok(!/node_modules|\bat \S+ \(/.test(bad.text), `a stack: ${bad.text}`);
    assert.strictEqual(JSON.parse(bad.text).code, 'REQUEST_INVALID');
  });

  it('refuses a BSON body over --maxBsonRequestBody with 413 on invoke-action', async () => {
    server = await startServer(9661, ['--workerThread', '--debug', '--maxBsonRequestBody', '1']);
    assert.strictEqual(await postRaw(9661, '/devices/x/invoke-action', 'application/bson', 2 * 1024 * 1024), 413);
  });
});

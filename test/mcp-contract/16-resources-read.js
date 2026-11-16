// MCP completeness M6, spec section 2, end to end: stored results read back
// with resources/read. A read is served only to the caller who owns the
// result (its opaque id) in its session; an unknown, expired, malformed or
// foreign URI is answered alike, -32602 "Resource not found". text/* that is
// valid UTF-8 comes back as text, anything else as blob; the answer carries
// ttlMs and cacheScope "private". The server advertises resources: {} with
// empty resources/list and resources/templates/list. A composite's result is
// its outer caller's: the part's runsModules identity reads nothing. Past a
// store limit the call is refused, RESULT_STORE_FULL, and nothing it stored
// is left.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {testPort} = require('../helpers/test-env');

const ROOT = path.join(__dirname, '..', '..');
const FX = path.join(ROOT, 'test', 'fixtures');
const MODULES = ['mcp-conformance-module', 'm6-part', 'm6-outer'];
const KEY = 'm6-reader-key';
const OTHER = 'm6-other-key';
const INTERNAL = 'm6-outer-internal-key';
const SHAPE = 'mcp_conformance_shapeservice_';
const PART = 'm6_part_partservice_';
const OUTER = 'm6_outer_outerservice_';
const STORED = /^countinghouse:\/\/r\/[A-Za-z0-9_-]{43}$/;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-m6-'));
  fs.writeFileSync(path.join(h, 'auth.json'), JSON.stringify({
    [KEY]: {userName: 'm6-reader', devices: ['*']},
    [OTHER]: {userName: 'm6-other', devices: ['*']},
    [INTERNAL]: {userName: 'm6-outer-internal', devices: ['*'], runsModules: ['m6-outer']}
  }));
  return h;
}

async function startServer(port, h, extra = []) {
  const server = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--bindAddr', '127.0.0.1', '--port', String(port), '--workerThread',
    '--store', 'local', '--storePath', path.join(h, 'store'), '--authProvider', 'file', '--authConfigPath', path.join(h, 'auth.json'),
    '--moduleDataPath', path.join(h, 'module_data'), ...MODULES.flatMap((m) => ['--loadModule', path.join(FX, m)]), ...extra],
  {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '';
  server.stdout.on('data', (d) => { out = (out + d).slice(-20000); });
  server.stderr.on('data', (d) => { out = (out + d).slice(-20000); });
  for (let w = 0; !/countinghouse ready/.test(out); w += 100) {
    if (w > 60000 || server.exitCode != null) throw new Error(`not ready: ${out.slice(-800)}`);
    await tick(100);
  }
  return server;
}

function rpc(port, method, params, key = KEY, extraHeaders = {}) {
  const payload = JSON.stringify({jsonrpc: '2.0', id: 1, method, params});
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-CH-Key': key, 'Content-Length': Buffer.byteLength(payload), ...extraHeaders}}, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('mcp-contract 16: stored results, read back (M6)', function() {
  this.timeout(120000);
  const PORT = testPort(9583);
  let h;
  let server;
  before(async () => {
    h = home();
    server = await startServer(PORT, h);
  });
  after(async () => {
    if (server != null) {
      server.kill('SIGKILL');
      await new Promise((r) => (server.exitCode != null || server.signalCode != null ? r() : server.once('exit', r)));
    }
    if (h != null) fs.rmSync(h, {recursive: true, force: true});
  });

  const call = async (name, key = KEY) => {
    const r = await rpc(PORT, 'tools/call', {name, arguments: {}}, key);
    assert.ok(r.result != null && r.result.isError === false, JSON.stringify(r).slice(0, 400));
    return r.result;
  };
  const read = (uri, key = KEY) => rpc(PORT, 'resources/read', {uri}, key);
  const notFound = (r, why) => {
    assert.deepStrictEqual(r.error, {code: -32602, message: 'Resource not found'}, `${why}: ${JSON.stringify(r)}`);
    assert.strictEqual(r.result, undefined, why);
  };

  it('advertises resources, with an empty list and no templates', async () => {
    const init = await rpc(PORT, 'initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '1'}});
    assert.deepStrictEqual(init.result.capabilities.resources, {});
    const list = await rpc(PORT, 'resources/list', {});
    assert.deepStrictEqual(list.result.resources, []);
    assert.strictEqual(list.result.cacheScope, 'private');
    const templates = await rpc(PORT, 'resources/templates/list', {});
    assert.deepStrictEqual(templates.result.resourceTemplates, []);
  });

  it('a linked image is read back whole, by its owner: blob, ttlMs within the retention, cacheScope private', async () => {
    const r = await call(`${SHAPE}big_image_out`);
    const {uri} = r.structuredContent.img;
    assert.match(uri, STORED);
    const got = await read(uri);
    assert.strictEqual(got.result.contents.length, 1);
    const [c] = got.result.contents;
    assert.deepStrictEqual([c.uri, c.mimeType, c.text], [uri, 'image/png', undefined]);
    assert.strictEqual(Buffer.from(c.blob, 'base64').length, 2 * 1024 * 1024);
    assert.ok(got.result.ttlMs > 23 * 3600 * 1000 && got.result.ttlMs <= 24 * 3600 * 1000, String(got.result.ttlMs));
    assert.strictEqual(got.result.cacheScope, 'private');
  });

  it('an inline resource block\'s uri reads the same bytes', async () => {
    const r = await call(`${PART}pdf`);
    const block = r.content.find((b) => b.type === 'resource');
    const got = await read(block.resource.uri);
    assert.strictEqual(Buffer.from(got.result.contents[0].blob, 'base64').toString(), '%PDF-1.7 m6');
    assert.strictEqual(got.result.contents[0].mimeType, 'application/pdf');
  });

  it('text/* that is valid UTF-8 comes back as text; any other bytes as blob', async () => {
    const note = await call(`${PART}note`);
    const got = await read(note.structuredContent.note.uri);
    assert.deepStrictEqual(got.result.contents[0], {uri: note.structuredContent.note.uri, mimeType: 'text/plain', text: 'hello, world\n'});
    const bad = await call(`${PART}badtext`);
    const raw = await read(bad.structuredContent.note.uri);
    assert.strictEqual(raw.result.contents[0].text, undefined);
    assert.deepStrictEqual([...Buffer.from(raw.result.contents[0].blob, 'base64')], [0xff, 0xfe, 0x41]);
  });

  it('a media type with parameters is stored as declared and read back by its type (text/plain; charset=utf-8 as text)', async () => {
    const r = await call(`${PART}charsetnote`);
    const {uri} = r.structuredContent.note;
    assert.match(uri, STORED);
    assert.deepStrictEqual((await read(uri)).result.contents[0], {uri, mimeType: 'text/plain; charset=utf-8', text: 'caf\u00e9\n'});
  });

  it('another key, an unknown id, a malformed or a foreign URI: all answered alike, Resource not found', async () => {
    const r = await call(`${PART}pdf`);
    const {uri} = r.structuredContent.doc;
    notFound(await read(uri, OTHER), 'another owner');
    notFound(await read(`countinghouse://r/${crypto.randomBytes(32).toString('base64url')}`), 'an unknown id');
    for (const bad of ['countinghouse://r/short', 'countinghouse://r/', 'countinghouse://m/x', 'file:///etc/passwd', `${uri}/..`, 42, null]) {
      notFound(await read(bad), `malformed: ${JSON.stringify(bad)}`);
    }
    assert.ok((await read(uri)).result != null, 'its owner still reads it');
  });

  // the owner is the resolved caller (session.appKey), never another key the
  // request carries: a regression guard (the two are equal on every path
  // today, so it could not fail before the fix)
  it('the owner is the caller the call was authenticated as, whatever other key the request carries', async () => {
    const r = await rpc(PORT, 'tools/call', {name: `${PART}pdf`, arguments: {apiKey: OTHER, key: OTHER}}, KEY, {Authorization: `Bearer ${OTHER}`});
    assert.ok(r.result != null && r.result.isError === false, JSON.stringify(r).slice(0, 300));
    const {uri} = r.result.structuredContent.doc;
    assert.ok((await read(uri)).result != null, 'the authenticated caller reads it');
    notFound(await read(uri, OTHER), 'the other key in the request');
    notFound(await rpc(PORT, 'resources/read', {uri}, OTHER, {Authorization: `Bearer ${KEY}`}), 'the other key, with the owner\'s as a bearer token');
  });

  it('a composite\'s result is its outer caller\'s: the part\'s runsModules identity reads nothing', async () => {
    const r = await call(`${OUTER}wrap`);
    const {uri} = r.structuredContent.doc;
    assert.match(uri, STORED);
    assert.strictEqual(Buffer.from((await read(uri)).result.contents[0].blob, 'base64').toString(), '%PDF-1.7 m6');
    notFound(await read(uri, INTERNAL), 'the part\'s identity');
  });

  describe('past a store limit', () => {
    const SMALL = testPort(9585);
    let h2;
    let small;
    before(async () => {
      h2 = home();
      small = await startServer(SMALL, h2, ['--resourceQuotaItems', '1']);
    });
    after(async () => {
      if (small != null) {
        small.kill('SIGKILL');
        await new Promise((r) => (small.exitCode != null || small.signalCode != null ? r() : small.once('exit', r)));
      }
      if (h2 != null) fs.rmSync(h2, {recursive: true, force: true});
    });

    it('the call is refused, RESULT_STORE_FULL naming the limit, and nothing it stored is left', async () => {
      const refused = await rpc(SMALL, 'tools/call', {name: `${PART}two`, arguments: {}});
      assert.strictEqual(refused.result.isError, true, JSON.stringify(refused).slice(0, 300));
      assert.strictEqual(refused.result._meta['countinghouse/code'], 'RESULT_STORE_FULL');
      assert.match(refused.result.content[0].text, /resourceQuotaItems/);
      // the one item it stored before the limit was removed, so one fits now
      const one = await rpc(SMALL, 'tools/call', {name: `${PART}pdf`, arguments: {}});
      assert.strictEqual(one.result.isError, false, JSON.stringify(one).slice(0, 300));
    });
  });
});

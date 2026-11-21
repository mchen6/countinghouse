'use strict';
// MCP completeness M8 (spec section 3), over HTTP (an SSE listen on a POST):
// notifications/resources/updated goes only to the calling key's
// subscriptions (a module that keeps data per caller must not tell one tenant
// that another was active), and every entry path that records a call
// announces it: here invoke-action, whose call is recorded by the session
// that serves it.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall, post} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {deviceIDForName} = require('../../lib/call-address');

const PORT = testPort(9761);
const NOTES = path.join(ROOT, 'test', 'fixtures', 'notes-notices');
const A = 'resource-notices-key-a';
const B = 'resource-notices-key-b';
const V = '2026-07-28';
const META = {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {}};
const URI = 'countinghouse://m/notes_notices/notes/a';
const SUB = 'io.modelcontextprotocol/subscriptionId';

// a listen as key's: resolves once the stream starts, its events kept as
// they arrive (each SSE data line, parsed)
const listen = (key, id, notifications) => new Promise((resolve, reject) => {
  const data = JSON.stringify({jsonrpc: '2.0', id, method: 'subscriptions/listen', params: {_meta: META, notifications}});
  const req = http.request({host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST',
    headers: {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data),
      'MCP-Protocol-Version': V, 'Mcp-Method': 'subscriptions/listen', 'X-CH-Key': key}}, (res) => {
    const out = {res, req, events: [], raw: ''};
    res.setEncoding('utf8');
    res.on('data', (c) => {
      out.raw += c;
      let i;
      while ((i = out.raw.indexOf('\n\n')) >= 0) {
        const block = out.raw.slice(0, i);
        out.raw = out.raw.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line != null) out.events.push(JSON.parse(line.slice(6)));
      }
    });
    resolve(out);
  });
  req.on('error', reject);
  req.end(data);
});
const until = async(test, ms = 10000) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return test();
};
const quiet = () => new Promise((r) => setTimeout(r, 800));
const updates = (s) => s.events.filter((m) => m.method === 'notifications/resources/updated').map((m) => [m.params.uri, m.params._meta[SUB]]);

describe('mcp-contract 32: resources/updated over HTTP: the calling key\'s only, from every entry path (M8)', function() {
  this.timeout(120000);
  let base = null;
  let server = null;
  const streams = [];
  before(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-32-'));
    const auth = path.join(base, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[A]: {userName: 'a', devices: ['*']}, [B]: {userName: 'b', devices: ['*']}}), {mode: 0o600});
    server = await startServer(PORT, ['--workerThread', '--authConfigPath', auth, '--moduleDataPath', path.join(base, 'store'), '--loadModule', NOTES]);
  });
  after(() => {
    for (const s of streams) s.req.destroy();
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('another key\'s save says nothing to this key\'s subscription; this key\'s invoke-action, and its tools/call, are announced', async () => {
    const a = await listen(A, 7, {resourceSubscriptions: [URI]});
    streams.push(a);
    assert.strictEqual(a.res.statusCode, 200);
    assert.ok(await until(() => a.events.some((m) => m.method === 'notifications/subscriptions/acknowledged')), JSON.stringify(a.events));
    assert.deepStrictEqual(a.events[0].params.notifications, {resourceSubscriptions: [URI]});

    // key B saves the same note: A's subscription hears nothing
    const byB = await mcpCall(PORT, B, 'notes_notices_notesservice_save', {id: 'a', text: 'by B'});
    assert.ok(byB.isError !== true, JSON.stringify(byB));
    await quiet();
    assert.deepStrictEqual(updates(a), [], 'another key\'s call was announced');

    // key A, by invoke-action (recorded by its session, lib/session.js)
    const saved = await post(PORT, A, `/devices/${deviceIDForName('notes-notices')}/invoke-action`,
      {serviceID: 'urn:countinghouse-test:serviceID:notesService', actionName: 'save', input: {id: 'a', text: 'by A, routed'}});
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.ok(await until(() => updates(a).length === 1), JSON.stringify(a.events));
    assert.deepStrictEqual(updates(a), [[URI, 7]]);

    // and by tools/call
    const byA = await mcpCall(PORT, A, 'notes_notices_notesservice_save', {id: 'a', text: 'by A'});
    assert.ok(byA.isError !== true, JSON.stringify(byA));
    assert.ok(await until(() => updates(a).length === 2), JSON.stringify(a.events));
  });
});

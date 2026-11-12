// lib/mcp/stdio.js: the --stdio route layer over the gateway's handle()
// (local-mode spec §2). Newline-delimited JSON-RPC on the input stream, one
// response line each on the output stream, batches as the HTTP layer answers
// them, notifications answered with nothing, and an end of input that drains
// the calls in flight before it resolves. Tested over in-memory streams with a
// fake handle, so no server and no Redis are needed.
const assert = require('assert');
const {PassThrough} = require('stream');
const {serveStdio} = require('../../lib/mcp/stdio');

// A fake gateway: echoes, answers notifications with null, can be slowed or fail.
function fakeHandle(calls) {
  return (message, appKey, cb) => {
    calls.push({message, appKey});
    if (message == null || message.jsonrpc !== '2.0') return cb(null, {jsonrpc: '2.0', id: message && message.id, error: {code: -32600, message: 'invalid JSON-RPC 2.0 request'}});
    if (message.id === undefined) return cb(null, null);
    if (message.method === 'boom') return cb(new Error('it broke'));
    const delay = message.params && message.params.delayMs ? message.params.delayMs : 0;
    setTimeout(() => cb(null, {jsonrpc: '2.0', id: message.id, result: {method: message.method}}), delay);
  };
}

function harness({drainMs = 2000, appKey = 'k'} = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const calls = [];
  let text = '';
  output.on('data', (d) => { text += d; });
  const served = serveStdio({input, output, handle: fakeHandle(calls), appKey, drainMs});
  return {
    input, calls, served,
    lines: () => text.split('\n').filter((l) => l !== ''),
    json: () => text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)),
    raw: () => text
  };
}
const send = (h, obj) => h.input.write(`${JSON.stringify(obj)  }\n`);
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const req = (id, method, params) => ({jsonrpc: '2.0', id, method, ...(params ? {params} : {})});

describe('--stdio route layer', () => {
  it('answers a request with one line holding its id', async () => {
    const h = harness();
    send(h, req(1, 'initialize'));
    await settle();
    assert.deepStrictEqual(h.json(), [{jsonrpc: '2.0', id: 1, result: {method: 'initialize'}}]);
    assert.ok(h.raw().endsWith('\n'));
    assert.strictEqual(h.calls[0].appKey, 'k', 'the process key is passed to handle');
    h.input.end();
    assert.strictEqual(await h.served.done, 0);
  });

  it('answers a batch as the HTTP layer does: in order, notifications dropped', async () => {
    const h = harness();
    h.input.write(`${JSON.stringify([req(1, 'tools/list'), {jsonrpc: '2.0', method: 'notifications/initialized'}, req(2, 'ping')])  }\n`);
    await settle();
    assert.deepStrictEqual(h.json(), [[{jsonrpc: '2.0', id: 1, result: {method: 'tools/list'}}, {jsonrpc: '2.0', id: 2, result: {method: 'ping'}}]]);
    h.input.end();
    await h.served.done;
  });

  it('a notification, or a batch of only notifications, gets no line', async () => {
    const h = harness();
    send(h, {jsonrpc: '2.0', method: 'notifications/initialized'});
    h.input.write(`${JSON.stringify([{jsonrpc: '2.0', method: 'notifications/cancelled'}])  }\n`);
    await settle();
    assert.strictEqual(h.raw(), '');
    assert.strictEqual(h.calls.length, 2);
    h.input.end();
    await h.served.done;
  });

  it('an empty batch is an invalid request', async () => {
    const h = harness();
    h.input.write('[]\n');
    await settle();
    assert.deepStrictEqual(h.json(), [{jsonrpc: '2.0', id: null, error: {code: -32600, message: 'invalid JSON-RPC 2.0 request: an empty batch'}}]);
    h.input.end();
    await h.served.done;
  });

  it('a line that is not JSON gets the parse error with id null, and the next line is still served', async () => {
    const h = harness();
    h.input.write('{not json\n');
    send(h, req(7, 'ping'));
    await settle();
    const [first, second] = h.json();
    assert.deepStrictEqual(first, {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'parse error: the line is not JSON'}});
    assert.deepStrictEqual(second, {jsonrpc: '2.0', id: 7, result: {method: 'ping'}});
    h.input.end();
    await h.served.done;
  });

  it('blank lines are ignored, a line split across chunks is joined, and CRLF endings are read', async () => {
    const h = harness();
    const line = JSON.stringify(req(3, 'tools/list'));
    h.input.write('\n\r\n');
    h.input.write(line.slice(0, 10));
    await settle(5);
    h.input.write(`${line.slice(10)  }\r\n`);
    await settle();
    assert.deepStrictEqual(h.json(), [{jsonrpc: '2.0', id: 3, result: {method: 'tools/list'}}]);
    h.input.end();
    await h.served.done;
  });

  it('calls run concurrently: a fast answer is not held behind a slow one, and lines never interleave', async () => {
    const h = harness();
    send(h, req(1, 'tools/call', {delayMs: 80}));
    send(h, req(2, 'ping'));
    await settle(150);
    assert.deepStrictEqual(h.json().map((r) => r.id), [2, 1]);
    assert.ok(h.lines().every((l) => { JSON.parse(l); return true; }));
    h.input.end();
    await h.served.done;
  });

  it('a handle that fails answers the internal error for that id', async () => {
    const h = harness();
    send(h, req(9, 'boom'));
    await settle();
    assert.deepStrictEqual(h.json(), [{jsonrpc: '2.0', id: 9, error: {code: -32603, message: 'internal error'}}]);
    h.input.end();
    await h.served.done;
  });

  it('the end of input drains the calls in flight, then resolves 0', async () => {
    const h = harness();
    send(h, req(1, 'tools/call', {delayMs: 60}));
    h.input.end();
    assert.strictEqual(await h.served.done, 0);
    assert.deepStrictEqual(h.json().map((r) => r.id), [1], 'the slow call was answered before the end');
  });

  it('a drain that runs past its bound resolves 1 without waiting for the call', async () => {
    const h = harness({drainMs: 30});
    send(h, req(1, 'tools/call', {delayMs: 500}));
    h.input.end();
    const started = Date.now();
    assert.strictEqual(await h.served.done, 1);
    assert.ok(Date.now() - started < 400);
    assert.strictEqual(h.raw(), '');
  });

  it('lines read after the end of input are not served', async () => {
    const h = harness();
    h.input.end(`${JSON.stringify(req(1, 'ping'))  }\n`);
    assert.strictEqual(await h.served.done, 0);
    assert.deepStrictEqual(h.json().map((r) => r.id), [1], 'the last line before the end is served');
  });
});

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
    // Like lib/mcp/gateway.js: only notifications/initialized is silent; any other
    // notification gets 'method not found' with no id.
    if (message.id === undefined) return cb(null, message.method === 'notifications/initialized' ? null : {jsonrpc: '2.0', id: null, error: {code: -32601, message: `method not found: ${message.method}`}});
    if (message.method === 'boom') return cb(new Error('it broke'));
    // an answer of params.bytes characters (F3-3's answer bound)
    if (message.method === 'big') return cb(null, {jsonrpc: '2.0', id: message.id, result: {pad: 'x'.repeat(message.params.bytes)}});
    const delay = message.params && message.params.delayMs ? message.params.delayMs : 0;
    setTimeout(() => cb(null, {jsonrpc: '2.0', id: message.id, result: {method: message.method}}), delay);
  };
}

function harness({drainMs = 2000, appKey = 'k', maxLineBytes} = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const calls = [];
  let text = '';
  output.on('data', (d) => { text += d; });
  const served = serveStdio({input, output, handle: fakeHandle(calls), appKey, drainMs, maxLineBytes});
  return {
    input, output, calls, served,
    lines: () => text.split('\n').filter((l) => l !== ''),
    json: () => text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)),
    raw: () => text
  };
}
const send = (h, obj) => h.input.write(`${JSON.stringify(obj)  }\n`);
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
// until the output holds `count` lines, polled for up to `ms` (a slow runner's answer, not a fixed wait)
const lines = async (h, count, ms = 10000) => {
  const end = Date.now() + ms;
  while (h.lines().length < count && Date.now() < end) await settle(20);
  assert.ok(h.lines().length >= count, `${count} line(s) expected within ${ms} ms: ${h.raw().slice(0, 300)}`);
  return h.json();
};
const req = (id, method, params) => ({jsonrpc: '2.0', id, method, ...(params ? {params} : {})});

describe('--stdio route layer', function() {
  // (an answer is waited for up to 10 s on a slow runner: lines())
  this.timeout(20000);
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

  it('a subscriptions/listen inside a batch is refused, never dispatched, and the rest is served (#231)', async () => {
    const h = harness();
    h.input.write(`${JSON.stringify([req(1, 'tools/list'), req(2, 'subscriptions/listen', {notifications: {toolsListChanged: true}})])}\n`);
    await settle();
    assert.deepStrictEqual(h.calls.map((c) => c.message.method), ['tools/list']);
    assert.deepStrictEqual(h.json(), [[{jsonrpc: '2.0', id: 1, result: {method: 'tools/list'}},
      {jsonrpc: '2.0', id: 2, error: {code: -32600, message: 'invalid JSON-RPC 2.0 request: subscriptions/listen is sent alone, never in a batch'}}]]);
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

  // F3-3 (the Fable pass over the MCP surface): a batch is bounded, in length and in its answers' bytes
  it('a batch of more than 32 messages is refused whole, and none of it runs; 32 are served', async () => {
    const h = harness();
    h.input.write(`${JSON.stringify(Array.from({length: 33}, (_, i) => req(i + 1, 'ping')))}\n`);
    assert.deepStrictEqual(await lines(h, 1), [{jsonrpc: '2.0', id: null, error: {code: -32600, message: 'invalid JSON-RPC 2.0 request: a batch of 33 messages; at most 32 are taken (send them in smaller batches, or one at a time)'}}]);
    assert.strictEqual(h.calls.length, 0, 'none of it ran');
    h.input.write(`${JSON.stringify(Array.from({length: 32}, (_, i) => req(i + 1, 'ping')))}\n`);
    assert.strictEqual((await lines(h, 2))[1].length, 32);
    h.input.end();
    await h.served.done;
  });

  it('a batch whose answers pass 8 MiB: the answer that took it past is kept (it ran), and no later one runs', async () => {
    const h = harness({maxLineBytes: 16 * 1024 * 1024});
    const MiB = 1024 * 1024;
    h.input.write(`${JSON.stringify([req(1, 'big', {bytes: 3 * MiB}), req(2, 'big', {bytes: 3 * MiB}), req(3, 'big', {bytes: 3 * MiB}),
      req(4, 'ping'), {jsonrpc: '2.0', method: 'notifications/initialized'}, {jsonrpc: '2.0', id: 6, method: 'notifications/initialized'}])}\n`);
    const [answers] = await lines(h, 1);
    assert.deepStrictEqual(answers.map((a) => a.id), [1, 2, 3, 4], 'one answer per request; neither notification, with an id or not, gets one');
    assert.ok(answers[0].result != null && answers[1].result != null && answers[2].result != null, 'the third ran, and its answer is kept');
    assert.deepStrictEqual(answers[3].error, {code: -32603, message: 'not run: the batch\'s answers passed 8388608 bytes before it; send it alone'});
    assert.deepStrictEqual(h.calls.map((c) => c.message.method), ['big', 'big', 'big'], 'the ping and the notifications never ran');
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

  it('a notification the server sends while calls are held is a line of its own: every line one message', async () => {
    const h = harness();
    send(h, req(1, 'tools/call', {delayMs: 60}));
    send(h, req(2, 'tools/list', {delayMs: 30}));
    for (let i = 0; i < 5; i++) {
      h.served.notify({jsonrpc: '2.0', method: 'notifications/tools/list_changed'});
      await settle(10);
    }
    await settle(120);
    const all = h.json();
    assert.strictEqual(all.length, 7, h.raw());
    assert.strictEqual(all.filter((m) => m.method === 'notifications/tools/list_changed').length, 5);
    assert.deepStrictEqual(all.filter((m) => m.id != null).map((m) => m.id), [2, 1]);
    assert.ok(h.raw().endsWith('\n') && h.lines().every((l) => { JSON.parse(l); return true; }));
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

  // From /code-review medium on #43.
  it('a notification is never answered, whatever handle returns for it', async () => {
    const h = harness();
    send(h, {jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 1}});
    h.input.write(`${JSON.stringify([{jsonrpc: '2.0', method: 'notifications/roots/list_changed'}, req(4, 'ping')])}\n`);
    await settle();
    assert.deepStrictEqual(h.json(), [[{jsonrpc: '2.0', id: 4, result: {method: 'ping'}}]]);
    h.input.end();
    await h.served.done;
  });

  it('an input that errors or closes without an end still ends the server', async () => {
    for (const how of ['error', 'close']) {
      const h = harness();
      send(h, req(1, 'tools/call', {delayMs: 30}));
      await settle(5);
      if (how === 'error') h.input.emit('error', new Error('EPIPE')); else h.input.emit('close');
      assert.strictEqual(await h.served.done, 0, how);
      assert.deepStrictEqual(h.json().map((r) => r.id), [1], `${how}: the call in flight is still answered`);
    }
  });

  it('an output that fails ends the server: nobody is reading', async () => {
    const h = harness();
    h.output.emit('error', new Error('EPIPE'));
    assert.strictEqual(await h.served.done, 1);
  });

  it('a line longer than the limit is refused, and the next line is served', async () => {
    const h = harness({maxLineBytes: 100});
    h.input.write('x'.repeat(60));
    h.input.write(`${'y'.repeat(60)}\n`);
    send(h, req(5, 'ping'));
    await settle();
    assert.deepStrictEqual(h.json(), [{jsonrpc: '2.0', id: null, error: {code: -32600, message: 'invalid JSON-RPC 2.0 request: the line is longer than 100 bytes'}}, {jsonrpc: '2.0', id: 5, result: {method: 'ping'}}]);
    h.input.end();
    await h.served.done;
  });

  it('done resolves only after the last answer has been written out', async () => {
    const h = harness();
    let flushed = false;
    const write = h.output.write.bind(h.output);
    h.output.write = (chunk, cb) => write(chunk, () => { flushed = true; if (cb) cb(); });
    send(h, req(1, 'tools/call', {delayMs: 20}));
    h.input.end();
    assert.strictEqual(await h.served.done, 0);
    assert.strictEqual(flushed, true);
  });
});

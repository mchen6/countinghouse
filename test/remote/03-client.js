// RC1-min (spec section 4), the main thread's client to one remote MCP
// server: the declared headers and the credential go out, the answer comes
// back exactly as sent, and every transport or protocol failure is a
// runtime code whose message never holds the credential.
const assert = require('assert');
const net    = require('net');
const {parseRemotes} = require('../../lib/remote/declaration');
const {createRemoteClient} = require('../../lib/remote/client');
const {startRemoteServer, BIG} = require('../helpers/remote-mcp-server');

const PORT = 9686;
const REDIRECT_PORT = 9687;
const TOKEN = `ghp_${'A'.repeat(36)}`;
const remote = (port) => parseRemotes({countinghouse: {remotes: [{name: 'probe', transport: 'streamable-http',
  url: `http://127.0.0.1:${port}/mcp`, headers: {'X-MCP-Toolsets': 'actions,repos'}, credential: {env: 'CH_TEST_REMOTE_TOKEN'}}]}},
{debug: true}).remotes[0];
const CREDENTIAL = {header: 'Authorization', value: `Bearer ${TOKEN}`, source: 'CH_TEST_REMOTE_TOKEN'};
const client = (opts) => createRemoteClient(remote(PORT), CREDENTIAL, Object.assign({timeoutMs: 10000, maxBytes: 16 * 1024 * 1024, debug: true}, opts));
const codeOf = (promise) => promise.then(() => 'resolved', (e) => {
  assert.ok(!String(e.message).includes(TOKEN) && !String(e.stack).includes(TOKEN), `the token in: ${e.message}`);
  return e.code;
});

describe('remote 03: the client', function() {
  this.timeout(60000);
  let server = null;
  let c = null;
  beforeEach(async () => { server = await startRemoteServer(PORT, {redirectTo: `http://127.0.0.1:${REDIRECT_PORT}/mcp`}); });
  afterEach(async () => { if (c != null) await c.close(); c = null; await server.close(); });

  it('sends the declared headers and the credential', async () => {
    c = client();
    await c.call('echo_text', {a: 1});
    const last = server.headers[server.headers.length - 1];
    assert.strictEqual(last['x-mcp-toolsets'], 'actions,repos');
    assert.strictEqual(last.authorization, `Bearer ${TOKEN}`);
  });

  it('returns each result exactly as sent', async () => {
    c = client();
    assert.deepStrictEqual(await c.call('echo_text', {a: 1, b: 'x'}), {content: [{type: 'text', text: '{"a":1,"b":"x"}'}]});
    assert.deepStrictEqual(await c.call('structured', {}), {content: [{type: 'text', text: '{"n":3}'}], structuredContent: {n: 3}});
  });

  it('an isError result resolves', async () => {
    c = client();
    const r = await c.call('fails', {});
    assert.strictEqual(r.isError, true);
    assert.ok(r.content[0].text.includes('410'));
  });

  // Review Focus 2: the answer as an event stream.
  it('an SSE answer arrives whole, and an oversized SSE answer is cut off', async () => {
    c = client();
    assert.deepStrictEqual(await c.call('sse_text', {s: 1}), {content: [{type: 'text', text: '{"s":1}'}]});
    const t0 = Date.now();
    assert.strictEqual(await codeOf(c.call('big_sse', {})), 'REMOTE_RESULT_TOO_LARGE');
    assert.ok(Date.now() - t0 < 5000, 'at once, not at the timeout');
  });

  it('a result over maxBytes rejects REMOTE_RESULT_TOO_LARGE', async () => {
    c = client();
    assert.ok(BIG > 16 * 1024 * 1024);
    assert.strictEqual(await codeOf(c.call('big', {})), 'REMOTE_RESULT_TOO_LARGE');
  });

  it('a slow tool rejects REMOTE_TIMEOUT', async () => {
    c = client({timeoutMs: 1000});
    assert.strictEqual(await codeOf(c.call('slow', {})), 'REMOTE_TIMEOUT');
  });

  it('a stopped server rejects REMOTE_UNREACHABLE', async () => {
    await server.close();
    c = client();
    assert.strictEqual(await codeOf(c.call('echo_text', {})), 'REMOTE_UNREACHABLE');
    server = await startRemoteServer(PORT);
  });

  it('401 rejects REMOTE_AUTH_FAILED, naming the variable and not the value', async () => {
    server.setMode('401');
    c = client();
    const e = await c.call('echo_text', {}).then(() => null, (err) => err);
    assert.strictEqual(e.code, 'REMOTE_AUTH_FAILED');
    assert.ok(e.message.includes('CH_TEST_REMOTE_TOKEN'), e.message);
    assert.ok(!e.message.includes(TOKEN));
  });

  it('a garbage body rejects REMOTE_PROTOCOL', async () => {
    server.setMode('garbage');
    c = client();
    assert.strictEqual(await codeOf(c.call('echo_text', {})), 'REMOTE_PROTOCOL');
  });

  it('a redirect rejects REMOTE_UNREACHABLE and the target sees no connection', async () => {
    let reached = 0;
    const target = net.createServer((s) => { reached += 1; s.destroy(); });
    await new Promise((resolve) => target.listen(REDIRECT_PORT, '127.0.0.1', resolve));
    try {
      server.setMode('redirect');
      c = client();
      assert.strictEqual(await codeOf(c.call('echo_text', {})), 'REMOTE_UNREACHABLE');
      assert.strictEqual(reached, 0);
    } finally {
      await new Promise((resolve) => target.close(resolve));
    }
  });

  it('list follows nextCursor', async () => {
    server.setMode('paged');
    c = client();
    const tools = await c.list();
    assert.deepStrictEqual(tools.map((t) => t.name), ['echo_text', 'fails', 'structured', 'big', 'big_sse', 'sse_text', 'slow']);
    assert.ok(tools.every((t) => t.inputSchema != null));
  });

  it('a call after a failed connection connects again', async () => {
    server.setMode('401');
    c = client();
    assert.strictEqual(await codeOf(c.call('echo_text', {})), 'REMOTE_AUTH_FAILED');
    server.setMode('ok');
    assert.deepStrictEqual(await c.call('echo_text', {}), {content: [{type: 'text', text: '{}'}]});
  });

  // Code review of step 2.
  it('an out-of-range status rejects REMOTE_PROTOCOL and the process stays up', async () => {
    server.setMode('600');
    c = client();
    assert.strictEqual(await codeOf(c.call('echo_text', {})), 'REMOTE_PROTOCOL');
  });

  it('a gateway outage is retryable: 502 and 503 are REMOTE_UNREACHABLE, 504 REMOTE_TIMEOUT, 500 REMOTE_PROTOCOL', async () => {
    for (const [status, code] of [['502', 'REMOTE_UNREACHABLE'], ['503', 'REMOTE_UNREACHABLE'], ['504', 'REMOTE_TIMEOUT'], ['500', 'REMOTE_PROTOCOL']]) {
      server.setMode(status);
      c = client();
      assert.strictEqual(await codeOf(c.call('echo_text', {})), code, status);
      await c.close();
    }
  });

  it('the bare token is scrubbed from a message the server wrote', async () => {
    server.setMode('echo400');
    c = client();
    const e = await c.call('echo_text', {}).then(() => null, (err) => err);
    assert.ok(e != null && !e.message.includes(TOKEN), e && e.message);
    assert.ok(e.message.includes('<credential>'), e.message);
  });

  it('a timed-out call leaves no socket open', async () => {
    c = client({timeoutMs: 1000});
    assert.strictEqual(await codeOf(c.call('slow', {})), 'REMOTE_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await c.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(server.open(), 0);
  });

  it('the timeout is one deadline for connecting and calling', async () => {
    server.setMode('slowall');
    c = client({timeoutMs: 1000});
    const t0 = Date.now();
    assert.strictEqual(await codeOf(c.call('echo_text', {})), 'REMOTE_TIMEOUT');
    assert.ok(Date.now() - t0 < 1600, `${Date.now() - t0} ms`);
  });

  it('many calls add no listener that outlives its request', async () => {
    const warnings = [];
    const onWarning = (w) => warnings.push(w.name);
    process.on('warning', onWarning);
    try {
      c = client();
      for (let i = 0; i < 20; i++) await c.call('echo_text', {i: i});
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
    }
    assert.deepStrictEqual(warnings.filter((n) => n === 'MaxListenersExceededWarning'), []);
  });

  it('a lost session is connected again on the next call', async () => {
    c = client();
    await c.call('echo_text', {});
    server.setMode('404');
    assert.strictEqual(await codeOf(c.call('echo_text', {})), 'REMOTE_PROTOCOL');
    server.setMode('ok');
    assert.deepStrictEqual(await c.call('echo_text', {}), {content: [{type: 'text', text: '{}'}]});
  });

  it('a cursor that repeats ends the listing with REMOTE_PROTOCOL', async () => {
    server.setMode('loopcursor');
    c = client();
    assert.strictEqual(await codeOf(c.list()), 'REMOTE_PROTOCOL');
  });

  it('calls without a credential send no Authorization header', async () => {
    c = createRemoteClient(remote(PORT), null, {timeoutMs: 10000, maxBytes: 1024 * 1024, debug: true});
    await c.call('echo_text', {});
    assert.strictEqual(server.headers[server.headers.length - 1].authorization, undefined);
  });
});

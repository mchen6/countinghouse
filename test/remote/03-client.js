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

  // The SDK's transport (1.32.2) follows a 3xx within the same origin only
  // (the exact scheme, host and port; at most 5), its Authorization kept;
  // this fetch returns every 3xx as it is, so nothing else is followed
  // (the security assessment's finding: the docs said "no redirect").
  it('a redirect within the same origin is followed, with the credential', async () => {
    server.setMode('redirect-same');
    c = client();
    await c.call('echo_text', {a: 1});
    const at = server.paths.lastIndexOf('/moved');
    assert.ok(at >= 0, `never followed: ${JSON.stringify(server.paths)}`);
    assert.strictEqual(server.headers[at].authorization, `Bearer ${TOKEN}`);
  });

  it('a redirect to another origin is not followed: REMOTE_UNREACHABLE, and the other host sees no connection', async () => {
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

  // Code review of step 4: a call that reaches a client after close() (a
  // reload while it waited) must not connect it again.
  // (the reviewer's pre-work high on #508, F3: listTools had the SDK compile
  // every outputSchema with Ajv, synchronously on main, with no bound on the
  // tools or their size)
  it('a tool\'s outputSchema is never compiled at listing: one Ajv cannot compile lists all the same', async () => {
    server.listed = [{name: 'odd', inputSchema: {type: 'object'}, outputSchema: {type: 'object', properties: {n: {type: 'no-such-type'}}}}];
    c = client();
    const tools = await c.list();
    assert.deepStrictEqual(tools.map((t) => t.name), ['odd']);
  });

  it('a listing past MAX_TOOLS tools is refused REMOTE_PROTOCOL, naming the cap, at the page that crosses it', async () => {
    const {MAX_TOOLS} = require('../../lib/remote/client');
    assert.ok(Number.isInteger(MAX_TOOLS) && MAX_TOOLS > 0, 'exported');
    server.listed = Array.from({length: MAX_TOOLS + 1}, (_, i) => ({name: `t${i}`, inputSchema: {type: 'object'}}));
    c = client();
    const e = await c.list().then(() => null, (err) => err);
    assert.ok(e != null && e.code === 'REMOTE_PROTOCOL', e && e.message);
    assert.ok(e.message.includes(`more than ${MAX_TOOLS} tools`), e.message);
    // paged, 64 a page: the listing stops at the page that crosses the cap
    server.listed = Array.from({length: MAX_TOOLS + 9}, (_, i) => ({name: `t${i}`, inputSchema: {type: 'object'}}));
    server.pageSize = 64;
    server.setMode('paged');
    server.methods.length = 0;
    const p = await c.list().then(() => null, (err) => err);
    assert.ok(p != null && p.code === 'REMOTE_PROTOCOL' && p.message.includes(`more than ${MAX_TOOLS} tools`), p && p.message);
    const pages = server.methods.filter((m) => m === 'tools/list').length;
    assert.ok(pages === Math.floor(MAX_TOOLS / 64) + 1, `pages asked: ${pages}`);
  });

  it('a listing past MAX_LISTING_CHARS is refused REMOTE_PROTOCOL, naming the budget', async () => {
    const {MAX_LISTING_CHARS} = require('../../lib/remote/client');
    assert.ok(Number.isInteger(MAX_LISTING_CHARS) && MAX_LISTING_CHARS > 0, 'exported');
    const wide = {type: 'object', description: 'd'.repeat(Math.ceil(MAX_LISTING_CHARS / 3))};
    server.listed = [0, 1, 2, 3].map((i) => ({name: `w${i}`, inputSchema: wide}));
    c = client();
    const e = await c.list().then(() => null, (err) => err);
    assert.ok(e != null && e.code === 'REMOTE_PROTOCOL', e && e.message);
    assert.ok(e.message.includes(`more than ${MAX_LISTING_CHARS} characters`), e.message);
  });

  it('a tool without a string name, or a page whose tools are not a list, is REMOTE_PROTOCOL', async () => {
    c = client();
    for (const listed of [[{name: 7, inputSchema: {type: 'object'}}], [{inputSchema: {type: 'object'}}], [{name: 'x', inputSchema: 'no'}]]) {
      server.listed = listed;
      assert.strictEqual(await codeOf(c.list()), 'REMOTE_PROTOCOL', JSON.stringify(listed));
    }
  });

  // (F8: the scrub matched the credential exactly, before the cleaner made
  // whitespace and hidden characters into one space)
  it('the credential is scrubbed however its spaces were echoed: doubled, a tab, a newline, a hidden character', () => {
    const short = ['ab', 'c1', '23'].join('');
    const sc = createRemoteClient(remote(PORT), {header: 'Authorization', value: `Bearer ${short}`, source: 'CH_TEST_REMOTE_TOKEN'}, {debug: true}).scrub;
    const {moduleLine} = require('../../lib/module-text');
    for (const v of [`Bearer  ${short}`, `Bearer\t${short}`, `Bearer\n${short}`, `Bearer\u200b${short}`, `Bearer \u2028 ${short}`, `Bear\u200ber ${short}`, `Bearer ab\u200bc123`, `Bearer ${short}`]) {
      const out = moduleLine(sc(`bad header: ${v} (end)`), 500);
      assert.ok(!out.includes(short) && !out.replace(/ /g, '').includes(`Bearer${short}`), JSON.stringify(out));
      assert.ok(out.includes('<credential>'), JSON.stringify(out));
    }
    assert.strictEqual(sc('nothing secret here'), 'nothing secret here');
  });

  it('a closed client does not connect again', async () => {
    c = client();
    await c.call('echo_text', {});
    await c.close();
    const opened = server.connections();
    assert.strictEqual(await codeOf(c.call('echo_text', {})), 'REMOTE_UNREACHABLE');
    assert.strictEqual(server.connections(), opened, 'no new connection');
    c = null;
  });

  it('calls without a credential send no Authorization header', async () => {
    c = createRemoteClient(remote(PORT), null, {timeoutMs: 10000, maxBytes: 1024 * 1024, debug: true});
    await c.call('echo_text', {});
    assert.strictEqual(server.headers[server.headers.length - 1].authorization, undefined);
  });
});

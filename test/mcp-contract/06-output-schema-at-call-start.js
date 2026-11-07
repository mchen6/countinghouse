// A synchronous tools/call is shaped with the output schema in effect when
// the call started: the one the caller's tools/list advertised, and the one
// the module validated its output against. Shaping it with whatever is
// loaded when the answer arrives broke a call that was answered while its
// module reloaded -- no module loaded at that moment means no schema, so
// the answer went out text-only, and the official SDK client rejects a
// success without structuredContent from a tool that advertised an
// outputSchema ("has an output schema but did not return structured
// content"). tasks/result keeps its own rule (mcp-contract/04): its reader
// may hold a newer tools/list than the task's creator did.
const assert = require('assert');
const path   = require('path');
const {ROOT, startServer, stopServer, post} = require('../helpers/sandbox-server');

const PORT    = 9612;
const KEY     = 'schema-at-call-start-key';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'worker-end');
const BUSY    = 'worker_end_endservice_busy';
const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));

describe('mcp-contract 06: a call is shaped with the output schema in effect when it started', function() {
  this.timeout(60000);
  let server = null;
  let client = null;

  before(async () => {
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--loadModule', FIXTURE]);
    const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
    const {StreamableHTTPClientTransport} = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    client = new Client({name: 'countinghouse-schema-at-call-start-test', version: '0.0.0'});
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`),
      {requestInit: {headers: {'X-CH-Key': KEY}}}));
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some((t) => t.name === BUSY && t.outputSchema != null), 'busy should advertise an outputSchema');
  });

  after(async () => {
    if (client != null) await client.close().catch(() => {});
    stopServer(server);
  });

  it('a call answered while its module reloads still carries structuredContent, and the SDK client accepts it', async () => {
    // busy blocks its worker for 600 ms and then answers; the reload sent
    // meanwhile is handled after the answer, so the answer reaches the main
    // thread while the old worker is being replaced.
    const call = client.callTool({name: BUSY, arguments: {}});
    await sleep(100);
    const reload = post(PORT, KEY, '/load-module', {path: FIXTURE, name: 'worker-end'});
    const result = await call;
    await reload;
    assert.strictEqual(result.isError, false, JSON.stringify(result));
    assert.deepStrictEqual(result.structuredContent, {ok: true});
  });
});

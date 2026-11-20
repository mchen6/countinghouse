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
//
// The reload is POST /load-module of a loaded module: the restart path
// (lib/module-manager.js unloadModuleExternal 'reload'). It marks the
// module's devices ending, posts the worker its unload, and logs that it has
// ("ending its worker (reload)"); it ends the worker when the worker
// acknowledges the unload, or after 3 s. A call already running in the
// worker is answered first; one posted after the unload is answered
// MODULE_RELOADING (retryable): by the worker once it reads it, or, if the
// worker is still held when the 3 s bound ends it, by the main thread's
// drain of what the worker owed. Every step here is ordered by an
// event, never a sleep (#221: a fixed sleep did not order the reload after
// the call once a call's admission on the main thread, its input check in
// the validator pool among it, outlasted the sleep under load):
//   - busy (the fixture) runs in the worker (its marker file) and holds it
//     until the test releases it (its release file);
//   - the reload is posted, and the test waits for its log line.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, post, waitFor} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {dirsFor} = require('../../lib/module-data');

const PORT    = testPort(9612);
const KEY     = 'schema-at-call-start-key';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'reload-marker');
const BUSY    = 'reload_marker_markservice_busy';
const codeOf  = (r) => (r != null && r._meta != null) ? r._meta['countinghouse/code'] : null;
const ENDING  = 'module: reload-marker ending its worker (reload)';

describe('mcp-contract 06: a call is shaped with the output schema in effect when it started', function() {
  this.timeout(60000);
  let server = null;
  let client = null;
  let data = null;
  let marker = null;
  let release = null;

  before(async () => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-06-'));
    const dir = dirsFor(data, 'reload-marker').data;
    marker = path.join(dir, 'started');
    release = path.join(dir, 'release');
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleDataPath', data, '--loadModule', FIXTURE]);
    const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
    const {StreamableHTTPClientTransport} = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    client = new Client({name: 'countinghouse-schema-at-call-start-test', version: '0.0.0'});
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`),
      {requestInit: {headers: {'X-CH-Key': KEY}}}));
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some((t) => t.name === BUSY && t.outputSchema != null), 'busy should advertise an outputSchema');
  });

  after(async () => {
    // whatever a failed case left holding the worker is let go
    if (release != null) { try { fs.writeFileSync(release, '1'); } catch (e) { /* the directory may be gone */ } }
    if (client != null) await client.close().catch(() => {});
    stopServer(server);
    if (data != null) fs.rmSync(data, {recursive: true, force: true});
  });

  const tail = () => `server output, last 2000 characters:\n${server.output.slice(-2000)}`;
  const listed = async () => (await client.listTools()).tools.some((t) => t.name === BUSY);

  // busy runs in the worker and holds it; the reload is posted and has begun
  // (its log line, looked for only in what the server logged after the post)
  async function busyThenReload() {
    fs.rmSync(marker, {force: true});
    fs.rmSync(release, {force: true});
    const running = client.callTool({name: BUSY, arguments: {}});
    running.catch(() => {});
    await waitFor(() => fs.existsSync(marker), 20000, 'busy to start (its marker file)', tail);
    const from = server.output.length;
    const reload = post(PORT, KEY, '/load-module', {path: FIXTURE, name: 'reload-marker'});
    reload.catch(() => {});
    await waitFor(() => server.output.indexOf(ENDING, from) !== -1, 20000, 'the reload to begin (its log line)', tail);
    return {running, reload};
  }

  it('a call answered while its module reloads still carries structuredContent, and the SDK client accepts it', async () => {
    const {running, reload} = await busyThenReload();
    // released only now: busy's answer is shaped while the worker is replaced
    fs.writeFileSync(release, '1');
    const result = await running;
    await reload;
    assert.strictEqual(result.isError, false, JSON.stringify(result));
    assert.deepStrictEqual(result.structuredContent, {ok: true});
  });

  it('a call sent after the reload began, and a call the 3 s bound cuts, both answer MODULE_RELOADING', async () => {
    await waitFor(listed, 20000, 'the reloaded module\'s tool to be listed', tail);
    const {running, reload} = await busyThenReload();
    try {
      // posted after the unload, so queued behind it in the worker; busy is
      // never released, so the reload's 3 s bound ends the worker, and the
      // main thread answers both of what it owed MODULE_RELOADING (the
      // worker's own answer for a call it reads after its unload is not
      // what this case reaches)
      const late = await client.callTool({name: BUSY, arguments: {}});
      assert.strictEqual(late.isError, true, JSON.stringify(late));
      assert.strictEqual(codeOf(late), 'MODULE_RELOADING', JSON.stringify(late));
      const cut = await running;
      assert.strictEqual(cut.isError, true, JSON.stringify(cut));
      assert.strictEqual(codeOf(cut), 'MODULE_RELOADING', JSON.stringify(cut));
    } finally {
      fs.writeFileSync(release, '1');
      await reload.catch(() => {});
    }
    await waitFor(listed, 20000, 'the reloaded module\'s tool to be listed', tail);
  });
});

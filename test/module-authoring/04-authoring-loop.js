// The loop the whole feature exists for: validate a module, load it, and call
// the tool that just appeared -- without the agent's MCP client ever being
// told its tool list changed.
//
// That last part is the point of countinghouse_call_tool. The server is
// already correct (buildToolList recomputes per request), but no
// notifications/tools/list_changed is ever sent, so a client holding a cached
// list would not know to re-ask. The agent calls by name instead.
const assert  = require('assert');
const path    = require('path');
const net     = require('net');
const spawn   = require('child_process').spawn;
const request = require('supertest');

const ROOT    = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'handler-map-convention');
const PORT    = 9552;

// Same technique as test/module-authoring/03-authoring-tools-gating.js's
// assertPortFree -- a stale server left behind by an earlier run would, by
// definition, have been started without --workerThread, so call_tool's
// re-entrant tools/call would silently behave differently.
function assertPortFree(port, callback) {
  let done = false;
  const socket = net.connect({host: '127.0.0.1', port: port});

  function finish(err) {
    if (done) return;
    done = true;
    socket.destroy();
    callback(err);
  }

  socket.setTimeout(2000);
  socket.on('connect', () => {
    finish(new Error(`port ${port} is already in use. A server from an earlier run is still up; ` +
                     `kill it (fuser -k ${port}/tcp) before running this suite.`));
  });
  socket.on('timeout', () => { finish(null); });
  socket.on('error',   () => { finish(null); }); // nothing listening: what we want
}

// try/catch: process.kill throws ESRCH if the server already exited (e.g. an
// earlier assertion in this file failed before `before` even finished), and
// an uncaught throw from `after` masks whatever the real failure was.
function stopServer(server) {
  if (server == null || server.pid == null) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
}

function mcp(method, params, cb) {
  request(`http://127.0.0.1:${PORT}`)
    .post('/mcp')
    .set('X-CH-Key', 'aabbcc')
    .send({jsonrpc: '2.0', id: Date.now(), method: method, params: params})
    .end((err, res) => cb(err, res && res.body));
}

const call = (name, args, cb) => mcp('tools/call', {name: name, arguments: args}, cb);

describe('the authoring loop', function() {
  this.timeout(40000);
  let server = null;

  before((done) => {
    assertPortFree(PORT, (err) => {
      if (err) return done(err);
      server = spawn(path.join(ROOT, 'bin', 'countinghouse'),
                     ['--debug', '--bindAddr', '127.0.0.1', '--port', String(PORT),
                      '--debugKey', 'aabbcc', '--authoringTools', '--workerThread'],
                     {cwd: ROOT, stdio: 'ignore', detached: true});
      setTimeout(done, 8000);
    });
  });
  after(() => { stopServer(server); });

  let loadedToolName = null;

  it('validates the module before loading it', (done) => {
    call('countinghouse_validate_module', {path: FIXTURE}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.structuredContent.ok, true);
      done();
    });
  });

  it('loads it and reports the tool names it made callable', (done) => {
    call('countinghouse_load_module',
         {path: FIXTURE, name: 'handler-map-convention', version: '1.0.0'}, (err, body) => {
      assert.ifError(err);
      const out = body.result.structuredContent;
      assert.strictEqual(out.loaded, true);
      assert.ok(Array.isArray(out.toolNames) && out.toolNames.length > 0,
                'load_module must report the tools it made callable');
      loadedToolName = out.toolNames.find((n) => /hello/.test(n));
      assert.ok(loadedToolName != null, `expected a hello tool, got ${out.toolNames.join(', ')}`);
      done();
    });
  });

  it('calls the freshly loaded tool by name', (done) => {
    call('countinghouse_call_tool',
         {name: loadedToolName, arguments: {name: 'world'}}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, false);
      done();
    });
  });

  it('refuses call_tool for a name that does not exist', (done) => {
    call('countinghouse_call_tool', {name: 'no_such_tool_at_all', arguments: {}}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, true);
      done();
    });
  });
});

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
// 9550-9552 are 03-authoring-tools-gating.js's three servers; this plan's
// reserved range is now 9550-9554 (see the C1 review finding on this task --
// Task 3's fix round added a fourth server to 03 after this file's port was
// first picked, and 9552 collided with it under `npm test`'s single
// mocha invocation of the whole directory).
const PORT    = 9553;

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

  let loadedToolName    = null;
  let predictedToolNames = null;

  // Final-review regression guard: the whole point of countinghouse_
  // validate_plan is that the tool name it predicts is the tool name that
  // actually appears once the module is loaded -- but until now that
  // property was only ever asserted by two separate tests (this file's and
  // 05-validate-plan.js's) happening to hardcode the same literal string,
  // never checked against each other. This plan describes FIXTURE
  // (test/fixtures/handler-map-convention) exactly -- same device
  // friendlyName, same service short name, same action name -- so its
  // predicted toolNames can be compared directly against what load_module
  // reports below for the very same fixture.
  it('validate_plan predicts the exact tool name load_module will report', (done) => {
    const plan = {
      device: 'handler-map-convention',
      services: [{
        name: 'greetService',
        actions: [{name: 'hello', description: 'Returns a greeting.'}]
      }]
    };
    call('countinghouse_validate_plan', plan, (err, body) => {
      assert.ifError(err);
      const out = body.result.structuredContent;
      assert.strictEqual(out.ok, true, `expected the plan to validate cleanly, got: ${JSON.stringify(out)}`);
      predictedToolNames = out.toolNames;
      assert.ok(Array.isArray(predictedToolNames) && predictedToolNames.length > 0);
      done();
    });
  });

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
      assert.strictEqual(out.discoveryComplete, true,
                          'a load that reports tool names must also confirm discovery completed');
      assert.ok(Array.isArray(out.toolNames) && out.toolNames.length > 0,
                'load_module must report the tools it made callable');
      loadedToolName = out.toolNames.find((n) => /hello/.test(n));
      assert.ok(loadedToolName != null, `expected a hello tool, got ${out.toolNames.join(', ')}`);
      assert.deepStrictEqual(out.toolNames.slice().sort(), predictedToolNames.slice().sort(),
        'the tool names load_module actually reports must equal what validate_plan predicted for the ' +
        `same device/service/action, got real=${out.toolNames.join(',')} predicted=${predictedToolNames.join(',')}`);
      done();
    });
  });

  // Regression guard for the C2 review finding: the first implementation
  // diffed the server's whole tool set before/after the load, which is
  // structurally empty on a reload (the tool name was already present in
  // "before" -- it never went away). load_module now reads the module's OWN
  // device list instead, which is correct -- and available instantly,
  // no discovery wait needed -- on every load after the first.
  it('reloads the same module and still reports its tool names', (done) => {
    call('countinghouse_load_module',
         {path: FIXTURE, name: 'handler-map-convention', version: '1.0.0'}, (err, body) => {
      assert.ifError(err);
      const out = body.result.structuredContent;
      assert.strictEqual(out.loaded, true);
      assert.strictEqual(out.discoveryComplete, true);
      assert.ok(Array.isArray(out.toolNames) && out.toolNames.indexOf(loadedToolName) !== -1,
                `reload must still report ${loadedToolName}, got ${out.toolNames.join(', ')}`);
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

  // Regression guard for the I5 review finding: this is the recursion-safety
  // property (call_tool must not be usable to invoke itself, load_module, or
  // validate_module/validate_plan) -- previously only verified by the
  // reviewer reading the code, not by any test.
  it('refuses call_tool for an authoring tool name (no recursion)', (done) => {
    call('countinghouse_call_tool', {name: 'countinghouse_load_module', arguments: {}}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, true,
                          'call_tool must refuse to dispatch to another authoring tool');
      done();
    });
  });

  // Final-review regression guard: unlike its sibling countinghouse_validate_
  // module (bounded by VALIDATE_CHILD_TIMEOUT_MS on a child process),
  // countinghouse_load_module had no bound at all on loadModuleFromPath's own
  // callback. Under --workerThread (this file's server), a module whose main
  // entry calls process.exit() during require() kills only the worker, not
  // the gateway -- but the pending load message to that worker never gets a
  // reply, so the callback simply never fired. Verified live past 100s of
  // hanging before LOAD_MODULE_TIMEOUT_MS (lib/mcp/gateway.js) was added.
  // This must now resolve as a reported failure well inside this test's own
  // timeout, not hang it.
  it('a module whose entry calls process.exit() is reported as a failure, not a hang', function(done) {
    this.timeout(20000);
    const fixture = path.join(ROOT, 'test', 'fixtures', 'handler-map-process-exit');
    call('countinghouse_load_module',
         {path: fixture, name: 'handler-map-process-exit-hang-guard', version: '1.0.0'}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, true,
        `expected a reported failure (LOAD_MODULE_TIMEOUT or similar), got: ${JSON.stringify(body.result)}`);
      done();
    });
  });
});

// The authoring tools are admin-gated AND off unless --authoringTools is
// passed. Default-off is a safety property, not a preference:
// countinghouse_validate_module already does require(callerSuppliedPath)
// unsandboxed in the main gateway process (lib/module-validator.js's
// loadPackage) -- and countinghouse_load_module plus countinghouse_call_tool
// (Tasks 4/5) will only add more of the same. It must not be one flag-flip
// away on a deployment that merely happens to have an admin key configured.
//
// Default-off is also what keeps the golden tools/list surface still --
// test/mcp-contract/capture-tools-list.js never passes the flag -- so the
// first case here is the regression guard for that too.
//
// A disabled/reserved tool must be indistinguishable from one that was never
// registered at all -- not merely "also refuses", but byte-identical apart
// from the tool name in the response. A same-shape-but-different-message
// response, or a resultResponse where an unregistered name gets a JSON-RPC
// errorResponse, is itself an oracle an attacker can use to enumerate which
// of the four reserved names exist on a given instance. Plain
// assert.ok(isError === true) cannot see that difference -- it accepts both
// shapes -- which is why the differential assertions below (sameEnvelope)
// exist: they compare a reserved-but-disabled/unauthorized name's full
// response against a name that was never reserved anywhere, with only the
// name itself scrubbed out first.
const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const net     = require('net');
const spawn   = require('child_process').spawn;
const exec    = require('child_process').exec;
const request = require('supertest');

const ROOT = path.join(__dirname, '..', '..');
const AUTHORING_NAMES = [
  'countinghouse_validate_plan',
  'countinghouse_validate_module',
  'countinghouse_load_module',
  'countinghouse_call_tool'
];
// A name reserved nowhere -- the control every differential assertion below
// compares a reserved name's disabled/unauthorized response against.
const CONTROL_NAME = 'zzz_no_such_tool';

// A stale server left behind by an earlier run on one of these ports would,
// by definition, have been started WITHOUT the flag combination this run
// intends to test -- so every assertion below would pass vacuously against
// the wrong process instead of the one this file just configured. Same
// technique and same reasoning as test/mcp-contract/01-tools-list-unchanged.js's
// assertPortFree, generalized to take a port since this file uses three.
function assertPortFree(port, callback) {
  let done   = false;
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

function startServer(port, extraArgs, done) {
  assertPortFree(port, (err) => {
    if (err) throw err;
    const args = ['--debug', '--bindAddr', '127.0.0.1', '--port', String(port),
                  '--debugKey', 'aabbcc'].concat(extraArgs);
    const server = spawn(path.join(ROOT, 'bin', 'countinghouse'), args,
                         {cwd: ROOT, stdio: 'ignore', detached: true});
    setTimeout(() => done(server), 6000);
  });
}

// try/catch: process.kill throws ESRCH if the server already exited (e.g. an
// earlier assertion in this file failed before `before` even finished), and
// an uncaught throw from `after` masks whatever the real failure was.
function stopServer(server) {
  if (server == null || server.pid == null) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
}

function mcpCall(port, apiKey, body, cb) {
  let req = request(`http://127.0.0.1:${port}`).post('/mcp');
  if (apiKey != null) req = req.set('X-CH-Key', apiKey);
  req.send(body).end((err, res) => cb(err, res && res.body));
}

function toolsList(port, apiKey, cb) {
  mcpCall(port, apiKey, {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}}, (err, body) => {
    cb(err, body && body.result);
  });
}

function toolsCall(port, apiKey, id, name, toolArgs, cb) {
  mcpCall(port, apiKey,
    {jsonrpc: '2.0', id: id, method: 'tools/call', params: {name: name, arguments: toolArgs || {}}}, cb);
}

// True when bodyA (for toolName nameA) and bodyB (for nameB) are the same
// JSON-RPC envelope once each one's own tool name is scrubbed out --
// same error/result shape, same code, same message modulo the name. This is
// what "indistinguishable from unknown" has to mean: not just "also an
// error", but nothing left for a caller to tell the two apart by.
function sameEnvelope(bodyA, nameA, bodyB, nameB) {
  const scrub = (body, name) => JSON.stringify(body).split(name).join('<TOOL_NAME>');
  return scrub(bodyA, nameA) === scrub(bodyB, nameB);
}

describe('authoring tools: absent unless --authoringTools', function() {
  this.timeout(30000);
  let server = null;
  const PORT = 9550;

  before((done) => { startServer(PORT, [], (s) => { server = s; done(); }); });
  after(() => { stopServer(server); });

  it('lists none of the four authoring tools', (done) => {
    toolsList(PORT, 'aabbcc', (err, result) => {
      assert.ifError(err);
      const names = result.tools.map((t) => t.name);
      AUTHORING_NAMES.forEach((n) => {
        assert.ok(names.indexOf(n) === -1, `${n} must not be listed without --authoringTools`);
      });
      done();
    });
  });

  // Regression guard for the C1/C2 finding: a disabled reserved name must
  // produce the exact same JSON-RPC envelope a name that was never reserved
  // at all would produce -- checked for all four reserved names, since
  // reservation (tool-registry.js's AUTHORING_TOOL_NAMES) is load-bearing
  // today even though only one of the four tools has a real implementation.
  AUTHORING_NAMES.forEach((name) => {
    it(`${name}: disabled response is identical (modulo name) to an unregistered tool's`, (done) => {
      toolsCall(PORT, 'aabbcc', 2, name, {path: '.'}, (err, disabledBody) => {
        assert.ifError(err);
        toolsCall(PORT, 'aabbcc', 2, CONTROL_NAME, {}, (err, controlBody) => {
          assert.ifError(err);
          assert.ok(disabledBody.error != null,
            `${name} must be answered as a JSON-RPC error (not a result) while disabled, same as an unknown tool`);
          assert.ok(sameEnvelope(disabledBody, name, controlBody, CONTROL_NAME),
            `disabled ${name} response differs from the unknown-tool control beyond its name:\n` +
            `  disabled: ${JSON.stringify(disabledBody)}\n  control:  ${JSON.stringify(controlBody)}`);
          done();
        });
      });
    });
  });
});

describe('authoring tools: present with --authoringTools', function() {
  this.timeout(30000);
  let server = null;
  const PORT = 9551;

  before((done) => { startServer(PORT, ['--authoringTools'], (s) => { server = s; done(); }); });
  after(() => { stopServer(server); });

  it('lists countinghouse_validate_module', (done) => {
    toolsList(PORT, 'aabbcc', (err, result) => {
      assert.ifError(err);
      const names = result.tools.map((t) => t.name);
      assert.ok(names.indexOf('countinghouse_validate_module') !== -1);
      done();
    });
  });

  it('validates a clean fixture through the tool', (done) => {
    const fixture = path.join(ROOT, 'test', 'fixtures', 'handler-map-convention');
    toolsCall(PORT, 'aabbcc', 3, 'countinghouse_validate_module', {path: fixture}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, false);
      assert.strictEqual(body.result.structuredContent.ok, true);
      done();
    });
  });

  it('returns the full problem list for a broken fixture', (done) => {
    const fixture = path.join(ROOT, 'test', 'fixtures', 'handler-map-unknown-service');
    toolsCall(PORT, 'aabbcc', 4, 'countinghouse_validate_module', {path: fixture}, (err, body) => {
      assert.ifError(err);
      const out = body.result.structuredContent;
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.problems.length, 2);
      done();
    });
  });

  // Regression guard for the I2 finding: with the flag on, a caller whose
  // identity does not even resolve (no key at all -- and --debugKey is set,
  // so a missing key fails doUserAuth's debug branch too, exactly like it
  // would fail AuthProvider.authenticate under real auth) must get the
  // same unknown-tool response an unregistered name gets, not a distinct
  // auth-failure result -- otherwise the response shape is a second oracle
  // for reserved names, one gate past the flag check.
  it('an anonymous caller gets the same unknown-tool response as an unregistered name', (done) => {
    toolsCall(PORT, null, 5, 'countinghouse_validate_module', {path: '.'}, (err, anonBody) => {
      assert.ifError(err);
      toolsCall(PORT, null, 5, CONTROL_NAME, {}, (err, controlBody) => {
        assert.ifError(err);
        assert.ok(anonBody.error != null, 'an unresolvable caller must get a JSON-RPC error, not a result');
        assert.ok(sameEnvelope(anonBody, 'countinghouse_validate_module', controlBody, CONTROL_NAME),
          'anonymous-caller response differs from the unknown-tool control beyond the name:\n' +
          `  anon: ${JSON.stringify(anonBody)}\n  control: ${JSON.stringify(controlBody)}`);
        done();
      });
    });
  });
});

// Regression guard for the I3 finding: every case above runs under --debug,
// where lib/user-auth.js's debug branch forces isAdmin = true unconditionally
// -- so the flag gate (--authoringTools) is well covered above, but the
// second gate (isAdmin) never actually gets exercised by any of it. This is
// the one describe block that runs WITHOUT --debug, against a real
// FileAuthProvider config, so the admin gate has coverage before Task 5 adds
// the two genuinely dangerous tools on top of it. Pattern matches
// test/auth/06-admin-gating.js (own auth.json, exec + pkill by
// --authConfigPath, since there's no HTTP route here to shut the server down
// with).
describe('authoring tools: admin gate holds under real (non-debug) auth', function() {
  this.timeout(30000);
  const PORT = 9552;
  const AUTH_CONFIG_PATH = `/tmp/countinghouse-test-authoring-gating-${process.pid}.json`;
  const ADMIN_KEY     = 'authoring-admin-key';
  const NON_ADMIN_KEY = 'authoring-non-admin-key';

  before(function(done) {
    this.timeout(30000);
    assertPortFree(PORT, (err) => {
      if (err) return done(err);

      const config = {};
      config[ADMIN_KEY]     = {userName: 'authoring-admin',     devices: ['*'], admin: true};
      config[NON_ADMIN_KEY] = {userName: 'authoring-non-admin', devices: ['*']}; // no admin field: not admin
      fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

      exec(`"${path.join(ROOT, 'bin', 'countinghouse')}" --bindAddr 127.0.0.1 --port ${PORT} ` +
           `--authProvider file --authConfigPath ${AUTH_CONFIG_PATH} --authoringTools`,
           {cwd: ROOT}, (execErr) => { if (execErr) console.log(execErr); });
      setTimeout(() => done(), 13000);
    });
  });

  after((done) => {
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) { /* already gone */ }
    exec(`pkill -f "framework.js.*${AUTH_CONFIG_PATH}"`, () => { done(); });
  });

  it('is absent from tools/list for a non-admin (but otherwise valid) key', (done) => {
    toolsList(PORT, NON_ADMIN_KEY, (err, result) => {
      assert.ifError(err);
      const names = result.tools.map((t) => t.name);
      assert.ok(names.indexOf('countinghouse_validate_module') === -1,
        'a non-admin key must not see the authoring tool even with --authoringTools on');
      done();
    });
  });

  it('is present in tools/list for the admin key', (done) => {
    toolsList(PORT, ADMIN_KEY, (err, result) => {
      assert.ifError(err);
      const names = result.tools.map((t) => t.name);
      assert.ok(names.indexOf('countinghouse_validate_module') !== -1,
        'the admin key should see the authoring tool with --authoringTools on');
      done();
    });
  });

  it('refuses a call from the non-admin key with ADMIN_REQUIRED', (done) => {
    toolsCall(PORT, NON_ADMIN_KEY, 6, 'countinghouse_validate_module', {path: '.'}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, true);
      assert.ok(body.result.structuredContent != null && body.result.structuredContent.code === 'ADMIN_REQUIRED',
        `expected structuredContent.code === 'ADMIN_REQUIRED', got: ${JSON.stringify(body.result)}`);
      done();
    });
  });

  it('succeeds for the admin key', (done) => {
    const fixture = path.join(ROOT, 'test', 'fixtures', 'handler-map-convention');
    toolsCall(PORT, ADMIN_KEY, 7, 'countinghouse_validate_module', {path: fixture}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, false);
      assert.strictEqual(body.result.structuredContent.ok, true);
      done();
    });
  });
});

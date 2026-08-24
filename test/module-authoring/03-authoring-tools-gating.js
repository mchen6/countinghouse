// The authoring tools are admin-gated AND off unless --authoringTools is
// passed. Default-off is a safety property, not a preference:
// countinghouse_load_module does require(callerSuppliedPath) unsandboxed in
// the main gateway process to load a module into the live runtime.
// (countinghouse_validate_module runs caller-supplied code too, but in a
// spawned child process instead -- see lib/mcp/gateway.js's
// validateModuleInChildProcess comment for the full picture of what each of
// the four authoring tools does and doesn't protect against.) It must not be
// one flag-flip away on a deployment that merely happens to have an admin
// key configured.
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
const os      = require('os');
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

// Regression guard for the C1 review finding: `exec('pkill ...', callback)`'s
// callback fires once the pkill *process itself* exits, not once the target
// process has actually released its port -- SIGTERM (pkill's default signal)
// is a request, not an instantaneous teardown, and this describe block's
// server is a real `exec`-spawned process (not the `spawn(..., detached:
// true)` + `process.kill(-pid, 'SIGKILL')` pattern `stopServer` above uses,
// which has no such gap). Returning from `after` before the port is actually
// free let a later file in the same `npm test` mocha run (one process, one
// port namespace across every file in test/module-authoring/*.js) collide
// with this port while the old server was still mid-shutdown. Polling
// assertPortFree closes that gap instead of just hoping pkill was fast
// enough.
function waitForPortFree(port, deadline, callback) {
  assertPortFree(port, (err) => {
    if (err == null) return callback();
    if (Date.now() >= deadline) return callback(err);
    return setTimeout(() => waitForPortFree(port, deadline, callback), 100);
  });
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

// Builds a throwaway module directory on disk -- api.json/schema.json/
// handlers/ identical in shape to test/fixtures/handler-map-convention, plus
// an index.js whose content the caller controls. Used by the Task 8 defect-A
// (require() cache staleness) proof below, which needs to edit a module's
// main entry BETWEEN two validate calls -- that can't be done against a
// fixture checked into the repo without leaving the working tree dirty.
function writeTempModule(indexContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-validate-cache-'));
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({name: 'cache-staleness-fixture', version: '1.0.0'}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({
    device: {
      friendlyName: 'cache-staleness-fixture',
      manufacturer: 'countinghouse-test',
      modelDescription: 'Task 8 defect-A proof: temp module, edited between two validate calls.',
      serviceList: {
        'urn:countinghouse-test:serviceID:greetService': {
          actionList: [{
            name: 'hello', description: 'Returns a greeting.',
            input:  {schema: '/greetService/hello/input'},
            output: {schema: '/greetService/hello/output'}
          }]
        }
      }
    }
  }));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    greetService: {
      hello: {
        input:  {type: 'object', properties: {name: {type: 'string'}}, required: ['name']},
        output: {type: 'object', properties: {text: {type: 'string'}, caller: {type: ['string', 'null']}}}
      }
    }
  }));
  fs.mkdirSync(path.join(dir, 'handlers', 'greetService'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'handlers', 'greetService', 'hello.js'),
    'module.exports = async (input, ctx) => ({output: {text: `hello ${input.name}`, caller: ctx.caller.apiKey}});\n');
  fs.writeFileSync(path.join(dir, 'index.js'), indexContent);
  return dir;
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

  // Task 8, item C: countinghouse_validate_plan had no end-to-end coverage
  // through the real JSON-RPC path, unlike its sibling
  // countinghouse_validate_module above -- these two mirror that sibling's
  // shape (a clean case and a broken one), against the real HTTP/MCP entry
  // point rather than lib/plan-validator.js directly (already covered by
  // test/module-authoring/05-validate-plan.js).
  it('validates a well-formed plan through the tool', (done) => {
    const plan = {
      device: 'log-review',
      services: [{
        name: 'reviewService',
        actions: [{name: 'summarize', description: 'Summarize error logs by service.'}]
      }]
    };
    toolsCall(PORT, 'aabbcc', 8, 'countinghouse_validate_plan', plan, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, false);
      const out = body.result.structuredContent;
      assert.strictEqual(out.ok, true);
      assert.deepStrictEqual(out.problems, []);
      // Matches the exact name test/module-authoring/05-validate-plan.js's
      // "reports a collision" case already pins down for this same plan.
      assert.deepStrictEqual(out.toolNames, ['log_review_reviewservice_summarize']);
      done();
    });
  });

  it('returns the problem list for a broken plan through the tool', (done) => {
    const plan = {device: 'x', services: []};
    toolsCall(PORT, 'aabbcc', 9, 'countinghouse_validate_plan', plan, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, false);
      const out = body.result.structuredContent;
      assert.strictEqual(out.ok, false);
      assert.ok(out.problems.some((p) => p.stage === 'validatePlan'),
        `expected a validatePlan problem, got: ${JSON.stringify(out.problems)}`);
      done();
    });
  });

  // Task 8, item A: validate -> edit a handler/entry file -> validate again
  // is the exact authoring loop this toolchain exists to serve, and it used
  // to be broken by it -- countinghouse_validate_module ran require() inside
  // this long-lived gateway process, so Node's module cache returned the
  // FIRST validate's already-loaded export on every subsequent call against
  // the same path, no matter what the file on disk said by then. Proven here
  // by validating a module whose index.js does not throw, editing that same
  // file on disk to throw, and validating the same path again: the second
  // result must reflect the edit. Against the pre-Task-8 in-process
  // implementation this test fails (second result is still ok:true, from the
  // stale cached export) -- against the child-process implementation it
  // passes, because there is no require() cache spanning two separate
  // `node bin/countinghouse-validate.js` processes.
  it('reflects an edited entry file on the very next validate call (Task 8, defect A: no stale require cache)', function(done) {
    this.timeout(15000);
    const dir = writeTempModule('module.exports = {};\n');

    toolsCall(PORT, 'aabbcc', 10, 'countinghouse_validate_module', {path: dir}, (err, first) => {
      assert.ifError(err);
      assert.strictEqual(first.result.structuredContent.ok, true,
        `expected the first validate to be clean, got: ${JSON.stringify(first.result)}`);

      fs.writeFileSync(path.join(dir, 'index.js'), "throw new Error('edited-after-first-validate');\n");

      toolsCall(PORT, 'aabbcc', 11, 'countinghouse_validate_module', {path: dir}, (err, second) => {
        assert.ifError(err);
        const out = second.result.structuredContent;
        assert.strictEqual(out.ok, false,
          `expected the edit to be picked up by the second validate, got: ${JSON.stringify(out)}`);
        const entryProblems = out.problems.filter((p) => p.stage === 'loadModuleEntry');
        assert.strictEqual(entryProblems.length, 1,
          `expected exactly one loadModuleEntry problem, got: ${JSON.stringify(out.problems)}`);
        assert.ok(/edited-after-first-validate/.test(entryProblems[0].message),
          `expected the SECOND validate's problem to name the edit, got: ${entryProblems[0].message}`);
        done();
      });
    });
  });

  // Task 8, item B: a module whose main entry calls process.exit() during
  // require() used to take the whole gateway process down with it -- there
  // is no try/catch that survives a require() calling process.exit()
  // in-process. Proven here two ways: the tool call itself answers with a
  // problem (not a crash, not a hang), AND the same server goes on to answer
  // an unrelated tools/list call right afterward, proving the gateway
  // process is still alive.
  it('a module whose entry calls process.exit() is reported as a problem, and the gateway survives (Task 8, defect B)', (done) => {
    const fixture = path.join(ROOT, 'test', 'fixtures', 'handler-map-process-exit');
    toolsCall(PORT, 'aabbcc', 12, 'countinghouse_validate_module', {path: fixture}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, false,
        `countinghouse_validate_module itself must not surface as a tool error: ${JSON.stringify(body.result)}`);
      const out = body.result.structuredContent;
      assert.strictEqual(out.ok, false);
      assert.ok(out.problems.length > 0, 'expected at least one problem describing the crashed subprocess');

      toolsList(PORT, 'aabbcc', (listErr, result) => {
        assert.ifError(listErr);
        assert.ok(Array.isArray(result.tools) && result.tools.length > 0,
          'the gateway must still be able to answer tools/list after validating a module that called process.exit()');
        done();
      });
    });
  });

  // Task 8 review round: a module whose main entry writes to stdout during
  // require() -- an ordinary startup log line, not adversarial -- used to
  // corrupt the machine-readable channel bin/countinghouse-validate.js --json
  // promises. The child's stdout became "<module's log line>\n<the real JSON
  // line>", lib/mcp/gateway.js's parseValidateChildOutput could not
  // JSON.parse that combined blob, and a perfectly clean module was reported
  // as ok:false with a validateModuleChildProcess problem. Fixed two ways:
  // the CLI captures process.stdout.write for the duration of the
  // validateModule call in --json mode (so console.log-based writes never
  // reach the JSON channel), and the gateway now scans for the LAST line of
  // stdout that parses as JSON rather than trusting the whole stream, as
  // defense-in-depth against writes that bypass the CLI's capture (e.g.
  // fs.writeSync(1, ...)). This is the regression guard for both halves.
  it('a module that logs at load time still validates cleanly (Task 8 review: stdout pollution)', (done) => {
    const fixture = path.join(ROOT, 'test', 'fixtures', 'handler-map-logs-on-load');
    toolsCall(PORT, 'aabbcc', 13, 'countinghouse_validate_module', {path: fixture}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, false,
        `countinghouse_validate_module itself must not surface as a tool error: ${JSON.stringify(body.result)}`);
      const out = body.result.structuredContent;
      assert.strictEqual(out.ok, true,
        `a module's own load-time stdout write must not corrupt the result, got: ${JSON.stringify(out)}`);
      assert.deepStrictEqual(out.problems, []);
      assert.ok(!out.problems.some((p) => p.stage === 'validateModuleChildProcess'),
        'a load-time console.log must never be misread as the validator subprocess failing to produce a result');
      done();
    });
  });

  // Final-review regression guard: bin/countinghouse-validate.js's --json mode
  // restores process.stdout.write BEFORE printing its own result line, so
  // anything a module prints AFTER that point (a process 'exit' handler,
  // teardown logging) lands after the real result and, before this fix,
  // would win lib/mcp/gateway.js's end-of-stream scan for "the last line
  // that parses as JSON" -- a bare {shutdown:'clean',...} object parses fine,
  // it just isn't the validator's result. See
  // test/fixtures/handler-map-logs-on-exit/index.js for the exact reproducer
  // and parseValidateChildOutput's shape check for the fix.
  it('a module that logs at process-exit time still validates cleanly (final review: stale stdout scan)', (done) => {
    const fixture = path.join(ROOT, 'test', 'fixtures', 'handler-map-logs-on-exit');
    toolsCall(PORT, 'aabbcc', 14, 'countinghouse_validate_module', {path: fixture}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, false,
        `countinghouse_validate_module itself must not surface as a tool error: ${JSON.stringify(body.result)}`);
      const out = body.result.structuredContent;
      assert.strictEqual(out.ok, true,
        `an exit-time console.log must not be mistaken for the validator's result, got: ${JSON.stringify(out)}`);
      assert.deepStrictEqual(out.problems, []);
      done();
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

  after(function(done) {
    this.timeout(15000);
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) { /* already gone */ }
    exec(`pkill -f "framework.js.*${AUTH_CONFIG_PATH}"`, () => {
      // Soft-fail on timeout (log, don't fail the suite): a teardown that's
      // merely slow shouldn't be reported as a test failure. What matters is
      // that we actually waited instead of racing the next file's server.
      waitForPortFree(PORT, Date.now() + 10000, (err) => {
        if (err != null) console.warn(`03-authoring-tools-gating: ${err.message}`);
        done();
      });
    });
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

  // Regression guard for the I5 review finding: the admin gate in
  // dispatchAuthoringTool runs once, before the name-specific branches --
  // this had only ever been exercised via countinghouse_validate_module.
  // countinghouse_load_module and countinghouse_call_tool share the exact
  // same gate (same function, same early check), but that was never
  // actually asserted for either of them -- --debug (every other describe
  // block in this file) forces isAdmin: true unconditionally, so it cannot
  // exercise this at all; this block is the only one with a real non-admin
  // identity to call them with.
  ['countinghouse_load_module', 'countinghouse_call_tool'].forEach((name) => {
    it(`refuses a ${name} call from the non-admin key with ADMIN_REQUIRED`, (done) => {
      toolsCall(PORT, NON_ADMIN_KEY, 6, name, {path: '.', name: 'x'}, (err, body) => {
        assert.ifError(err);
        assert.strictEqual(body.result.isError, true);
        assert.ok(body.result.structuredContent != null && body.result.structuredContent.code === 'ADMIN_REQUIRED',
          `expected structuredContent.code === 'ADMIN_REQUIRED', got: ${JSON.stringify(body.result)}`);
        done();
      });
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

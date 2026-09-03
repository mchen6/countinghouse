// A declared schema pointer that fails to resolve must be visible at error
// level, and must name what failed.
//
// Audit leftover #2. resolveSchemas (lib/mcp/tool-registry.js) had
// `if (err || data == null) return cb(null, DEFAULT_SCHEMA);` on both its
// input and output branches: the error was dropped and the tool went out on
// tools/list advertising {type: 'object', properties: {}} -- "any object is
// fine" -- instead of its real schema. A caller then sends what that
// permissive schema allows and the call fails server-side in
// validateActionCall, with nothing upstream explaining why.
//
// Deliberately runs WITHOUT --debug, unlike its sibling files here. There is
// an incidental error log on this path (Session.prototype.logAPICall,
// lib/session.js) that fires only under --debug and names neither the tool
// nor which schema failed -- so a --debug run would let this test pass on a
// log that does not actually diagnose the problem. Verified before the fix:
// non-debug produced zero error-level records for a dangling pointer while
// still advertising the tool.
const assert = require('assert');
const fs     = require('fs');
const http   = require('http');
const exec   = require('child_process').exec;

const PORT             = 9575;
const LOG              = `/tmp/countinghouse-test-schema-pointer-${process.pid}.log`;
const AUTH_CONFIG_PATH = `/tmp/countinghouse-test-schema-pointer-auth-${process.pid}.json`;
const KEY              = `schema-pointer-key-${process.pid}`;

// The fixture declares input.schema = /pointerService/danglingInput/nosuchkey,
// which its schema.json does not contain; its output pointer resolves fine,
// so one action exercises both the failing and the succeeding branch.
const TOOL = 'dangling_schema_pointer_device_pointerservice_danglinginput';

// framework.js directly, not bin/countinghouse: the launcher pipes stdout
// through bunyan when bunyan is on PATH, and this file reads the log as
// JSON. Same reasoning as 01 and 03 in this directory.
function startServer(done) {
  const config = {};
  config[KEY] = {userName: 'schema-pointer-test', devices: ['*']};
  fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

  exec(`NODE_PATH=./lib node ./framework.js --bindAddr 127.0.0.1 --port ${PORT
       } --authProvider file --authConfigPath ${AUTH_CONFIG_PATH
       } --loadModule ./test/fixtures/dangling-schema-pointer` +
       ` --loadModule ./pre-installed-packages/echo-device-module` +
       ` > ${LOG} 2>&1`, () => {});
  setTimeout(done, 12000);
}

function errorRecords() {
  const out = [];
  let raw;
  try { raw = fs.readFileSync(LOG, 'utf8'); } catch (e) { return out; }

  raw.split('\n').forEach((line) => {
    if (line.trim() === '') return;
    let rec;
    try { rec = JSON.parse(line); } catch (e) { return; }
    if (rec.level == null || rec.level < 40) return;   // 40 = bunyan ERROR
    const text = (typeof(rec.e) === 'string') ? rec.e
             : (rec.de != null ? JSON.stringify(rec.de) : JSON.stringify(rec));
    out.push(text);
  });
  return out;
}

function toolsList(callback) {
  const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}});
  const req = http.request({
    host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-CH-Key': KEY, 'Content-Length': Buffer.byteLength(body)}
  }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      try { callback(null, JSON.parse(data)); } catch (e) { callback(new Error(`non-JSON response: ${data.slice(0, 200)}`)); }
    });
  });
  req.on('error', callback);
  req.end(body);
}

describe('module-loading 10: an unresolvable schema pointer is not a silent downgrade', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    startServer(() => {
      // the downgrade happens during tools/list, not at load time -- schemas
      // are resolved per request (see tool-registry.js's header on why this
      // file keeps no state), so the log record only exists after a call.
      toolsList(() => { setTimeout(done, 500); });
    });
  });

  after((done) => {
    try { fs.unlinkSync(LOG); } catch (e) {}
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) {}
    exec(`pkill -f "framework.js.*${AUTH_CONFIG_PATH}"`, () => { done(); });
  });

  it('logs the failed resolution at error level', () => {
    const errors = errorRecords();
    const hit = errors.filter((e) => /TOOL_SCHEMA_RESOLVE_FAIL|schema/i.test(e) && /nosuchkey/.test(e));
    assert.ok(hit.length > 0,
      `expected an error-level record naming the unresolved pointer; got: ${JSON.stringify(errors)}`);
  });

  it('names the tool, which schema, and the concrete reason', () => {
    const hit = errorRecords().filter((e) => /nosuchkey/.test(e));
    assert.ok(hit.length > 0, 'no record mentioned the failing pointer at all');

    const text = hit.join(' | ');
    assert.ok(text.indexOf(TOOL) !== -1,
      `the record must name the tool (${TOOL}) so an operator can find it: ${text}`);
    assert.ok(/\binput\b/.test(text),
      `the record must say which schema (input vs output) failed: ${text}`);
    assert.ok(text.indexOf('/pointerService/danglingInput/nosuchkey') !== -1,
      `the record must name the pointer that did not resolve: ${text}`);
    // the underlying cause from resolveSchemaFromPath, not just "failed"
    assert.ok(/does not exist|dereference|POINTER_DEREF_ERROR/i.test(text),
      `the record must carry the concrete reason, not just that it failed: ${text}`);
  });

  it('does not log for an action that declares no schema at all', () => {
    // echo-device-module's actions all declare real, resolvable pointers, and
    // "no pointer declared" is a legitimate, common case that must stay
    // silent -- otherwise the new log is noise on every tools/list.
    const noisy = errorRecords().filter((e) => /echo/i.test(e) && /TOOL_SCHEMA_RESOLVE_FAIL/.test(e));
    assert.strictEqual(noisy.length, 0,
      `a module with resolvable schemas must not log a downgrade: ${JSON.stringify(noisy)}`);
  });

  // Pins the decision that this fix is log-only: the tool is still
  // advertised, still with the permissive default schema. Changing that
  // would move the tools/list surface (which the pre-commit golden hook
  // guards) and was deliberately left out of scope.
  it('still advertises the tool, with the default schema, unchanged', (done) => {
    toolsList((err, res) => {
      if (err) return done(err);

      const tools = (res.result != null && Array.isArray(res.result.tools)) ? res.result.tools : [];
      const names = tools.map((t) => t.name);

      const tool = tools.find((t) => t.name === TOOL);
      assert.ok(tool != null, `the tool must still be listed; got: ${JSON.stringify(names)}`);
      assert.deepStrictEqual(tool.inputSchema, {type: 'object', properties: {}},
        'the downgrade behavior itself is unchanged -- still the permissive default');

      // and the failure stays isolated: the good module is unaffected
      assert.ok(names.some((n) => /^echo_device_/.test(n)),
        `a co-loaded good module must still serve its tools; got: ${JSON.stringify(names)}`);
      return done();
    });
  });
});

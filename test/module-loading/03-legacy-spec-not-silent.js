// An un-migrated 4.x module must fail *loudly and specifically*, and must not
// take the rest of the server down with it.
//
// This is the regression guard for the failure mode this project has hit
// before (MODULE_NOT_DISCOVERABLE / DEVICE_SPEC_VALIDATION_FAIL, see
// test/module-loading/01): a module that simply never appears, with nothing at
// error level to explain it. The 5.0.0 format change is exactly the situation
// that would reintroduce it -- every existing module in the world fails to
// load the day it lands -- so the diagnostic is asserted, not assumed.
//
// Four things are checked against the real server log and the real MCP
// surface, with a known-good module loaded alongside the broken one:
//
//   1. the failure is visible at error level (>= 40) -- "not silent"
//   2. it names the module, the stage, and the concrete reason (which
//      construct was found, in which service)
//   3. it names the command that fixes it
//   4. the broken module contributes no tools, and the good module still
//      serves its own -- the failure is isolated, not fatal, not partial
var assert = require('assert');
var fs     = require('fs');
var http   = require('http');
var exec   = require('child_process').exec;

var PORT = 9574;
var LOG  = '/tmp/countinghouse-test-legacy-' + process.pid + '.log';

// framework.js directly, not bin/countinghouse: the launcher pipes stdout
// through bunyan when bunyan is on PATH (npm/npx put node_modules/.bin there),
// and this file reads the log as JSON. Same reasoning as 01.
function startServer(done) {
  exec('NODE_PATH=./lib node ./framework.js --debug --bindAddr 127.0.0.1 --port ' + PORT +
       ' --debugKey aabbcc' +
       ' --loadModule ./test/fixtures/legacy-spec-module' +
       ' --loadModule ./pre-installed-packages/echo-device-module' +
       ' > ' + LOG + ' 2>&1', function() {});
  setTimeout(done, 12000);
}

function errorRecords() {
  var out = [];
  var raw;
  try { raw = fs.readFileSync(LOG, 'utf8'); } catch (e) { return out; }

  raw.split('\n').forEach(function(line) {
    if (line.trim() === '') return;
    var rec;
    try { rec = JSON.parse(line); } catch (e) { return; }
    if (rec.level == null || rec.level < 40) return;   // 40 = bunyan ERROR
    var text = (typeof(rec.e) === 'string') ? rec.e
             : (rec.de != null ? JSON.stringify(rec.de) : JSON.stringify(rec));
    out.push(text);
  });
  return out;
}

function toolsList(callback) {
  var body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}});
  var req = http.request({
    host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-CH-Key': 'aabbcc', 'Content-Length': Buffer.byteLength(body)}
  }, function(res) {
    var data = '';
    res.on('data', function(c) { data += c; });
    res.on('end', function() {
      try { callback(null, JSON.parse(data)); } catch (e) { callback(new Error('non-JSON response: ' + data.slice(0, 200))); }
    });
  });
  req.on('error', callback);
  req.end(body);
}

describe('module-loading 03: an un-migrated 4.x module fails loudly, specifically, and alone', function() {
  this.timeout(0);

  var tools;

  before(function(done) {
    startServer(function() {
      toolsList(function(err, res) {
        if (err) return done(err);
        if (res == null || res.result == null || !Array.isArray(res.result.tools)) {
          return done(new Error('tools/list did not return a tool array: ' + JSON.stringify(res)));
        }
        tools = res.result.tools.map(function(t) { return t.name; });
        done();
      });
    });
  });

  after(function(done) {
    try { fs.unlinkSync(LOG); } catch (e) {}
    exec('pkill -f "framework.js --debug --bindAddr 127.0.0.1 --port ' + PORT + '"', function() { done(); });
  });

  it('does not fail silently: the module error is visible at error level', function() {
    var hits = errorRecords().filter(function(e) { return e.indexOf('legacy-spec-module') !== -1; });
    assert.ok(hits.length > 0,
      'a module that cannot load must produce an error-level record naming it; ' +
      'found none among: ' + JSON.stringify(errorRecords()));
  });

  it('names the failing stage and the concrete reason, not just "invalid"', function() {
    var text = errorRecords().join('\n');
    assert.ok(/stage=validateDeviceSpec/.test(text), 'missing the stage: ' + text);
    assert.ok(/pre-5\.0\.0 spec format/.test(text), 'missing the diagnosis: ' + text);
    // the specific construct found, and where -- not a generic ajv symptom
    assert.ok(/serviceStateTable/.test(text), 'missing what was found: ' + text);
    assert.ok(/urn:countinghouse-test:serviceID:legacyService/.test(text),
      'missing which service it was found in: ' + text);
  });

  it('names the command that fixes it', function() {
    var text = errorRecords().join('\n');
    assert.ok(/countinghouse-migrate-spec/.test(text), 'missing the converter command: ' + text);
    assert.ok(/MIGRATION\.md/.test(text), 'missing the pointer to the migration notes: ' + text);
  });

  it('registers no tools for the broken module -- it does not half-load', function() {
    var leaked = tools.filter(function(n) { return n.indexOf('legacy_spec_module') === 0; });
    assert.deepStrictEqual(leaked, [],
      'a module that failed validation must expose no tools, got: ' + JSON.stringify(leaked));
  });

  it('does not take the healthy module down with it', function() {
    assert.ok(tools.indexOf('echo_device_echoservice_echo') !== -1,
      'a module loaded alongside the broken one must still be served, got: ' + JSON.stringify(tools));
  });
});

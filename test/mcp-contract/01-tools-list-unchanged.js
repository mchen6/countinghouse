// The judgement criterion for the 5.0.0 spec-format refactor: api.json is a
// description format, so changing it must not change the MCP contract the
// modules produce.
//
// tools-list.golden.json was captured from every bundled module *before* the
// format changed (commit 6f948fc, still on the old format). This asserts that
// the same modules, now converted, still produce exactly that -- same tool
// names, descriptions, inputSchema and outputSchema, field for field.
//
// Regenerate the golden file only when a tool surface is meant to change:
//   node test/mcp-contract/capture-tools-list.js
var assert = require('assert');
var fs     = require('fs');
var path   = require('path');
var http   = require('http');
var spawn  = require('child_process').spawn;

var PORT    = 9531;
var ROOT    = path.join(__dirname, '..', '..');
var PKG_DIR = path.join(ROOT, 'pre-installed-packages');
var GOLDEN  = require('./tools-list.golden.json');

var server;

function startServer(done) {
  var modules = fs.readdirSync(PKG_DIR).filter(function(f) {
    return fs.statSync(path.join(PKG_DIR, f)).isDirectory();
  }).sort();

  var args = ['--debug', '--bindAddr', '127.0.0.1', '--port', String(PORT), '--debugKey', 'aabbcc'];
  modules.forEach(function(m) { args.push('--loadModule', path.join(PKG_DIR, m)); });

  server = spawn(path.join(ROOT, 'bin', 'countinghouse'), args, {cwd: ROOT, stdio: 'ignore'});
  setTimeout(done, 8000);
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

describe('mcp-contract 01: the spec format change did not move the MCP surface', function() {
  this.timeout(0);

  var actual;

  before(function(done) {
    startServer(function() {
      toolsList(function(err, res) {
        if (err) return done(err);
        if (res == null || res.result == null || !Array.isArray(res.result.tools)) {
          return done(new Error('tools/list did not return a tool array: ' + JSON.stringify(res)));
        }
        actual = res.result.tools.slice().sort(function(a, b) {
          return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        });
        done();
      });
    });
  });

  after(function() {
    if (server != null) server.kill();
  });

  it('advertises exactly the same tool names', function() {
    assert.deepStrictEqual(actual.map(function(t) { return t.name; }),
                           GOLDEN.map(function(t) { return t.name; }));
  });

  it('every tool is field-for-field identical to the pre-migration sample', function() {
    GOLDEN.forEach(function(expected, i) {
      var got = actual[i];
      assert.strictEqual(got.description,  expected.description,  expected.name + ': description moved');
      assert.deepStrictEqual(got.inputSchema,  expected.inputSchema,  expected.name + ': inputSchema moved');
      assert.deepStrictEqual(got.outputSchema, expected.outputSchema, expected.name + ': outputSchema moved');
    });
  });

  it('the whole list is byte-identical once serialized', function() {
    assert.strictEqual(JSON.stringify(actual, null, 2), JSON.stringify(GOLDEN, null, 2));
  });
});

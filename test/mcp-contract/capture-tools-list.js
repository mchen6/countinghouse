// Captures the MCP tools/list surface produced by every bundled module into
// a golden file. Run it against the *old* spec format to record the baseline,
// then again after the format change: 01-tools-list-unchanged.js asserts the
// two are byte-identical.
//
//   node test/mcp-contract/capture-tools-list.js [outfile]
//
// Starts its own server on port 9530 with --debug (so no AuthProvider
// filtering hides anything) and every module in pre-installed-packages/.
var fs      = require('fs');
var path    = require('path');
var http    = require('http');
var spawn   = require('child_process').spawn;

var PORT     = 9530;
var ROOT     = path.join(__dirname, '..', '..');
var PKG_DIR  = path.join(ROOT, 'pre-installed-packages');
var OUT      = process.argv[2] || path.join(__dirname, 'tools-list.golden.json');

var modules = fs.readdirSync(PKG_DIR).filter(function(f) {
  return fs.statSync(path.join(PKG_DIR, f)).isDirectory();
}).sort();

var args = ['--debug', '--bindAddr', '127.0.0.1', '--port', String(PORT), '--debugKey', 'aabbcc'];
modules.forEach(function(m) {
  args.push('--loadModule', path.join(PKG_DIR, m));
});

var server = spawn(path.join(ROOT, 'bin', 'countinghouse'), args, {cwd: ROOT, stdio: 'ignore'});

function toolsList(callback) {
  var body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}});
  var req = http.request({
    host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-CH-Key': 'aabbcc', 'Content-Length': Buffer.byteLength(body)}
  }, function(res) {
    var data = '';
    res.on('data', function(c) { data += c; });
    res.on('end', function() {
      try {
        return callback(null, JSON.parse(data));
      } catch (e) {
        return callback(new Error('non-JSON response: ' + data.slice(0, 200)));
      }
    });
  });
  req.on('error', callback);
  req.end(body);
}

setTimeout(function() {
  toolsList(function(err, res) {
    if (err || res == null || res.result == null || !Array.isArray(res.result.tools)) {
      console.error('tools/list failed:', err ? err.message : JSON.stringify(res));
      server.kill();
      process.exit(1);
    }
    // sort by name so the golden file does not depend on module load order
    var tools = res.result.tools.slice().sort(function(a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
    fs.writeFileSync(OUT, JSON.stringify(tools, null, 2) + '\n');
    console.log('wrote ' + tools.length + ' tools to ' + OUT);
    server.kill();
    process.exit(0);
  });
}, 8000);

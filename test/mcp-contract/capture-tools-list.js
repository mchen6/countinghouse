// Captures the MCP tools/list surface produced by every bundled module into
// a golden file. Run it against the *old* spec format to record the baseline,
// then again after the format change: 01-tools-list-unchanged.js asserts the
// two are byte-identical.
//
//   node test/mcp-contract/capture-tools-list.js [outfile]
//
// Starts its own server on port 9530 with --debug (so no AuthProvider
// filtering hides anything) and every module in pre-installed-packages/.
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const spawn   = require('child_process').spawn;

const PORT     = 9530;
const ROOT     = path.join(__dirname, '..', '..');
const PKG_DIR  = path.join(ROOT, 'pre-installed-packages');
const OUT      = process.argv[2] || path.join(__dirname, 'tools-list.golden.json');

const modules = fs.readdirSync(PKG_DIR).filter((f) => {
  return fs.statSync(path.join(PKG_DIR, f)).isDirectory();
}).sort();

const args = ['--debug', '--bindAddr', '127.0.0.1', '--port', String(PORT), '--debugKey', 'aabbcc'];
modules.forEach((m) => {
  args.push('--loadModule', path.join(PKG_DIR, m));
});

// Guarded: this file sits in a directory mocha globs, and it must not spawn a
// server (or call process.exit) merely because mocha required it.
if (require.main !== module) {
  module.exports = {};
  return;
}

// detached so the whole process group can be killed: bin/countinghouse is a
// /bin/sh wrapper that runs node as a child (and pipes it into bunyan), so
// killing the returned pid alone leaves the server listening.
const server = spawn(path.join(ROOT, 'bin', 'countinghouse'), args, {cwd: ROOT, stdio: 'ignore', detached: true});

function stopServer() {
  try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
}

function toolsList(callback) {
  const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}});
  const req = http.request({
    host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-CH-Key': 'aabbcc', 'Content-Length': Buffer.byteLength(body)}
  }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      try {
        return callback(null, JSON.parse(data));
      } catch (e) {
        return callback(new Error(`non-JSON response: ${data.slice(0, 200)}`));
      }
    });
  });
  req.on('error', callback);
  req.end(body);
}

setTimeout(() => {
  toolsList((err, res) => {
    if (err || res == null || res.result == null || !Array.isArray(res.result.tools)) {
      console.error('tools/list failed:', err ? err.message : JSON.stringify(res));
      stopServer();
      process.exit(1);
    }
    // sort by name so the golden file does not depend on module load order
    const tools = res.result.tools.slice().sort((a, b) => { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
    fs.writeFileSync(OUT, `${JSON.stringify(tools, null, 2)}\n`);
    console.log(`wrote ${tools.length} tools to ${OUT}`);
    stopServer();
    process.exit(0);
  });
}, 8000);

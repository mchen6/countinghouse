// The judgement criterion for the 5.0.0 spec-format refactor: api.json is a
// description format, so changing it must not change the MCP contract the
// modules produce.
//
// tools-list.golden.json was captured from every bundled module *before* the
// format changed (commit 6f948fc, still on the old format). This asserts that
// the same modules, now converted, still produce exactly that -- same tool
// names, descriptions, inputSchema and outputSchema, field for field.
//
// Scope, stated because it is easy to over-read this file: the baseline was
// taken at 6f948fc, which is *after* phases 1b/1c had already removed the
// echoWithAPICache action. So this file proves the format change moved
// nothing; it cannot see that earlier removal.
// 02-approved-tool-changes.js covers the rest -- it pins the complete 4.x ->
// 5.0.0 delta against a sample from before any of this work.
//
// Regenerate the golden file only when a tool surface is meant to change:
//   node test/mcp-contract/capture-tools-list.js
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const net    = require('net');
const spawn  = require('child_process').spawn;

const PORT    = 9531;
const ROOT    = path.join(__dirname, '..', '..');
const PKG_DIR = path.join(ROOT, 'pre-installed-packages');
const GOLDEN  = require('./tools-list.golden.json');

let server;

// bin/countinghouse is a /bin/sh wrapper that runs node as a *child* (and
// pipes it into bunyan when bunyan is on PATH), so killing the returned pid
// only kills the shell and leaves the server running. Spawn detached so the
// whole thing is one process group, and kill the group.
function stopServer() {
  if (server == null || server.pid == null) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
  server = null;
}

// A server left behind by an earlier run would answer on this port, and the
// comparison below would then pass against *its* modules rather than the ones
// in this working tree -- the exact failure this file exists to catch, which
// is why it refuses to run rather than trusting whoever answers.
//
// A bare TCP connect, not an HTTP request: it cannot hang on protocol
// semantics, and every path destroys the socket -- an undrained socket keeps
// the event loop alive and mocha never exits.
function assertPortFree(callback) {
  let done   = false;
  const socket = net.connect({host: '127.0.0.1', port: PORT});

  function finish(err) {
    if (done) return;
    done = true;
    socket.destroy();
    callback(err);
  }

  socket.setTimeout(2000);
  socket.on('connect', () => {
    finish(new Error(`port ${PORT} is already in use. A server from an earlier run is still up; ` +
                     `kill it (fuser -k ${PORT}/tcp) before running this suite.`));
  });
  socket.on('timeout', () => { finish(null); });
  socket.on('error',   () => { finish(null); }); // nothing listening: what we want
}

function startServer(done) {
  assertPortFree((err) => {
    if (err) return done(err);

    const modules = fs.readdirSync(PKG_DIR).filter((f) => {
      return fs.statSync(path.join(PKG_DIR, f)).isDirectory();
    }).sort();

    const args = ['--debug', '--bindAddr', '127.0.0.1', '--port', String(PORT), '--debugKey', 'aabbcc'];
    modules.forEach((m) => { args.push('--loadModule', path.join(PKG_DIR, m)); });

    server = spawn(path.join(ROOT, 'bin', 'countinghouse'), args, {cwd: ROOT, stdio: 'ignore', detached: true});
    setTimeout(done, 8000);
  });
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
      try { callback(null, JSON.parse(data)); } catch (e) { callback(new Error(`non-JSON response: ${data.slice(0, 200)}`)); }
    });
  });
  req.on('error', callback);
  req.end(body);
}

describe('mcp-contract 01: the spec format change did not move the MCP surface', function() {
  this.timeout(0);

  let actual;

  before((done) => {
    startServer((startErr) => {
      if (startErr) return done(startErr);
      toolsList((err, res) => {
        if (err) return done(err);
        if (res == null || res.result == null || !Array.isArray(res.result.tools)) {
          return done(new Error(`tools/list did not return a tool array: ${JSON.stringify(res)}`));
        }
        actual = res.result.tools.slice().sort((a, b) => {
          return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
        });
        done();
      });
    });
  });

  after(() => {
    stopServer();
  });

  it('advertises exactly the same tool names', () => {
    assert.deepStrictEqual(actual.map((t) => { return t.name; }),
                           GOLDEN.map((t) => { return t.name; }));
  });

  it('every tool is field-for-field identical to the pre-migration sample', () => {
    GOLDEN.forEach((expected, i) => {
      const got = actual[i];
      assert.strictEqual(got.description,  expected.description,  `${expected.name}: description moved`);
      assert.deepStrictEqual(got.inputSchema,  expected.inputSchema,  `${expected.name}: inputSchema moved`);
      assert.deepStrictEqual(got.outputSchema, expected.outputSchema, `${expected.name}: outputSchema moved`);
    });
  });

  it('the whole list is byte-identical once serialized', () => {
    assert.strictEqual(JSON.stringify(actual, null, 2), JSON.stringify(GOLDEN, null, 2));
  });
});

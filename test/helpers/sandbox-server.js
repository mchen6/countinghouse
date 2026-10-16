// Spawning and calling a countinghouse server for the module-sandbox tests
// (test/sandbox/). One place for the boilerplate the other server tests each
// carry their own copy of: spawn detached so the whole group can be killed,
// collect stdout so tests can look for `module sandbox:` lines, wait for the
// ready line, and talk MCP or plain HTTP to it.
const path    = require('path');
const spawn   = require('child_process').spawn;
const request = require('supertest');
const waitForReady = require('./wait-for-ready');

const ROOT = path.join(__dirname, '..', '..');

// opts.expectExit: resolve as soon as the process exits instead of waiting
// for the ready line -- for startup-refusal tests. A server that starts
// instead is killed after 20 s, so a failing test does not leak it.
// opts.env: extra environment variables for the server.
// opts.cwd: the server's working directory (default: the repo root).
function startServer(port, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath,
      [path.join(ROOT, 'framework.js'), '--bindAddr', '127.0.0.1', '--port', String(port)].concat(args),
      {cwd: opts.cwd || ROOT,
       env: Object.assign({}, process.env, {NODE_PATH: path.join(ROOT, 'lib')}, opts.env || {}),
       stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    server.output = '';
    server.exitCode = null;
    server.stdout.on('data', (chunk) => { server.output += chunk.toString(); });
    server.stderr.on('data', (chunk) => { server.output += chunk.toString(); });
    if (opts.expectExit === true) {
      const timer = setTimeout(() => {
        stopServer(server);
        reject(new Error(`server did not exit; last output: ${server.output.slice(-2000)}`));
      }, 20000);
      server.on('exit', (code) => { clearTimeout(timer); server.exitCode = code; resolve(server); });
      return;
    }
    server.on('exit', (code) => { server.exitCode = code; });
    waitForReady(server, (err) => (err ? reject(err) : resolve(server)));
  });
}

// try/catch: the server may already be gone if an earlier step failed.
function stopServer(server) {
  if (server == null || server.pid == null) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
}

function mcpCall(port, key, name, args) {
  return new Promise((resolve, reject) => {
    request(`http://127.0.0.1:${port}`)
      .post('/mcp')
      .set('X-CH-Key', key)
      .set('Accept', 'application/json, text/event-stream')
      .send({jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: {name: name, arguments: args || {}}})
      .end((err, res) => (err ? reject(err) : resolve(res.body.result || res.body.error)));
  });
}

function post(port, key, route, body) {
  return new Promise((resolve, reject) => {
    request(`http://127.0.0.1:${port}`)
      .post(route)
      .set('X-CH-Key', key)
      .send(body || {})
      .end((err, res) => (err ? reject(err) : resolve({status: res.status, body: res.body})));
  });
}

// Poll an async or sync predicate every 200 ms until it returns a truthy
// value, which is resolved; reject with `label` after timeoutMs.
function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (async function attempt() {
      let value = null;
      try { value = await predicate(); } catch (e) { value = null; }
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(attempt, 200);
    })();
  });
}

module.exports = {ROOT, startServer, stopServer, mcpCall, post, waitFor};

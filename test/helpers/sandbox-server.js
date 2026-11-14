// Spawning and calling a countinghouse server for the module-sandbox tests
// (test/sandbox/). One place for the boilerplate the other server tests each
// carry their own copy of: spawn detached so the whole group can be killed,
// collect stdout so tests can look for `module sandbox:` lines, wait for the
// ready line, and talk MCP or plain HTTP to it.
const path    = require('path');
const spawn   = require('child_process').spawn;
const request = require('supertest');
const waitForReady = require('./wait-for-ready');
const {redisArgsFor} = require('./test-env');

const ROOT = path.join(__dirname, '..', '..');

// opts.expectExit: resolve as soon as the process exits instead of waiting
// for the ready line -- for startup-refusal tests. A server that starts
// instead is killed after 20 s, so a failing test does not leak it.
// opts.env: extra environment variables for the server.
// opts.cwd: the server's working directory (default: the repo root).
// opts.root: a countinghouse installed somewhere else (default: this repo).
function startServer(port, args, opts) {
  opts = opts || {};
  const root = opts.root || ROOT;
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath,
      [path.join(root, 'framework.js'), '--bindAddr', '127.0.0.1', '--port', String(port)].concat(args, redisArgsFor(args)),
      {cwd: opts.cwd || root,
       env: Object.assign({}, process.env, {NODE_PATH: path.join(root, 'lib')}, opts.env || {}),
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
    // A server that never got ready is stopped, so a boot failure cannot
    // leave it holding its port and taking the queue's jobs from the next
    // test's server (#72's hung CI run).
    waitForReady(server, (err) => {
      if (err == null) return resolve(server);
      stopServer(server);
      return reject(err);
    });
  });
}

// try/catch: the server may already be gone if an earlier step failed.
function stopServer(server) {
  if (server == null || server.pid == null) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
}

// An "unknown tool" answer throws, so a mistyped (or wrongly cased: tool
// names are lowercased) name fails the test that wrote it instead of passing
// silently. opts.allowUnknownTool: for tests that expect a tool to be missing.
function mcpCall(port, key, name, args, opts) {
  return new Promise((resolve, reject) => {
    request(`http://127.0.0.1:${port}`)
      .post('/mcp')
      .set('X-CH-Key', key)
      .set('Accept', 'application/json, text/event-stream')
      .send({jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: {name: name, arguments: args || {}}})
      .end((err, res) => {
        if (err) return reject(err);
        const answer = res.body.result || res.body.error;
        // Either shape: a JSON-RPC error, or a tools/call result with isError.
        const unknown = (res.body.error != null && /unknown tool/.test(String(res.body.error.message))) ||
          (res.body.result != null && res.body.result.isError === true && /unknown tool/.test(JSON.stringify(res.body.result.content || '')));
        if (unknown && !(opts && opts.allowUnknownTool)) {
          return reject(new Error(`mcpCall: unknown tool ${name} -- tool names are lowercase; pass {allowUnknownTool: true} if the test expects it missing`));
        }
        return resolve(answer);
      });
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
// describe: optional, async; on a timeout its answer is added to the error, so
// an intermittent failure reports the state it timed out in.
function waitFor(predicate, timeoutMs, label, describe) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (async function attempt() {
      let value = null;
      try { value = await predicate(); } catch (e) { value = null; }
      if (value) return resolve(value);
      if (Date.now() > deadline) {
        let state = '';
        if (describe != null) { try { state = `\n${await describe()}`; } catch (e) { state = `\n(could not describe: ${e.message})`; } }
        return reject(new Error(`timed out waiting for ${label}${state}`));
      }
      setTimeout(attempt, 200);
    })();
  });
}

module.exports = {ROOT, startServer, stopServer, mcpCall, post, waitFor, redisArgsFor};

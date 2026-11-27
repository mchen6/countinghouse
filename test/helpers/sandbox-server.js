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

// Every server startServer spawned, by pid, until it exits: {port, server}.
// A hook that fails while a start is still pending leaves its file without
// the server object (auth 42's before(), with Redis unreachable, 11-27), and a
// spawned server is detached, its own process group, so nothing else would
// stop it. stopAll() stops what is still here: a file's after() calls it,
// and so does this process's exit. A start on a port that a recorded server
// still holds stops that one first and says so (CI runs a folder in one
// mocha process, so an exit-time stop alone lets a leaked server hold its
// port while the later files run). Servers spawned other than through
// startServer are not covered.
const live = new Map();
function stopAll() {
  for (const pid of [...live.keys()]) {
    killTree(pid);
    live.delete(pid);
  }
}
process.on('exit', stopAll);
// (the recorded servers still on `port`, stopped; each waited for at most
// 5 s, so the port is free for the next start)
async function takeBackPort(port) {
  const stale = [...live.entries()].filter(([, e]) => e.port === port);
  await Promise.all(stale.map(([pid, e]) => new Promise((resolve) => {
    process.stderr.write(`sandbox-server: a server from an earlier start (pid ${pid}) still held port ${port}: stopped\n`);
    const done = setTimeout(resolve, 5000);
    e.server.once('exit', () => { clearTimeout(done); resolve(); });
    if (e.server.exitCode != null || e.server.signalCode != null) { clearTimeout(done); resolve(); }
    killTree(pid);
    live.delete(pid);
  })));
}

// opts.expectExit: resolve as soon as the process exits instead of waiting
// for the ready line -- for startup-refusal tests. A server that starts
// instead is killed after 20 s, so a failing test does not leak it.
// opts.env: extra environment variables for the server.
// opts.cwd: the server's working directory (default: the repo root).
// opts.root: a countinghouse installed somewhere else (default: this repo).
// opts.nodeArgs: node's own flags before framework.js (bin/countinghouse
// runs it with --expose-gc: the direct-peer-channels files, #234)
async function startServer(port, args, opts) {
  opts = opts || {};
  const root = opts.root || ROOT;
  await takeBackPort(port);
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath,
      (opts.nodeArgs || []).concat([path.join(root, 'framework.js'), '--bindAddr', '127.0.0.1', '--port', String(port)], args, redisArgsFor(args)),
      {cwd: opts.cwd || root,
       env: Object.assign({}, process.env, {NODE_PATH: path.join(root, 'lib')}, opts.env || {}),
       stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    live.set(server.pid, {port, server});
    server.once('exit', () => live.delete(server.pid));
    server.output = '';
    server.exitCode = null;
    server.stdout.on('data', (chunk) => { server.output += chunk.toString(); });
    server.stderr.on('data', (chunk) => { server.output += chunk.toString(); });
    if (opts.expectExit === true) {
      const timer = setTimeout(() => {
        stopServer(server);
        reject(new Error(`server did not exit; last output: ${server.output.slice(-2000)}`));
      }, opts.exitWithinMs != null ? opts.exitWithinMs : 20000);
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

// The server and what it started: by its process group on POSIX; on Windows
// (no groups, and a negative pid does nothing) taskkill's tree kill, so a
// stopped server never keeps answering on its port for the next case.
function killTree(pid) {
  if (process.platform === 'win32') {
    try { require('child_process').execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true}); } catch (e) { /* already gone */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* already gone */ }
}

// The server may already be gone if an earlier step failed.
function stopServer(server) {
  if (server == null || server.pid == null) return;
  killTree(server.pid);
  live.delete(server.pid);
}

// Asks the server to shut down (POST /shutdown, as an admin: key), waits at
// most waitMs for its answer, then stops it whatever happened: a server that
// hangs, throws or never answers is killed all the same (#234).
async function shutdownThenStop(server, port, key, {waitMs = 3000} = {}) {
  try {
    if (server != null && server.exitCode == null) {
      const asked = new Promise((resolve) => {
        let r = request(`http://127.0.0.1:${port}`).post('/shutdown');
        if (key != null) r = r.set('X-CH-Key', key);
        r.end(() => resolve());
      });
      await Promise.race([asked, new Promise((resolve) => setTimeout(resolve, waitMs).unref())]);
    }
  } catch (e) {
    // the stop below is what matters
  } finally {
    stopServer(server);
  }
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

module.exports = {ROOT, startServer, stopServer, stopAll, shutdownThenStop, mcpCall, post, waitFor, redisArgsFor};

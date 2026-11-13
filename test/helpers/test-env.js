// Where a server-starting test listens and which Redis its server uses, from
// the environment, so a test file can run on a shared machine without
// touching the shared Redis or another session's ports (reviewer,
// 2026-11-12). With neither variable set nothing changes, so CI is
// untouched.
//
//   CH_TEST_PORT_BASE=9740   each distinct default port this process asks
//                            for becomes base, base+1, ... in the order asked
//                            (local runs are one file at a time)
//   CH_TEST_REDIS_URL=redis://127.0.0.1:9749
//                            passed to every server as --redisUrl
//
// Servers are started in their own process group and stopped by PID, never
// by pkill -f: a pattern can match another session's server running the same
// test.
//
// startPrivateRedis() is for test/helpers/run-local.js only, never called by a
// test: a throwaway redis-server of the caller's own on 127.0.0.1, in a temp
// directory, with no persistence, stopped by PID (reviewer, 2026-11-12). It
// never touches a shared Redis or its data.
const {spawn} = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const BASE = process.env.CH_TEST_PORT_BASE != null && process.env.CH_TEST_PORT_BASE !== ''
  ? Number(process.env.CH_TEST_PORT_BASE) : null;
const assigned = new Map();

function testPort(defaultPort) {
  if (BASE == null || !Number.isInteger(BASE)) return defaultPort;
  if (!assigned.has(defaultPort)) assigned.set(defaultPort, BASE + assigned.size);
  return assigned.get(defaultPort);
}

const redisUrl = () => (process.env.CH_TEST_REDIS_URL != null && process.env.CH_TEST_REDIS_URL !== '' ? process.env.CH_TEST_REDIS_URL : null);
// For a shell command line: ' --redisUrl <url>' or ''.
const redisFlag = () => (redisUrl() != null ? ` --redisUrl ${redisUrl()}` : '');
// For an argument list: ['--redisUrl', url] or [].
const redisArgs = () => (redisUrl() != null ? ['--redisUrl', redisUrl()] : []);
// The --redisUrl a server start with arguments `args` gets: none when the
// test passes its own ("--redisUrl <url>" or "--redisUrl=<url>"; two would
// reach minimist as an array), none for --store local ("--store local" or
// "--store=local"), which keeps no Redis and refuses a --redisUrl ("choose
// one"), else redisArgs().
function redisArgsFor(args) {
  if (args.some((a) => a === '--redisUrl' || String(a).startsWith('--redisUrl='))) return [];
  const local = args.some((a, i) => a === '--store=local' || (a === '--store' && args[i + 1] === 'local'));
  return local ? [] : redisArgs();
}
// For a test's own Redis client: the same Redis as the servers it starts
// (CH_TEST_REDIS_URL when set), else the URL it used before. Without it, a
// test run through run-local.js would seed the shared Redis while its server
// read the private one.
const redisUrlFor = (fallback = 'redis://127.0.0.1:6379') => (redisUrl() != null ? redisUrl() : fallback);

const started = [];

// A shell command line (redirections and env prefixes as before), in a
// process group of its own; the child's stdout is piped as exec's was.
function startShell(command) {
  const child = spawn(command, {shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  child.on('error', () => { /* reported by the readiness wait */ });
  started.push(child);
  return child;
}

// Kill, by process group, every server this file started that is still up;
// then `done` after `delayMs` (the port's release).
function stopAll(done, delayMs = 0) {
  while (started.length > 0) {
    const child = started.pop();
    if (child.pid == null) continue;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
  }
  if (typeof done === 'function') setTimeout(done, delayMs);
}

// -> Promise<{url, pid, stop()}>. Refuses a port something already answers on:
// that is someone else's.
function startPrivateRedis({port = 9749, readyMs = 5000} = {}) {
  const answers = () => new Promise((resolve) => {
    const s = net.connect({host: '127.0.0.1', port});
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  return answers().then((taken) => {
    if (taken) throw new Error(`port ${port} already answers: not starting a Redis there`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-test-redis-'));
    const child = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', dir],
      {stdio: 'ignore'});
    let gone = false;
    child.on('exit', () => { gone = true; });
    const stop = () => {
      if (!gone) { try { process.kill(child.pid, 'SIGKILL'); } catch (e) { /* already gone */ } }
      fs.rmSync(dir, {recursive: true, force: true});
    };
    const deadline = Date.now() + readyMs;
    const wait = () => answers().then((up) => {
      if (up) return {url: `redis://127.0.0.1:${port}`, pid: child.pid, stop};
      if (gone || Date.now() > deadline) { stop(); throw new Error(`redis-server did not answer on ${port}`); }
      return new Promise((r) => setTimeout(r, 100)).then(wait);
    });
    return wait();
  });
}

module.exports = {testPort, redisFlag, redisArgs, redisArgsFor, redisUrlFor, startShell, stopAll, startPrivateRedis};

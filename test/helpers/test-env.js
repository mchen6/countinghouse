// Where a server-starting test listens and which Redis its server uses, from
// the environment, so a test file can run on a shared machine without
// touching the shared Redis or another session's ports (reviewer,
// 2026-11-12). With neither variable set nothing changes, so CI is
// untouched.
//
//   CH_TEST_PORT_BASE=9740   each distinct default port this process asks
//                            for becomes base, base+1, ... in the order asked
//                            (local runs are one file at a time)
//   CH_TEST_REDIS_URL=redis://127.0.0.1:<port>
//                            passed to every server as --redisUrl
//   CH_TEST_REDIS_PORT=<port>
//                            run-local's private Redis on this port, not a
//                            free one the OS picks
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

// Each test maps every port it uses here, once, by its default: the helpers
// (sandbox-server.js, remote-mcp-server.js) take ports as given, so the one
// mapping is the test's own and its URLs, Host headers and --port agree
// (validation 14 checks every server test for an unmapped port). The port
// of CH_TEST_REDIS_URL (run-local's private Redis, on a free port) is never
// handed out.
const reservedPort = (() => {
  try { return Number(new URL(process.env.CH_TEST_REDIS_URL).port) || null; } catch (e) { return null; }
})();
function testPort(defaultPort) {
  if (BASE == null || !Number.isInteger(BASE)) return defaultPort;
  if (!assigned.has(defaultPort)) {
    let next = BASE + assigned.size;
    const taken = new Set(assigned.values());
    if (reservedPort != null) taken.add(reservedPort);
    while (taken.has(next)) next++;
    assigned.set(defaultPort, next);
  }
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
// The same Redis as an object connection (BullMQ's), db `db`: the host
// without an IPv6 address's brackets, the URL's username and password, TLS
// for rediss:. run-local refuses a literal one.
const redisConnectionFor = (db) => {
  let u;
  try { u = new URL(redisUrlFor()); } catch (e) { u = null; }
  if (u == null || (u.protocol !== 'redis:' && u.protocol !== 'rediss:') || u.hostname === '') {
    throw new Error(`CH_TEST_REDIS_URL is not a redis:// or rediss:// URL with a host: ${redisUrlFor()}`);
  }
  const c = {host: u.hostname.replace(/^\[(.*)\]$/, '$1'), port: Number(u.port) || 6379, db};
  if (u.username !== '') c.username = decodeURIComponent(u.username);
  if (u.password !== '') c.password = decodeURIComponent(u.password);
  if (u.protocol === 'rediss:') c.tls = {};
  return c;
};

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
    if (process.platform === 'win32') {
      // no process groups: taskkill's tree kill (a negative pid does nothing)
      try { require('child_process').execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true}); } catch (e) { /* already gone */ }
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    }
  }
  if (typeof done === 'function') setTimeout(done, delayMs);
}

// -> Promise<{url, pid, stop()}>. Refuses a port something already answers on:
// that is someone else's.
// Its port: CH_TEST_REDIS_PORT when given, else a free one the OS picks, so
// each run's Redis is on a port of its own. A fixed port let a runtime
// leaked by an earlier run (its ioredis/BullMQ clients retry for ever)
// reconnect to the next run's fresh Redis and take its jobs (A and B,
// 2026-11-17: auth 25/33/34 and sandbox 32, "jobs never run").
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const {port} = srv.address(); srv.close(() => resolve(port)); });
});
function startPrivateRedis({port, readyMs = 5000} = {}) {
  const fixed = port != null ? port : (process.env.CH_TEST_REDIS_PORT != null && process.env.CH_TEST_REDIS_PORT !== '' ? Number(process.env.CH_TEST_REDIS_PORT) : null);
  return (fixed != null ? Promise.resolve(fixed) : freePort()).then((p) => startOn(p, readyMs));
}
function startOn(port, readyMs) {
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

// Whether testPort handed this port out in this process (the port guard,
// test/helpers/port-guard.js).
const handedOut = (port) => [...assigned.values()].includes(Number(port));

// Whether the Redis the servers a test starts use answers PING: the
// signal a step that needs a store takes, never the OS. Only a run that
// says it has no Redis may go without one: the Windows subset workflow
// (GITHUB_WORKFLOW, which Actions sets), or CH_TEST_NO_REDIS=1. Anywhere
// else a Redis that doesn't answer is an error, never a quiet skip.
// (A Redis needing auth or TLS answers as none: these tests use neither.)
const NO_REDIS_RUN = process.env.CH_TEST_NO_REDIS === '1' || process.env.GITHUB_WORKFLOW === 'Windows subset';
const redisAnswers = (timeoutMs = 1500) => new Promise((resolve, reject) => {
  const none = (why) => (NO_REDIS_RUN ? resolve(false) : reject(new Error(`no Redis answers PING (${why}); a run without one says so: CH_TEST_NO_REDIS=1`)));
  let c;
  try {
    const at = redisConnectionFor(0);
    c = require('net').connect({host: at.host, port: at.port});
  } catch (e) { none(e.message); return; }
  let got = '';
  const done = (ok, why) => { clearTimeout(timer); c.destroy(); if (ok) resolve(true); else none(why); };
  const timer = setTimeout(() => done(false, 'no answer in time'), timeoutMs);
  c.once('connect', () => c.write('PING\r\n'));
  c.on('data', (b) => { got += String(b); if (got.includes('\r\n')) done(got.startsWith('+PONG'), `answered ${JSON.stringify(got.slice(0, 40))}`); });
  c.once('error', (e) => done(false, e.code || e.message));
});

module.exports = {testPort, handedOut, redisFlag, redisArgs, redisArgsFor, redisUrlFor, redisConnectionFor, redisAnswers, startShell, stopAll, startPrivateRedis};

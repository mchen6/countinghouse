'use strict';
// run-local's runtime check (the reviewer, 2026-11-16): required by mocha
// (`--require`, test/helpers/run-local.js) into the TEST process only. While
// a private Redis is in use (CH_TEST_REDIS_URL names a port other than
// 6379), any TCP connect this process makes to the shared Redis -- port 6379
// on a loopback or unspecified host -- is refused: the socket errors with
// RUN_LOCAL_SHARED_REDIS, a line goes to stderr, and the run exits 2 even if
// the test swallows the error. It catches every form a source check cannot
// see: a multi-line call, a BullMQ Worker, a positional ioredis, 0.0.0.0 or
// 127.0.1.1. It never reaches a server the test spawns: nothing sets
// NODE_OPTIONS, so a spawned runtime's own sandbox refusal of 6379 is what
// a module there sees. A worker_thread has a net of its own, also untouched.
const net = require('net');

const url = process.env.CH_TEST_REDIS_URL;
const privatePort = (() => {
  try { return Number(new URL(url).port) || 6379; } catch (e) { return null; }
})();

function sharedHost(host) {
  if (host == null || host === '') return true;   // localhost by default
  const h = String(host).toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return h === 'localhost' || h === 'localhost.' || h === '0.0.0.0' || h === '::' || h === '::1' ||
    /^127\.\d+\.\d+\.\d+$/.test(h) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(h);
}

// the (port, host, path) of a connect's arguments, in each form net takes
function target(args) {
  let a = args;
  if (Array.isArray(a[0])) a = a[0];   // net's own normalized form
  const first = a[0];
  if (first != null && typeof(first) === 'object') return {port: first.port, host: first.host, path: first.path};
  if (typeof(first) === 'string' && !/^\s*\d+\s*$/.test(first)) return {path: first};
  return {port: first, host: typeof(a[1]) === 'string' ? a[1] : undefined};
}

if (privatePort != null && privatePort !== 6379) {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function(...args) {
    const t = target(args);
    if (t.path == null && Number(String(t.port).trim()) === 6379 && sharedHost(t.host)) {
      const where = `${t.host == null || t.host === '' ? 'localhost' : t.host}:6379`;
      process.stderr.write(`run-local: refused a connection to the shared Redis (${where}); this run's Redis is ${url}: use redisUrlFor() or redisConnectionFor() (test/helpers/test-env.js)\n`);
      process.exitCode = 2;
      process.once('exit', () => { process.exitCode = 2; });
      const e = new Error(`run-local: a connection to the shared Redis (${where}) refused`);
      e.code = 'RUN_LOCAL_SHARED_REDIS';
      process.nextTick(() => this.destroy(e));
      return this;
    }
    return connect.apply(this, args);
  };
}

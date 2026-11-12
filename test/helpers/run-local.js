#!/usr/bin/env node
'use strict';
// Runs one test file on a shared machine without touching its shared Redis
// or another session's ports (reviewer, 2026-11-12):
//
//   node test/helpers/run-local.js <test file> [mocha options]
//
// It sets CH_TEST_PORT_BASE (9740 unless given), starts a throwaway
// redis-server of its own on 127.0.0.1:9749 in a temp directory with no
// persistence (unless CH_TEST_REDIS_URL is already given), runs
// `mocha --exit <file>` with both, and stops that Redis by PID when mocha ends,
// whatever the outcome, Ctrl-C included. One file at a time.
const path = require('path');
const {spawn} = require('child_process');
const {startPrivateRedis} = require('./test-env');

const ROOT = path.join(__dirname, '..', '..');

// A test's own Redis client on a literal URL, or a bare createClient() (the
// shared Redis by default), would write the shared Redis while the servers
// read the private one: run-local redirects only the servers (reviewer,
// 2026-11-12, after test/auth/09). -> the offending lines; redisUrlFor() is
// the way. Comments, and a URL passed as a server argument, are not clients;
// a line ending "// run-local: not the shared Redis" (a client on a dead port)
// is let through.
const CLIENT = /\b(createClient|createResilientClient|new\s+Redis|new\s+RedisMeteringProvider|new\s+IORedis)\s*\(/;
function ownRedisClients(text) {
  return String(text).split('\n').filter((line) => {
    // A client deliberately on a port nobody answers says so.
    if (/\/\/ run-local: not the shared Redis/.test(line)) return false;
    // A comment starts at a // not preceded by ':' (so redis:// stays).
    const code = line.replace(/(^|[^:])\/\/.*$/, '$1');
    if (!CLIENT.test(code)) return false;
    return /['"`]redis:\/\//.test(code) || /createClient\(\s*\)/.test(code);
  });
}

// Run only when executed (node test/helpers/run-local.js <file>), never when
// required: a test requiring this file (validation/09 does) must not start a
// Redis or a mocha.
if (require.main === module) main();
module.exports = {ownRedisClients};

function main() {
const [file, ...rest] = process.argv.slice(2);
if (file == null) {
  process.stderr.write('usage: node test/helpers/run-local.js <test file> [mocha options]\n');
  process.exit(2);
}
let own = [];
try { own = ownRedisClients(require('fs').readFileSync(path.resolve(ROOT, file), 'utf8')); } catch (e) { /* unreadable: mocha will say */ }
if (own.length > 0) {
  process.stderr.write(`run-local: ${file} opens its own Redis client on a fixed URL, which would use the shared Redis; use redisUrlFor() (test/helpers/test-env.js):\n${own.map((l) => `  ${l.trim()}`).join('\n')}\n`);
  process.exit(2);
}

const env = {...process.env, CH_TEST_PORT_BASE: process.env.CH_TEST_PORT_BASE || '9740'};
const given = process.env.CH_TEST_REDIS_URL != null && process.env.CH_TEST_REDIS_URL !== '';

(given ? Promise.resolve(null) : startPrivateRedis()).then((redis) => {
  if (redis != null) env.CH_TEST_REDIS_URL = redis.url;
  const stop = () => { if (redis != null) redis.stop(); };
  const mocha = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js'), '--exit', file, ...rest],
    {cwd: ROOT, env, stdio: 'inherit'});
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { mocha.kill(sig); });
  mocha.on('exit', (code, signal) => {
    stop();
    process.exit(code != null ? code : (signal != null ? 1 : 0));
  });
}).catch((e) => {
  process.stderr.write(`run-local: ${e.message}\n`);
  process.exit(2);
});
}

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
const [file, ...rest] = process.argv.slice(2);
if (file == null) {
  process.stderr.write('usage: node test/helpers/run-local.js <test file> [mocha options]\n');
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

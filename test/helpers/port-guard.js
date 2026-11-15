// Under CH_TEST_PORT_BASE (test/helpers/run-local.js), no server a test
// spawns listens outside the run's block (#192). Loaded for every mocha run
// (.mocharc.json). With a base, it wraps child_process's spawn calls and
// refuses one whose --port is a test port (test/ports.md's 9500-9999) that
// testPort did not hand out (test/helpers/test-env.js). A port the OS
// assigned (listen(0), above that range) can't collide, and passes. Without
// a base (CI) it does nothing.
'use strict';
const BASE = process.env.CH_TEST_PORT_BASE;
const TEST_PORT = /^9[5-9]\d\d$/;

function portIn(args) {
  if (typeof(args) === 'string') {
    const m = /--port(?:=|\s+)(\S+)/.exec(args);
    return (m != null) ? m[1] : null;
  }
  if (!Array.isArray(args)) return null;
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--port') return (i + 1 < args.length) ? String(args[i + 1]) : null;
    const m = /^--port=(.*)$/.exec(a);
    if (m != null) return m[1];
  }
  return null;
}

function check(port) {
  if (port == null || !TEST_PORT.test(port)) return;
  if (!require('./test-env').handedOut(port)) {
    throw new Error(`port guard: a server spawned with --port ${port}, which testPort did not hand out under CH_TEST_PORT_BASE=${BASE}; map it with testPort (scripts/map-test-ports.js, #192)`);
  }
}

if (BASE != null && BASE !== '') {
  const cp = require('child_process');
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    const original = cp[name];
    cp[name] = function(file, args, ...rest) {
      check(portIn(Array.isArray(args) ? args : null));
      // spawn(command, {shell: true}) and the like: the command line itself
      if (!Array.isArray(args) && typeof(file) === 'string') check(portIn(file));
      return original.call(this, file, args, ...rest);
    };
  }
  for (const name of ['exec', 'execSync']) {
    const original = cp[name];
    cp[name] = function(command, ...rest) {
      check(portIn(String(command)));
      return original.call(this, command, ...rest);
    };
  }
}

module.exports = {portIn};

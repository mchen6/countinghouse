// Records the golden for 07-error-shape.js: every case of
// test/helpers/error-shape-cases.js, in each mode, against this tree.
//
//   node test/mcp-contract/capture-error-shape.js [outfile]
//
// Starts servers on ports 9658 and 9659 (and needs Redis, for tasks).
// Regenerate only when an error body is meant to change, and say so in the
// commit: the golden is what step 1 of the logger-and-errors spec must not
// move until it means to.
const fs   = require('fs');
const path = require('path');

// Guarded: this file sits in a directory mocha globs.
if (require.main !== module) {
  module.exports = {};
  return;
}

const {startServer, stopServer} = require('../helpers/sandbox-server');
const {runCases, MODES} = require('../helpers/error-shape-cases');

const ROOT    = path.join(__dirname, '..', '..');
const OUT     = process.argv[2] || path.join(__dirname, 'error-shape.golden.json');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'error-shape-module');
const AUTH    = path.join(__dirname, 'error-shape-auth.json');

(async () => {
  const golden = {};
  let port = 9658;
  for (const [mode, m] of Object.entries(MODES)) {
    const server = await startServer(port, m.flags.concat(['--authConfigPath', AUTH, '--loadModule', FIXTURE]));
    try { golden[mode] = await runCases(port, m.tasks); } finally { stopServer(server); }
    port++;
  }
  fs.writeFileSync(OUT, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

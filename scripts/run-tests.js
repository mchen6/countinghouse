#!/usr/bin/env node
'use strict';
// Runs the test runs listed in test/folders.json, in order, stopping at the
// first that fails, as the old `a && b && ...` script line did. `npm test`
// runs every run; ci.yml's functional step runs `--ci`, which leaves out the
// runs marked "ci": false. One list, so adding a folder is one line in one
// file (reviewer, 2026-11-12).
const path = require('path');
const {spawnSync} = require('child_process');

const ROOT = path.join(__dirname, '..');
const MOCHA = path.join(ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js');

// -> the runs to do, each {files, exit} or {npm}.
function plan({ci = false} = {}) {
  const {runs} = require(path.join(ROOT, 'test', 'folders.json'));
  return runs.filter((r) => !(ci && r.ci === false)).map((r) => (r.npm != null ? {npm: r.npm} : {files: r.files, exit: r.exit === true}));
}

function main(argv) {
  const ci = argv.includes('--ci');
  for (const run of plan({ci})) {
    const [cmd, args] = run.npm != null
      ? [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', run.npm]]
      : [process.execPath, [MOCHA, ...(run.exit ? ['--exit'] : []), ...run.files]];
    process.stdout.write(`\n> ${run.npm != null ? `npm run ${run.npm}` : `mocha ${run.exit ? '--exit ' : ''}${run.files.join(' ')}`}\n`);
    const r = spawnSync(cmd, args, {cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' && run.npm != null});
    if (r.status !== 0) return r.status == null ? 1 : r.status;
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {plan};

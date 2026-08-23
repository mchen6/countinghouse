#!/usr/bin/env node
// Validate a countinghouse module directory without starting a server.
//
//   countinghouse-validate ./my-module
//   countinghouse-validate --json ./my-module
//
// Exit codes are the contract: 0 clean, 1 problems found, 2 could not look.
// Anything reading this programmatically -- CI, an agent -- keys off those.
//
// --json is what lib/mcp/gateway.js's countinghouse_validate_module tool
// spawns this file with (see its validateModuleInChildProcess): a fresh
// process per call, so a module under test can't leave a stale require()
// cache for the next validate, and a process.exit() in the module under
// test only takes down this child, not the gateway. See docs/design-
// decisions.md-adjacent Task 8 notes for the fuller rationale. Without
// --json this file's human-readable output is unchanged from before that
// tool existed -- the CLI's own tests assert on it byte-for-byte.
const path = require('path');

require(path.join(__dirname, '..', 'lib', 'cli-options')).setOptions({});
const moduleValidator = require(path.join(__dirname, '..', 'lib', 'module-validator'));

const rawArgs  = process.argv.slice(2);
const jsonMode = rawArgs.indexOf('--json') !== -1;
const target   = rawArgs.filter((a) => a !== '--json')[0];

if (target == null || target === '' || target === '-h' || target === '--help') {
  console.log('usage: countinghouse-validate <module-directory>');
  console.log('');
  console.log('Checks api.json, schema.json and the handler map against each other.');
  console.log('Exit codes: 0 = ok, 1 = problems found, 2 = path unusable.');
  process.exit(2);
}

moduleValidator.validateModule(target, (err, result) => {
  if (err != null) {
    if (jsonMode) {
      // Same shape questions apply here as below: one line of JSON on
      // stdout, nothing else, so a caller spawning this file never has to
      // distinguish "no output" from "output on the wrong stream".
      console.log(JSON.stringify({error: err.message}));
      process.exit(2);
    }
    console.error(`countinghouse-validate: ${err.message}`);
    process.exit(2);
  }

  if (jsonMode) {
    console.log(JSON.stringify(result));
    process.exit(result.ok === true ? 0 : 1);
  }

  if (result.ok === true) {
    console.log(`ok: ${result.module} -- no problems found`);
    process.exit(0);
  }

  console.log(`${result.module}: ${result.problems.length} problem(s)`);
  result.problems.forEach((p) => {
    console.log(`  [${p.stage}] ${p.message}`);
    if (p.fix != null) console.log(`      fix: ${p.fix}`);
  });
  process.exit(1);
});

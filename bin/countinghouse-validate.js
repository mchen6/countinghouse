#!/usr/bin/env node
// Validate a countinghouse module directory without starting a server.
//
//   countinghouse-validate ./my-module
//
// Exit codes are the contract: 0 clean, 1 problems found, 2 could not look.
// Anything reading this programmatically -- CI, an agent -- keys off those.
const path = require('path');

require(path.join(__dirname, '..', 'lib', 'cli-options')).setOptions({});
const moduleValidator = require(path.join(__dirname, '..', 'lib', 'module-validator'));

const target = process.argv[2];

if (target == null || target === '' || target === '-h' || target === '--help') {
  console.log('usage: countinghouse-validate <module-directory>');
  console.log('');
  console.log('Checks api.json, schema.json and the handler map against each other.');
  console.log('Exit codes: 0 = ok, 1 = problems found, 2 = path unusable.');
  process.exit(2);
}

moduleValidator.validateModule(target, (err, result) => {
  if (err != null) {
    console.error(`countinghouse-validate: ${err.message}`);
    process.exit(2);
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

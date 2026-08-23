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
// test only takes down this child, not the gateway. Without --json this
// file's human-readable output is unchanged from before that tool existed
// -- the CLI's own tests assert on it byte-for-byte.
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

// validateModule requires the module under test (loadExported,
// resolveHandlerMap) -- ordinary module code, not just adversarial code, can
// write to stdout while doing that (a startup log line, a dependency's
// deprecation notice). In --json mode that would land in the middle of the
// one line of JSON this file promises to be the caller's only signal, so
// process.stdout.write is captured for the DURATION of the validateModule
// call and restored before the JSON line (or the {error} line) is printed.
// Whatever the module wrote is not discarded -- it goes to stderr instead,
// which is more useful to a human running this by hand than silently
// dropping it, and doesn't touch the machine-readable channel either way.
//
// This only catches writes that go through process.stdout.write (console.log
// included). A module using fs.writeSync(1, ...) writes straight to the file
// descriptor and bypasses this capture entirely -- lib/mcp/gateway.js's
// parseValidateChildOutput covers that remaining gap by scanning for the
// last line of the child's stdout that parses as JSON, rather than trusting
// the whole stream to be clean.
function captureStdout() {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk, encoding, cb) => {
    captured += Buffer.isBuffer(chunk) ? chunk.toString(typeof(encoding) === 'string' ? encoding : 'utf8') : String(chunk);
    const doneCb = (typeof(encoding) === 'function') ? encoding : cb;
    if (typeof(doneCb) === 'function') doneCb();
    return true;
  };
  return () => {
    process.stdout.write = originalWrite;
    return captured;
  };
}

// non-JSON mode is left entirely untouched -- no capture, no restore, same
// console.log/console.error calls as before --json ever existed.
const restoreStdout = jsonMode ? captureStdout() : null;

moduleValidator.validateModule(target, (err, result) => {
  const strayOutput = (restoreStdout != null) ? restoreStdout() : null;
  if (strayOutput) process.stderr.write(strayOutput);

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

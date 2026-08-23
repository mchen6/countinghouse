// Deliberately-noisy-but-otherwise-clean fixture for the review-round fix to
// Task 8's --json channel: a main entry that writes to stdout during
// require() -- a startup log line, or a dependency's own deprecation notice
// -- which is ordinary module code, not adversarial. Before this fix, that
// line landed ahead of bin/countinghouse-validate.js --json's own JSON
// result line, so lib/mcp/gateway.js's parseValidateChildOutput could not
// JSON.parse the combined stdout and reported a spurious
// validateModuleChildProcess problem for a module that is actually clean.
//
// Otherwise identical to test/fixtures/handler-map-convention/ -- same
// api.json, schema.json and handlers/ tree -- so the only thing this fixture
// exercises is the stray stdout write, not any other validator check.
console.log('hello from module load time, before the validator\'s own JSON line');
module.exports = {};

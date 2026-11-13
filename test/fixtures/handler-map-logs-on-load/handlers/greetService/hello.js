// Deliberately-noisy-but-otherwise-clean fixture for the review-round fix to
// Task 8's --json channel: module code that writes to stdout while it is
// being required -- a startup log line, or a dependency's own deprecation
// notice -- which is ordinary module code, not adversarial. It is in a
// handler file because a main entry is never run (lib/module-layout.js).
// Before the fix, the line landed ahead of bin/countinghouse-validate.js
// --json's own JSON result line, so lib/mcp/gateway.js's
// parseValidateChildOutput could not JSON.parse the combined stdout and
// reported a spurious validateModuleChildProcess problem for a clean module.
//
// Otherwise identical to test/fixtures/handler-map-convention/.
console.log('hello from module load time, before the validator\'s own JSON line');

module.exports = async (input, ctx) => ({
  output: {text: `hello ${input.name}`, caller: ctx.caller.apiKey}
});

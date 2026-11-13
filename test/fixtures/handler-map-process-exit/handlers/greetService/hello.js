// Deliberately-broken fixture for Task 8's defect B: module code that calls
// process.exit() while it is being required, rather than throwing. A main
// entry is never run (lib/module-layout.js, the one module format), so the
// code is here, in a handler file, which countinghouse-validate and every
// load require. When that require terminates the process instead of
// returning or throwing, no try/catch in the process survives it; if it ran
// inside the main gateway process, it would take the whole server down
// instead of being reported as a problem with this one module. See
// lib/mcp/gateway.js's validateModuleInChildProcess, which makes it fatal
// only to the disposable child running bin/countinghouse-validate.js.
process.exit(1);

module.exports = async (input, ctx) => ({
  output: {text: `hello ${input.name}`, caller: ctx.caller.apiKey}
});

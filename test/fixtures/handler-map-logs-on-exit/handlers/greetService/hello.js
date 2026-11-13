// Regression fixture for the final-review fix to lib/mcp/gateway.js's
// parseValidateChildOutput: module code that prints JSON at process EXIT
// time, not while it is required -- structurally different from
// ../handler-map-logs-on-load/'s load-time console.log, and not something
// the CLI's own stdout capture can cover. In a handler file because a main
// entry is never run (lib/module-layout.js).
//
// bin/countinghouse-validate.js's captureStdout() only intercepts
// process.stdout.write for the duration of the validateModule call, and
// restores it before printing its own --json result line. Anything a module
// prints after that but before the child exits -- here, a
// process.on('exit', ...) handler -- lands after the CLI's real JSON result
// line. Before the fix, scanning from the end of stdout for "the last line
// that parses as JSON" found this line instead of the result; the fix
// requires that line to be shaped like the CLI's contract ({ok, ...} or
// {error}).
process.on('exit', () => {
  console.log(JSON.stringify({shutdown: 'clean', handled: 0}));
});

module.exports = async (input, ctx) => ({
  output: {text: `hello ${input.name}`, caller: ctx.caller.apiKey}
});

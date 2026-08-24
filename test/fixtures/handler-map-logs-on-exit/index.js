// Regression fixture for the final-review fix to lib/mcp/gateway.js's
// parseValidateChildOutput: a main entry that prints JSON at process EXIT
// time, not at require() time -- structurally different from ../handler-map-
// logs-on-load/'s load-time console.log, and not something the CLI's own
// stdout capture can ever cover.
//
// bin/countinghouse-validate.js's captureStdout() only intercepts
// process.stdout.write for the DURATION of the validateModule call, and
// restores the real process.stdout.write BEFORE printing its own --json
// result line (so that result line itself isn't captured and swallowed).
// That ordering leaves a window: anything a module prints after the
// validator has finished but before the child process actually exits --
// here, a process.on('exit', ...) handler -- lands on stdout AFTER the
// CLI's real JSON result line, not before it. Before the parseValidateChildOutput
// fix, scanning from the end of stdout for "the last line that parses as
// JSON" found THIS line instead of the real result, because a bare
// {shutdown: 'clean', handled: 0} object parses as JSON just fine -- it is
// simply not the validator's result. The fix requires the last-parseable
// line to also be shaped like the CLI's actual contract ({ok, ...} or
// {error}) before accepting it.
process.on('exit', () => {
  console.log(JSON.stringify({shutdown: 'clean', handled: 0}));
});

module.exports = {};

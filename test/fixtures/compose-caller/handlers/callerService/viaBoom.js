module.exports = async (input, ctx) => {
  try {
    await ctx.call('compose-callee/calleeService.boom', {});
  } catch (err) {
    // Task 6 (test/composition/04-failure-and-billing.js) observability
    // hook, not a behavior change: this handler still fails the call by
    // rethrowing below. It exists because ctx.call's own `.fault` (set in
    // lib/handler-ctx.js, right where the rejection is built) never reaches
    // an MCP client to observe from the outside -- lib/mcp/gateway.js's
    // toolCallResult reads only `err.message`/`err.code`, and both
    // lib/service.js's Service.prototype.doActionCall (this handler's own
    // outer rejection) and lib/device-manager.js's cross-worker reply
    // relays (e.g. `new DeviceError(err.code != null ? err.code : err.
    // message)`) rebuild a fresh error from just a `code` whenever one is
    // present, discarding any detail carried only in `.message` -- so
    // trying to smuggle the observation back out through a rethrown
    // error's own `.message` does not survive either (tried first; the
    // outer dispatch's own `err.code != null` rebuild in device-manager.js
    // erases it every time). Printed to stdout instead, from the one place
    // that still has the unmodified value. This requires the server under
    // test to run with --debug: outside --debug,
    // lib/countinghouse-util.js's loadFile rebinds every handler file's own
    // `console` to a set of no-ops before executing it ("drop console
    // under release mode"), so a plain console.log here would otherwise be
    // silently swallowed (confirmed by hand). Worker threads share the
    // spawned process's stdout by default (no `stdout: true` option is
    // passed anywhere `new Worker(...)` is called in this codebase -- see
    // lib/module-manager.js), so under --debug this shows up in
    // `server.stdout`, which the test captures.
    console.log(`CTX_CALL_FAULT ${JSON.stringify({
      fault:    (err != null && err.fault !== undefined) ? err.fault : null,
      code:     (err != null && err.code !== undefined) ? err.code : null,
      ctorName: (err != null && err.constructor != null) ? err.constructor.name : null
    })}`);
    throw err;
  }
  return {output: {n: 0}};
};

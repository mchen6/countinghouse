// Calls compose-callee (composition 25 unloads it first) and rethrows the typed
// refusal ctx.call rejected with, as its own failure: the code crosses back in
// its reply, which the main thread must never note as its own refusal.
module.exports = async (input, ctx) => {
  try {
    await ctx.call('compose-callee/calleeService.double', {n: 2});
  } catch (e) {
    throw e;
  }
  return {output: {}};
};

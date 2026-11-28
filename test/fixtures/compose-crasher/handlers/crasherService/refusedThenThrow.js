// Its call is refused by the runtime (composition 25 unloads the callee
// first), and it then throws an untyped error: the caller gets
// DEVICE_INVOKE_EXCEPTION, which says what the runtime refused before it.
module.exports = async (input, ctx) => {
  try {
    await ctx.call('compose-callee/calleeService.double', {n: 2});
  } catch (e) {
    throw new Error(`the call failed: ${e && e.code}`);
  }
  return {output: {}};
};

// This module declares no "countinghouse.calls", so verifyComposition has
// nothing to bind for it -- its documented early return. The point of the
// fixture is that "nothing to bind" is still a verdict that has to be
// delivered: without it, this call would sit in the startup window forever
// and report CTX_CALL_NOT_READY on a server that finished starting long ago.
module.exports = async (input, ctx) => {
  await ctx.call('compose-callee/calleeService.double', {n: 21});
  return {output: {n: 0}};
};

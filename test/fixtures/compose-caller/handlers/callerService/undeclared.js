// Calls an address this module did not declare. The point is that the
// declaration is enforced -- ctx.call must refuse this before it ever tries
// to resolve the target.
module.exports = async (input, ctx) => {
  await ctx.call('compose-callee/calleeService.triple', {});
  return {output: {n: 0}};
};

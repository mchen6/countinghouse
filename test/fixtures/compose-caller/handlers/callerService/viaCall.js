module.exports = async (input, ctx) => {
  // ctx.call resolves with the callee's raw invoke result, which is the
  // 6.0.0 handler-return shape ({output: ...}), not the unwrapped output --
  // same as any other ServiceClient.invoke caller sees.
  const data = await ctx.call('compose-callee/calleeService.double', {n: input.n});
  return {output: {n: data.output.n}};
};

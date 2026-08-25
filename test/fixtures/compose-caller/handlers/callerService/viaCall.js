module.exports = async (input, ctx) => {
  const data = await ctx.call('compose-callee/calleeService.double', {n: input.n});
  return {n: data.n};
};

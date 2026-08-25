module.exports = async (input, ctx) => {
  await ctx.call('compose-callee/calleeService.boom', {});
  return {output: {n: 0}};
};

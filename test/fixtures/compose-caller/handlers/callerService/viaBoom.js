module.exports = async (input, ctx) => {
  const data = await ctx.call('compose-callee/calleeService.boom', {});
  return {n: 0, data: data};
};

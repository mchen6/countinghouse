module.exports = async (input, ctx) => {
  await ctx.call('worker-end/endService.failCatalogue', {});
  return {output: {}};
};

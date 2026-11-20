// progress-outer fixture (M21): see test/mcp-contract/14-handler-progress-e2e.js
module.exports = async (input, ctx) => {
  await ctx.call('progress-part/partService.work', {});
  await ctx.call('progress-part/partService.work', {});
  return {output: {done: true}};
};

// progress-outer fixture (M21): see test/mcp-contract/14-handler-progress-e2e.js
module.exports = async (input, ctx) => {
  ctx.job.progress(20);
  await ctx.call('progress-part/partService.work', {});
  return {output: {done: true}};
};

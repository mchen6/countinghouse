// progress-outer fixture (M21): see test/mcp-contract/14-handler-progress-e2e.js
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async (input, ctx) => {
  await ctx.call('progress-part/partService.work', {});
  await ctx.call('progress-part/partService.work', {});
  await wait(300);
  ctx.job.progress(25);
  await wait(300);
  return {output: {done: true}};
};

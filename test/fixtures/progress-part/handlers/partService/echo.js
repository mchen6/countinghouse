// progress-part fixture (M21): see test/mcp-contract/13 and 14
module.exports = async (input, ctx) => {
  ctx.job.progress(50);
  return {output: input};
};

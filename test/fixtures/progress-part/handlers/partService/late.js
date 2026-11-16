// progress-part fixture (M21): see test/mcp-contract/14-handler-progress-e2e.js
module.exports = async (input, ctx) => {
  setTimeout(() => ctx.job.progress(50), 100);
  return {output: {done: true}};
};

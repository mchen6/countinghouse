// progress-part fixture (M21): see test/mcp-contract/14-handler-progress-e2e.js
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async (input, ctx) => {
  for (const n of [-1, 101, NaN, Infinity, '50', null]) ctx.job.progress(n);
  await wait(300);
  return {output: {done: true}};
};

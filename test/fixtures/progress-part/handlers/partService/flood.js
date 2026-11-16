// progress-part fixture (M21): see test/mcp-contract/14-handler-progress-e2e.js
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = async (input, ctx) => {
  for (let i = 0; i < 100000; i++) ctx.job.progress((i / 100000) * 100);
  await wait(600);
  return {output: {done: true}};
};

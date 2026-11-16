// m19-outer fixture (M19): see test/mcp-contract/19-cancel-e2e.js
module.exports = async (input, ctx) => {
  for (let i = 0; i < 5; i++) await ctx.call('m19-part/partService.slow', {});
  return {output: {done: true}};
};

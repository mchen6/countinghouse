// m6-outer fixture (M6): see test/mcp-contract/16-resources-read.js
module.exports = async (input, ctx) => {
  const r = await ctx.call('m6-part/partService.pdf', {});
  return {output: {doc: r.output.doc}};
};

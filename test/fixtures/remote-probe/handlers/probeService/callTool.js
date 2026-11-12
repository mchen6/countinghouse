// callTool.js -- ctx.call('remote:probe/<input.tool>', input.args): the
// CallToolResult as {result}, or the rejection as {code, message}.
module.exports = async (input, ctx) => {
  try {
    return {output: {result: await ctx.call(`remote:probe/${input.tool}`, input.args)}};
  } catch (e) {
    return {output: {code: String(e.code), message: String(e.message)}};
  }
};

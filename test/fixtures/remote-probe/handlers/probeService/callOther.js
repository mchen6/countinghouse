// callOther.js -- ctx.call('remote:<input.remote>/<input.tool>'): a remote
// this module did not declare.
module.exports = async (input, ctx) => {
  try {
    return {output: {result: await ctx.call(`remote:${input.remote}/${input.tool}`, {})}};
  } catch (e) {
    return {output: {code: String(e.code), message: String(e.message)}};
  }
};

// callProbe.js -- ctx.call('remote:probe/echo_text') from a module that
// declares no remote: another module's remote is not reachable by its name.
module.exports = async (input, ctx) => {
  try {
    return {output: {result: await ctx.call('remote:probe/echo_text', {})}};
  } catch (e) {
    return {output: {code: String(e.code), message: String(e.message)}};
  }
};

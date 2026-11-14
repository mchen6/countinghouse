// callThenUsage.js -- ctx.call('remote:probe/echo_text', input.args)
// input.times times, then ctx.usage() (the current call's counts so far):
// {usage} or {code, message}.
module.exports = async (input, ctx) => {
  try {
    for (let i = 0; i < (input.times || 0); i++) await ctx.call('remote:probe/echo_text', input.args || {});
    return {output: {usage: await ctx.usage()}};
  } catch (e) {
    return {output: {code: String(e.code), message: String(e.message)}};
  }
};

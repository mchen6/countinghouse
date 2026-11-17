// Asks first, acts after, from inside a task (MCP completeness M22). Each
// pass counts itself; afterMs holds the answered pass, so a cancel can
// arrive while it runs. With no one to ask it says so in its result.
let runs = 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async (input, ctx) => {
  runs += 1;
  try {
    const answer = await ctx.ask('confirm', {what: input.what});
    if (input.afterMs > 0) await wait(input.afterMs);
    return {output: {asked: true, answer: answer, runs: runs}};
  } catch (e) {
    if (e.code === 'ASK_UNAVAILABLE') return {output: {asked: false, code: e.code, runs: runs}};
    throw e;
  }
};

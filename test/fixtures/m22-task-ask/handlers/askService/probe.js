// Asks first, acts after, from inside a task (MCP completeness M22). Each
// pass counts itself; afterMs holds the answered pass, so a cancel can
// arrive while it runs; beforeMs holds each pass before it asks, so a
// listen can open first (mcp-contract 37); values, its answered pass's
// progress. With no one to ask it says so in its result.
let runs = 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async (input, ctx) => {
  runs += 1;
  try {
    if (input.beforeMs > 0) await wait(input.beforeMs);
    const answer = await ctx.ask('confirm', {what: input.what});
    // the answered pass reports input.values as its progress, gapMs apart: a
    // listen opened before the answer sees every one (mcp-contract 37's
    // progress case, the high review of #433, 4)
    for (const v of (input.values || [])) {
      ctx.job.progress(v);
      if (input.gapMs > 0) await wait(input.gapMs);
    }
    if (input.afterMs > 0) await wait(input.afterMs);
    return {output: {asked: true, answer: answer, runs: runs}};
  } catch (e) {
    if (e.code === 'ASK_UNAVAILABLE') return {output: {asked: false, code: e.code, runs: runs}};
    throw e;
  }
};

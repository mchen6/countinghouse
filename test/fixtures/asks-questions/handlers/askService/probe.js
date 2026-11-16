// Asks first, acts after. With no one to ask it says so in its result; a
// pending question's ASK_PENDING passes, as a handler should let it.
let runs = 0;

module.exports = async (input, ctx) => {
  runs += 1;
  try {
    const answer = await ctx.ask('confirm', {what: input.what});
    return {output: {asked: true, answer: answer, runs: runs}};
  } catch (e) {
    if (e.code === 'ASK_UNAVAILABLE') return {output: {asked: false, code: e.code, runs: runs}};
    throw e;
  }
};

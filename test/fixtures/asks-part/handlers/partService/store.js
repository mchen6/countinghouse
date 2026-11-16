// Asks first, acts after. With no one to ask it says so in its result; a
// pending question's ASK_PENDING passes, as a handler should let it.
module.exports = async (input, ctx) => {
  try {
    const answer = await ctx.ask('overwrite', {id: input.id});
    return {output: {asked: true, answer: answer}};
  } catch (e) {
    if (e.code === 'ASK_UNAVAILABLE') return {output: {asked: false, code: e.code}};
    throw e;
  }
};

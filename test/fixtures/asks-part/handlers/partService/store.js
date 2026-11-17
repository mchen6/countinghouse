// Asks first, acts after. With no one to ask it says so in its result; a
// pending question's ASK_PENDING passes, as a handler should let it.
// wait (ms): it works a while before it asks. What its ask threw is kept
// in its own /data (one code a line), so a test can see what the part saw.
const fs = require('fs');
module.exports = async (input, ctx) => {
  if (Number.isInteger(input.wait) && input.wait > 0) await new Promise((r) => setTimeout(r, input.wait));
  try {
    const answer = await ctx.ask('overwrite', {id: input.id});
    return {output: {asked: true, answer: answer}};
  } catch (e) {
    try { fs.appendFileSync('/data/ask-codes', `${e.code}\n`); } catch (_) { /* its record only */ }
    if (e.code === 'ASK_UNAVAILABLE') return {output: {asked: false, code: e.code}};
    throw e;
  }
};

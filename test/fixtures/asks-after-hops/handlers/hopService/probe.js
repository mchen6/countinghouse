// Calls its part input.hops times at once, then asks. (A handler should ask
// first and act after; this one is the other order on purpose: the hops are
// what a call's progress counts, and the question ends the pass.)
module.exports = async (input, ctx) => {
  const parts = await Promise.all(Array.from({length: input.hops}, (unused, i) => ctx.call('compose-callee/calleeService.double', {n: i + 1})));
  const sum = parts.reduce((total, p) => total + p.output.n, 0);
  try {
    const answer = await ctx.ask('go', {hops: input.hops});
    return {output: {asked: true, answer: answer, sum: sum}};
  } catch (e) {
    if (e.code === 'ASK_UNAVAILABLE') return {output: {asked: false, sum: sum}};
    throw e;
  }
};

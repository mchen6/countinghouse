// askThenPeek.js -- asks first, from inside a task (M22); the run after the
// answer, which the runtime starts again from the record it held, scans what
// it can reach.
const view = require('../../view');

module.exports = async (input, ctx) => {
  const answer = await ctx.ask('confirm', {});
  return {output: Object.assign({answer: answer}, view(input, ctx))};
};

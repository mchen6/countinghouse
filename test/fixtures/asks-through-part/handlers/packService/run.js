// Calls its part, which asks. mode "pass" (the default) lets the part's
// pending question pass, as an outer handler should; "catch" catches it
// and returns a result of its own, and the question is then dropped.
module.exports = async (input, ctx) => {
  if (input.mode === 'catch') {
    try {
      await ctx.call('asks-part/partService.store', {id: input.id});
    } catch (e) {
      return {output: {caught: String(e.code)}};
    }
    return {output: {caught: 'nothing'}};
  }
  const got = await ctx.call('asks-part/partService.store', Object.assign({id: input.id}, Number.isInteger(input.wait) ? {wait: input.wait} : {}));
  return {output: {part: got.output}};
};

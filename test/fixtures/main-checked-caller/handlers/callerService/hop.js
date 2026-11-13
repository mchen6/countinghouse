// What a ctx.call to main-checked answered: its result, or the rejection's
// code (test/sandbox/41).
module.exports = async (input, ctx) => {
  try {
    const result = await ctx.call(`main-checked/checkService.${input.action}`, input.args);
    return {output: {result: result}};
  } catch (e) {
    return {output: {code: e.code != null ? e.code : null}};
  }
};

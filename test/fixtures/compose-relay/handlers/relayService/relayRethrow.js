// Calls compose-rethrower, then throws an untyped error of its own (composition 25).
module.exports = async (input, ctx) => {
  try {
    await ctx.call('compose-rethrower/rethrowService.rethrow', {});
  } catch (e) {
    throw new Error('the relay failed');
  }
  return {output: {}};
};

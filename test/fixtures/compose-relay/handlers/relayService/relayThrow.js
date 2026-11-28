// Calls compose-crasher, which fails after the runtime refused its own call
// (composition 25 unloads compose-callee first), and then throws an untyped
// error of its own: the user's answer does not say that refusal, made two
// calls down (the sentence covers only the failing module's own calls).
module.exports = async (input, ctx) => {
  try {
    await ctx.call('compose-crasher/crasherService.refusedThenThrow', {});
  } catch (e) {
    throw new Error(`the relay failed: ${e && e.message}`);
  }
  return {output: {}};
};

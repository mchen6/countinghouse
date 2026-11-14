// What hop-input-callee's sink answered for an input of n characters, or
// for a wrong input (a number where a string is due), or the rejection's
// code and message (test/sandbox/47).
module.exports = async (input, ctx) => {
  const args = input.wrong === true ? {s: input.n} : {s: 'x'.repeat(input.n)};
  try {
    return {output: {result: await ctx.call('hop-input-callee/sinkService.sink', args)}};
  } catch (e) {
    return {output: {code: e.code != null ? e.code : null, message: String(e.message)}};
  }
};

// The hop's refusal, reported as this call's output, so the test reads the
// code and text the calling module sees.
module.exports = async (input, ctx) => {
  try {
    await ctx.call('not-json-callee/bytesService.bytes', {});
    return {output: {code: null, message: 'the hop was answered'}};
  } catch (err) {
    return {output: {code: err.code != null ? String(err.code) : null, message: String(err.message)}};
  }
};

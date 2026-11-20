module.exports = async (input, ctx) => ({output: await ctx.call('hop-input-callee/sinkService.count', {})});

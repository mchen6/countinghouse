module.exports = async (input, ctx) => ({output: {caller: (ctx != null) ? ctx.caller : null, ctxKeys: ctx != null ? Object.keys(ctx).sort() : null}});

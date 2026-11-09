// viaCall.js -- a peer hop into key-dump's dump, and this composing module's
// own view: it is bound to an internal identity (runsModules).
const scan = require('../../scan');
module.exports = async (input, ctx) => {
  const answered = await ctx.call('key-dump/dumpService.dump', {reversed: input.reversed});
  const callee = (answered != null && answered.output != null) ? answered.output : answered;
  const roots = {ctx: ctx, globalThis: globalThis};
  Object.keys(require.cache).forEach((k) => {
    const entry = require.cache[k];
    if (entry != null) roots[`require.cache[${k.slice(k.lastIndexOf('/') + 1)}]`] = entry.exports;
  });
  const r = scan(roots, input.reversed, ['redisUrl']);
  return {output: {callee: callee, self: {caller: ctx.caller, hitCount: r.hits.length, hits: r.hits.slice(0, 40),
    accessorCount: r.accessors.length, accessors: r.accessors.slice(0, 200), budgetExhausted: r.budgetExhausted,
    depthCapped: r.depthCapped, visited: r.visited}}};
};

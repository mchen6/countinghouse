// dump.js -- what this module can reach, searched for the needles the test
// passes in (input.reversed: keys, user names and 'redis://', each reversed).
const scan = require('../../scan');
module.exports = async (input, ctx) => {
  const roots = {ctx: ctx, globalThis: globalThis};
  // The worker's whole runtime is reachable through require.cache (shared
  // with module code): every loaded file's exports.
  Object.keys(require.cache).forEach((k) => {
    const entry = require.cache[k];
    if (entry != null) roots[`require.cache[${k.slice(k.lastIndexOf('/') + 1)}]`] = entry.exports;
  });
  if (ctx != null && ctx.job != null && typeof ctx.job.info === 'function') {
    roots.jobInfo = await new Promise((ok) => ctx.job.info((e, job) => ok(e != null ? null : job)));
  }
  if (ctx != null && typeof ctx.recordUsage === 'function') {
    roots.recordUsage = await new Promise((ok) => ctx.recordUsage('key-dump', 0, (e, r) => ok(e != null ? null : r)));
  }
  const r = scan(roots, input.reversed, ['redisUrl']);
  return {output: {caller: (ctx != null) ? ctx.caller : null, hitCount: r.hits.length, hits: r.hits.slice(0, 40),
    accessorCount: r.accessors.length, accessors: r.accessors.slice(0, 200), budgetExhausted: r.budgetExhausted,
    depthCapped: r.depthCapped, visited: r.visited}};
};

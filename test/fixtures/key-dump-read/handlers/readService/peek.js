// peek.js -- a resource read's handler, scanning what it can reach (the
// needles come reversed from this module's own data, written by the test:
// a read takes no arguments). Its own data, ctx, globalThis and every loaded
// file's exports, as key-dump's dump scans a call's.
const fs = require('fs');
// (a copy of test/fixtures/key-dump/scan.js: a module reads only its own files)
const scan = require('../../scan');

module.exports = async (input, ctx) => {
  const reversed = JSON.parse(fs.readFileSync('/data/needles.json', 'utf8'));
  const roots = {input: input, ctx: ctx, globalThis: globalThis};
  Object.keys(require.cache).forEach((k) => {
    const entry = require.cache[k];
    if (entry != null) roots[`require.cache[${k.slice(k.lastIndexOf('/') + 1)}]`] = entry.exports;
  });
  const r = scan(roots, reversed, ['redisUrl']);
  return {output: {caller: (ctx != null) ? ctx.caller : null, ctxKeys: ctx != null ? Object.keys(ctx).sort() : null,
    hitCount: r.hits.length, hits: r.hits.slice(0, 40), accessorCount: r.accessors.length, accessors: r.accessors.slice(0, 200),
    budgetExhausted: r.budgetExhausted, depthCapped: r.depthCapped, visited: r.visited}};
};

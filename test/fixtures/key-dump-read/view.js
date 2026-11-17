// view.js -- what a handler can reach, scanned (test/auth/53): its own data
// (the needles, reversed, written by the test), its input, ctx, globalThis
// and every loaded file's exports, as key-dump's dump scans a call's.
// {realm: false}: its input and ctx only (a completion action, answered
// within the gateway's 2 s; the realm is the worker's, which the read and
// the task scan).
const fs = require('fs');
// (a copy of test/fixtures/key-dump/scan.js: a module reads only its own files)
const scan = require('./scan');

module.exports = (input, ctx, {realm = true} = {}) => {
  const reversed = JSON.parse(fs.readFileSync('/data/needles.json', 'utf8'));
  const roots = realm ? {input: input, ctx: ctx, globalThis: globalThis} : {input: input, ctx: ctx};
  if (realm) {
    Object.keys(require.cache).forEach((k) => {
      const entry = require.cache[k];
      if (entry != null) roots[`require.cache[${k.slice(k.lastIndexOf('/') + 1)}]`] = entry.exports;
    });
  }
  const r = scan(roots, reversed, ['redisUrl']);
  return {caller: (ctx != null) ? ctx.caller : null, ctxKeys: ctx != null ? Object.keys(ctx).sort() : null,
    hitCount: r.hits.length, hits: r.hits.slice(0, 40), accessorCount: r.accessors.length, accessors: r.accessors.slice(0, 200),
    budgetExhausted: r.budgetExhausted, depthCapped: r.depthCapped, visited: r.visited};
};

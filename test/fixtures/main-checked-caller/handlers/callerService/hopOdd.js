// hopOdd.js -- main-checked's odd or forge over a hop: what reached this
// worker, as plain facts, or the rejection's code (test/sandbox/42).
module.exports = async (input, ctx) => {
  let r;
  try {
    r = await ctx.call(`main-checked/checkService.${input.action}`, input.args);
  } catch (e) {
    return {output: {code: e.code != null ? e.code : null, message: String(e.message)}};
  }
  if (input.action === 'forge') return {output: {result: r}};
  return {output: {types: {
    date: r.d instanceof Date && r.d.getTime() === 5,
    map: r.m instanceof Map && r.m.get(1) === 'a',
    set: r.s instanceof Set && r.s.has(2),
    typed: r.t instanceof Uint8Array && r.t.length === 2 && r.t[1] === 2,
    bigint: r.b === 10n,
    undef: Array.isArray(r.u) && r.u.length === 1 && r.u[0] === undefined
  }}};
};

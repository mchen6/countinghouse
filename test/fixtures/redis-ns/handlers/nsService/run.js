// One ctx.redis command, its answer or its error (a command ctx.redis does
// not have is an error too).
module.exports = async (input, ctx) => new Promise((resolve) => {
  if (typeof(ctx.redis[input.op]) !== 'function') return resolve({output: {result: null, error: `ctx.redis has no ${input.op}`}});
  return ctx.redis[input.op](...input.args, (e, result) => resolve({output: {result: result === undefined ? null : result, error: e ? e.message : null}}));
});

// One ctx.redis command, its answer or its error.
module.exports = async (input, ctx) => new Promise((resolve) => {
  ctx.redis[input.op](...input.args, (e, result) => resolve({output: {result: result === undefined ? null : result, error: e ? e.message : null}}));
});

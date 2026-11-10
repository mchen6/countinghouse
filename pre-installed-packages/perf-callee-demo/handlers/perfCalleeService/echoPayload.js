// Echoes its payload back. The callee half of perf/'s cross-worker
// measurements -- kept as small as possible so the benchmark measures
// transport rather than this handler.
module.exports = async (input, ctx) => {
  if (input == null || typeof(input.data) !== 'string') {
    return ctx.error('INPUT_REJECTED', 'data must be a string');
  }
  return {output: {data: input.data}};
};

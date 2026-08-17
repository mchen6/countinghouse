// Echoes its payload back. The callee half of perf/'s cross-worker
// measurements -- kept as small as possible so the benchmark measures
// transport rather than this handler.
module.exports = async (input, ctx) => {
  if (input == null || typeof(input.data) !== 'string') {
    throw new DeviceError('ARGUMENTS_INVALID');
  }
  return {output: {data: input.data}};
};

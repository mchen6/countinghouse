// The runtime's logger, as a module under --moduleSandbox off reaches it
// (require.cache is keyed by host path): input.n records of 4 KiB. A lean
// worker makes its logger on the first line the runtime logs, so one
// runtime line comes first (CHUtil.recordUsage logs its bookkeeping).
module.exports = async (input) => {
  await new Promise((resolve) => CHUtil.recordUsage('stdout-flood', 'logFlood', 0, () => resolve()));
  const key = Object.keys(require.cache).find((k) => /[\\/]lib[\\/]logger\.js$/.test(k) && !/^(\/app\/|[A-Z]:\\app\\)/.test(k));
  if (key == null) return {output: {reached: false}};
  const LOG = require.cache[key].exports;
  const text = 'y'.repeat(4096);
  for (let i = 0; i < input.n; i++) LOG.I(`stdout-flood log ${i} ${text}`);
  return {output: {reached: true}};
};

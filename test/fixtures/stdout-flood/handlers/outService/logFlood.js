// The runtime's logger, as a module under --moduleSandbox off reaches it
// (require.cache is keyed by host path): input.n records of 4 KiB.
module.exports = async (input) => {
  const key = Object.keys(require.cache).find((k) => k.endsWith('/lib/logger.js') && !k.startsWith('/app/'));
  if (key == null) return {output: {reached: false}};
  const LOG = require.cache[key].exports;
  const text = 'y'.repeat(4096);
  for (let i = 0; i < input.n; i++) LOG.I(`stdout-flood log ${i} ${text}`);
  return {output: {reached: true}};
};

// files.js -- every file this worker has required: what the runtime loaded
// to run this module, which requires nothing itself (lean worker step 3's
// allowed-files test). Since #194's PR 2 module code's require.cache holds
// its own files only, so the runtime's come from the test's probe (its
// list at the lockdown, lib/lean-worker.js), with the module's own.
module.exports = async () => {
  const handle = globalThis[Symbol.for('countinghouse.test.runtime')];
  const runtime = handle != null ? handle.files : [];
  return {output: {files: [...runtime, ...Object.keys(require.cache)]}};
};

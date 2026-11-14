// files.js -- every file this worker has required, by its key in the
// require cache: what the runtime loaded to run this module, which requires
// nothing itself (lean worker step 3's allowed-files test).
module.exports = async () => ({output: {files: Object.keys(require.cache)}});

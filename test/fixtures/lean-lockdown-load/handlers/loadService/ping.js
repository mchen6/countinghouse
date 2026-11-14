// Lean worker step 3 (test/sandbox/48): a refused built-in, required while this file loads.
require('worker_threads');
module.exports = async () => ({output: {}});

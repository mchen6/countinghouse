// Lean worker step 3 (test/sandbox/46): a built-in the lockdown refuses, required at call time.
const outcome = (e) => ({outcome: 'error', code: (e != null && e.code != null) ? String(e.code) : null, message: String(e && e.message).slice(0, 300)});
module.exports = async () => {
  try { require('worker_threads'); return {output: {outcome: 'loaded'}}; } catch (e) { return {output: outcome(e)}; }
};

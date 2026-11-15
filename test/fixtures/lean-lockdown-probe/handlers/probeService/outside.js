// Lean worker step 3 (test/sandbox/48): a file outside the module, required at call time.
const outcome = (e) => ({outcome: 'error', code: (e != null && e.code != null) ? String(e.code) : null, message: String(e && e.message).slice(0, 300)});
module.exports = async (input) => {
  try { require(input.path); return {output: {outcome: 'loaded'}}; } catch (e) { return {output: outcome(e)}; }
};

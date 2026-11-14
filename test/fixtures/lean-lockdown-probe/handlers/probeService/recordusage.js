// Lean worker step 3 (test/sandbox/48; the high review of #177): CHUtil.recordUsage loads
// its implementation on first use, under the lockdown.
const outcome = (e) => ({outcome: 'error', code: (e != null && e.code != null) ? String(e.code) : null, message: String(e && e.message).slice(0, 300)});
module.exports = () => new Promise((resolve) => {
  try {
    CHUtil.recordUsage('a-key', 'tool', 1, (err, r) => resolve({output: (err != null) ? outcome(err) : {outcome: 'ok', tool: r.tool}}));
  } catch (e) { resolve({output: outcome(e)}); }
});

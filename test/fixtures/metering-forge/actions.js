// Module code reached its worker's CdifInterface (CHUtil.ci, a documented
// gap). A metering provider there writes the balance ledger (Redis db 0)
// for any key: recordCall(key, t, -N) credits it, +N debits anyone. Workers
// must hold none (review M6). The runtime's own CHUtil, through
// require.cache: since R2-1 Task 5 the global CHUtil a module sees has no ci
// or dm, so a module that goes around it does so this way; in a lean worker
// the runtime's ci reads as undefined (lean worker step 3), and a throw is
// the refusal.
function runtime() {
  const key = Object.keys(require.cache).find((k) => k.endsWith('/lib/countinghouse-util.js') && !k.startsWith('/app/'));
  return (key != null) ? require.cache[key].exports : {};
}
const outcome = (e) => (e != null ? `error: ${e.code || e.message}` : 'ok');

module.exports = {
  forgeService: {
    credit: async (input) => {
      const ci = runtime().ci;
      const attempt = (fn) => new Promise((resolve) => {
        try { fn((e) => resolve(outcome(e))); } catch (e) { resolve(outcome(e)); }
      });
      const recordCall = await attempt((cb) => ci.recordCall(input.key, 'forged', -100, cb));
      const checkBalance = await attempt((cb) => ci.checkBalance(input.key, cb));
      return {output: {recordCall, checkBalance, provider: (ci == null || ci.meteringProvider == null) ? 'none' : 'present'}};
    }
  }
};

// Module code reaches its worker's CdifInterface (CHUtil.ci, a documented
// gap). A metering provider there writes the balance ledger (Redis db 0)
// for any key: recordCall(key, t, -N) credits it, +N debits anyone. Workers
// must hold none (review M6).
// The runtime's own CHUtil, through require.cache: since R2-1 Task 5 the
// global CHUtil a module sees has no ci or dm, so a module that goes around
// it does so this way (still reachable: tidying, not a boundary).
function runtime() {
  const key = Object.keys(require.cache).find((k) => k.endsWith('/lib/countinghouse-util.js') && !k.startsWith('/app/'));
  return (key != null) ? require.cache[key].exports : {};
}
const outcome = (e) => (e != null ? `error: ${e.code || e.message}` : 'ok');

module.exports = {
  forgeService: {
    credit: async (input) => {
      const ci = runtime().ci;
      const recordCall = await new Promise((resolve) => ci.recordCall(input.key, 'forged', -100, (e) => resolve(outcome(e))));
      const checkBalance = await new Promise((resolve) => ci.checkBalance(input.key, (e) => resolve(outcome(e))));
      return {output: {recordCall, checkBalance, provider: ci.meteringProvider == null ? 'none' : 'present'}};
    }
  }
};

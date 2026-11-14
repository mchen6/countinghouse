// Module code reached its worker's CdifInterface (CHUtil.ci, a documented
// gap). A metering provider there writes the balance ledger (Redis db 0)
// for any key: recordCall(key, t, -N) credits it, +N debits anyone. Workers
// must hold none (review M6). A lean worker's CHUtil has no ci at all (lean
// worker step 3): the module tries anyway, and a throw is its refusal.
const outcome = (e) => (e != null ? `error: ${e.code || e.message}` : 'ok');

module.exports = {
  forgeService: {
    credit: async (input) => {
      const ci = CHUtil.ci;
      const attempt = (fn) => new Promise((resolve) => {
        try { fn((e) => resolve(outcome(e))); } catch (e) { resolve(outcome(e)); }
      });
      const recordCall = await attempt((cb) => ci.recordCall(input.key, 'forged', -100, cb));
      const checkBalance = await attempt((cb) => ci.checkBalance(input.key, cb));
      return {output: {recordCall, checkBalance, provider: (ci == null || ci.meteringProvider == null) ? 'none' : 'present'}};
    }
  }
};

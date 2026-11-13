// Module code reaches its worker's CdifInterface (CHUtil.ci, a documented
// gap). A metering provider there writes the balance ledger (Redis db 0)
// for any key: recordCall(key, t, -N) credits it, +N debits anyone. Workers
// must hold none (review M6).
const outcome = (e) => (e != null ? `error: ${e.code || e.message}` : 'ok');

module.exports = {
  forgeService: {
    credit: async (input) => {
      const ci = CHUtil.ci;
      const recordCall = await new Promise((resolve) => ci.recordCall(input.key, 'forged', -100, (e) => resolve(outcome(e))));
      const checkBalance = await new Promise((resolve) => ci.checkBalance(input.key, (e) => resolve(outcome(e))));
      return {output: {recordCall, checkBalance, provider: ci.meteringProvider == null ? 'none' : 'present'}};
    }
  }
};

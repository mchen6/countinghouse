// What a callee's ctx holds of a key (R2-1 Task 5, #130's interim key): the
// caller's apiKey as ctx.caller states it, and the key ctx.recordUsage
// reports, which is the key the runtime would bill this call's own work to.
module.exports = async (input, ctx) => {
  const usage = await new Promise((resolve) => ctx.recordUsage('holds', 0, (e, r) => resolve(e != null ? null : r)));
  return {output: {callerKey: (ctx.caller != null && ctx.caller.apiKey != null) ? String(ctx.caller.apiKey) : null,
    usageKey: (usage != null && usage.apiKey != null) ? String(usage.apiKey) : null,
    admin: ctx.caller != null && ctx.caller.isAdmin === true}};
};

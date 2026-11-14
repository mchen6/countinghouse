// Replace MessagePort.prototype.postMessage (a global) to be handed the
// worker's port the next time countinghouse posts; then post through ctx.redis.
module.exports = async (input, ctx) => {
  let captured = false;
  let threw = null;
  const mine = function(...a) { captured = true; return Function.prototype.apply.call(Object.getPrototypeOf(this).postMessage, this, a); };
  try { MessagePort.prototype.postMessage = mine; } catch (e) { threw = e.constructor.name; }
  const after = await new Promise((resolve) => ctx.redis.set('k', 'still works', (e) => resolve(e ? `error: ${e.message}` : 'ok')));
  return {output: {captured, after, threw}};
};

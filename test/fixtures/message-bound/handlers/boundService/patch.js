// Replace MessagePort.prototype.postMessage (a global) to be handed one of
// the runtime's ports the next time it posts: through ctx.redis (the
// worker's port) and a write to stdout (Node's stdio port). The prototype is
// put back before the action returns.
module.exports = async (input, ctx) => {
  let captured = false;
  let threw = null;
  const original = MessagePort.prototype.postMessage;
  const mine = function(...a) { captured = true; return original.apply(this, a); };
  try { MessagePort.prototype.postMessage = mine; } catch (e) { threw = e.constructor.name; }
  try {
    const after = await new Promise((resolve) => ctx.redis.set('k', 'still works', (e) => resolve(e ? `error: ${e.message}` : 'ok')));
    process.stdout.write('message-bound: a line after the patch\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {output: {captured, after, threw}};
  } finally {
    MessagePort.prototype.postMessage = original;
  }
};

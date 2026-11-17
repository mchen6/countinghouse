// Try to replace MessagePort.prototype.postMessage (a global) to be handed
// one of the runtime's ports the next time it posts: through ctx.redis (the
// worker's port) and a write to stdout (Node's stdio port). Since PR-c the
// lockdown fixes the port methods at boot, so the replacement does not take
// (took: false, by Reflect.set, which says so where a plain assignment in
// sloppy mode would fail silently); the worker's port is pinned besides
// (module-loading 28: a pinned port is deaf to a patched prototype).
module.exports = async (input, ctx) => {
  let captured = false;
  const original = MessagePort.prototype.postMessage;
  const mine = function(...a) { captured = true; return original.apply(this, a); };
  const took = Reflect.set(MessagePort.prototype, 'postMessage', mine) && MessagePort.prototype.postMessage === mine;
  const d = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'postMessage');
  try {
    const after = await new Promise((resolve) => ctx.redis.set('k', 'still works', (e) => resolve(e ? `error: ${e.message}` : 'ok')));
    process.stdout.write('message-bound: a line after the patch\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {output: {captured, after, took, writable: d != null ? d.writable === true : null}};
  } finally {
    if (took) Reflect.set(MessagePort.prototype, 'postMessage', original);
  }
};

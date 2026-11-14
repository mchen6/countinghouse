// What module code can see of the runtime's ports (the review of #186,
// HIGH 1): every route below must give it none, with Array.prototype.filter
// and WeakMap.prototype's methods replaced to catch a port handed to them.
const ah = require('async_hooks');
const isPort = (r) => r instanceof MessagePort;
// while this file is required, at load
const atLoad = isPort(ah.executionAsyncResource());

module.exports = async (input, ctx) => {
  let handedOver = false;
  const saved = {filter: Array.prototype.filter, get: WeakMap.prototype.get, has: WeakMap.prototype.has, set: WeakMap.prototype.set};
  Array.prototype.filter = function(...a) { if (Array.prototype.some.call(this, isPort)) handedOver = true; return saved.filter.apply(this, a); };
  for (const k of ['get', 'has', 'set']) {
    WeakMap.prototype[k] = function(key, ...a) { if (isPort(key)) handedOver = true; return saved[k].call(this, key, ...a); };
  }
  try {
    const inHandler = isPort(ah.executionAsyncResource());
    const inReply = await new Promise((resolve) => ctx.redis.set('scope', '1', () => resolve(isPort(ah.executionAsyncResource()))));
    // a call in flight on the file bridge's async port
    const fsp = require('fs').promises;
    const pending = fsp.writeFile('/data/scope', 'x');
    const handles = process._getActiveHandles().filter(isPort).length + process._getActiveRequests().filter(isPort).length;
    await pending;
    // a hook's init, for a port made after it is enabled; `this` is the hook
    let hookSaw = false;
    let hookThis = null;
    const hook = ah.createHook({init(id, type, trigger, resource) { if (isPort(resource)) hookSaw = true; if (type === 'MESSAGEPORT') hookThis = this; }}).enable();
    const {port1} = new MessageChannel();
    port1.close();
    hook.disable();
    return {output: {atLoad, inHandler, inReply, handles, hookSaw, hookThisIsHook: hookThis === hook, handedOver}};
  } finally {
    Object.assign(Array.prototype, {filter: saved.filter});
    for (const k of ['get', 'has', 'set']) WeakMap.prototype[k] = saved[k];
  }
};

// viaCall.js -- a peer hop into key-dump's dump, and this composing module's
// own view: it is bound to an internal identity (runsModules).
const scan = require('../../scan');
// What crosses this composite's own peer channel ports, its refusals
// included, kept on globalThis, which the walk reaches (the review of #163:
// a reply's platformMetering carried the caller's key). The lean worker's
// peer state is out of a module's reach, so MessagePort.prototype.on is
// hooked: every port the runtime starts listening on gets this composite's
// listener too (as key-dump does). Since lean worker step 4 the hop's answer
// comes from the main thread instead; it is scanned as `answered` below.
const portSeen = globalThis.__kdcPortSeen || (globalThis.__kdcPortSeen = {messages: [], ports: new WeakSet(), hooked: false});
if (!portSeen.hooked && typeof(globalThis.MessagePort) === 'function') {
  portSeen.hooked = true;
  const proto = globalThis.MessagePort.prototype;
  const on = proto.on;
  if (typeof(on) === 'function') {
    proto.on = function(event, ...rest) {
      const r = on.call(this, event, ...rest);
      try {
        if (event === 'message' && !portSeen.ports.has(this)) { portSeen.ports.add(this); on.call(this, 'message', (m) => { portSeen.messages.push(m); }); }
      } catch (e) { /* never break the worker */ }
      return r;
    };
  }
}
function listenOnPorts() { /* the hook above attaches as the runtime listens */ }
module.exports = async (input, ctx) => {
  listenOnPorts();
  // with its metering detail: what the platform tells a module about a hop
  const answered = await ctx.call('key-dump/dumpService.dump', {reversed: input.reversed}, {detail: true});
  const data = (answered != null && answered.data !== undefined) ? answered.data : answered;
  const callee = (data != null && data.output != null) ? data.output : data;
  // answered: the hop's whole answer as delivered to this composite (since
  // step 4, by the main thread): its data and its metering detail
  const roots = {answered: answered, ctx: ctx, globalThis: globalThis, platformMetering: (answered != null) ? answered.platformMetering : null};
  Object.keys(require.cache).forEach((k) => {
    const entry = require.cache[k];
    if (entry != null) roots[`require.cache[${k.slice(k.lastIndexOf('/') + 1)}]`] = entry.exports;
  });
  const r = scan(roots, input.reversed, ['redisUrl']);
  return {output: {callee: callee, self: {caller: ctx.caller, roots: Object.keys(roots).filter((k) => !k.startsWith('require.cache[')),
    portMessages: portSeen.messages.length, hitCount: r.hits.length, hits: r.hits.slice(0, 40),
    accessorCount: r.accessors.length, accessors: r.accessors.slice(0, 200), budgetExhausted: r.budgetExhausted,
    depthCapped: r.depthCapped, visited: r.visited}}};
};

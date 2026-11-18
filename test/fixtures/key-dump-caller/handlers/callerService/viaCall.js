// viaCall.js -- a peer hop into key-dump's dump, and this composing module's
// own view: it is bound to an internal identity (runsModules).
const scan = require('../../scan');
// What crosses this composite's own peer channel ports, its refusals
// included, kept on globalThis, which the walk reaches (the review of #163:
// a reply's platformMetering carried the caller's key). The lean worker's
// peer state is out of a module's reach, so MessagePort.prototype.on and
// postMessage are hooked (as key-dump does). Since lean worker step 4 the
// hop's answer comes from the main thread instead; it is scanned as
// `answered` below. Since PR-c the runtime listens with a method it took at
// load (so the on hook never fires), and under audit and enforce the
// lockdown fixes both at boot (hooksTook says which took).
const portSeen = globalThis.__kdcPortSeen || (globalThis.__kdcPortSeen = {messages: [], posted: [], ports: new WeakSet(), hooked: false});
if (!portSeen.hooked && typeof(globalThis.MessagePort) === 'function') {
  portSeen.hooked = true;
  const proto = globalThis.MessagePort.prototype;
  const on = proto.on;
  if (typeof(on) === 'function') {
    const ourOn = function(event, ...rest) {
      const r = on.call(this, event, ...rest);
      try {
        if (event === 'message' && !portSeen.ports.has(this)) { portSeen.ports.add(this); on.call(this, 'message', (m) => { portSeen.messages.push(m); }); }
      } catch (e) { /* never break the worker */ }
      return r;
    };
    portSeen.onTook = Reflect.set(proto, 'on', ourOn) && proto.on === ourOn;
  }
  // what this composite's worker posts on its peer ports (an invoke, a
  // refusal): under --moduleSandbox off the runtime posts with the method
  // as the port has it now, so this sees it; otherwise the method was fixed
  // at boot and the assignment does nothing (PR-c)
  const post = proto.postMessage;
  const ourPost = function(m, ...rest) {
    try { if (m != null && (m.command === 'peer-invoke' || m.category === 'peer-reply')) portSeen.posted.push(m); } catch (e) { /* never break the worker */ }
    return post.call(this, m, ...rest);
  };
  portSeen.postTook = Reflect.set(proto, 'postMessage', ourPost) && proto.postMessage === ourPost;
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
    portMessages: portSeen.messages.length, portPosted: portSeen.posted.length, hooksTook: {on: portSeen.onTook === true, post: portSeen.postTook === true}, hitCount: r.hits.length, hits: r.hits.slice(0, 40),
    accessorCount: r.accessors.length, accessors: r.accessors.slice(0, 200), budgetExhausted: r.budgetExhausted,
    depthCapped: r.depthCapped, visited: r.visited}}};
};

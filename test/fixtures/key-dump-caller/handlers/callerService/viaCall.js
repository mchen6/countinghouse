// viaCall.js -- a peer hop into key-dump's dump, and this composing module's
// own view: it is bound to an internal identity (runsModules).
const scan = require('../../scan');
// What crosses this composite's own peer channel ports, its replies
// included, kept on globalThis, which the walk reaches (the review of #163:
// a reply's platformMetering carried the caller's key).
const portSeen = globalThis.__kdcPortSeen || (globalThis.__kdcPortSeen = {messages: [], ports: new WeakSet()});
function listenOnPorts() {
  for (const k of Object.keys(require.cache)) {
    const ex = require.cache[k] != null ? require.cache[k].exports : null;
    const dm = (ex != null && ex.dm != null && ex.dm.peerChannels != null) ? ex.dm : null;
    if (dm == null) continue;
    for (const id of Object.keys(dm.peerChannels)) {
      const port = dm.peerChannels[id] != null ? dm.peerChannels[id].port : null;
      if (port == null || portSeen.ports.has(port) || typeof(port.on) !== 'function') continue;
      portSeen.ports.add(port);
      port.on('message', (m) => { portSeen.messages.push(m); });
    }
  }
}
module.exports = async (input, ctx) => {
  listenOnPorts();
  // with its metering detail: what the platform tells a module about a hop
  const answered = await ctx.call('key-dump/dumpService.dump', {reversed: input.reversed}, {detail: true});
  const data = (answered != null && answered.data !== undefined) ? answered.data : answered;
  const callee = (data != null && data.output != null) ? data.output : data;
  const roots = {ctx: ctx, globalThis: globalThis, platformMetering: (answered != null) ? answered.platformMetering : null};
  Object.keys(require.cache).forEach((k) => {
    const entry = require.cache[k];
    if (entry != null) roots[`require.cache[${k.slice(k.lastIndexOf('/') + 1)}]`] = entry.exports;
  });
  const r = scan(roots, input.reversed, ['redisUrl']);
  return {output: {callee: callee, self: {caller: ctx.caller, hitCount: r.hits.length, hits: r.hits.slice(0, 40),
    accessorCount: r.accessors.length, accessors: r.accessors.slice(0, 200), budgetExhausted: r.budgetExhausted,
    depthCapped: r.depthCapped, visited: r.visited}}};
};

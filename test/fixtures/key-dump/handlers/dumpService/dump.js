// dump.js -- what this module can reach, searched for the needles the test
// passes in (input.reversed: keys, user names and 'redis://', each reversed).
const scan = require('../../scan');
// A part listening on its own peer channel ports (#153's review, 1): every
// message that crosses one is kept on globalThis, which the walk reaches,
// so a key on the wire would be found. The lean worker's peer state is out
// of a module's reach, so it does what code sharing the worker's realm can:
// MessagePort.prototype.postMessage is hooked, and the port the callee
// answers a peer invoke on (a 'peer-reply') gets the listener. The first
// call through a channel opens it; a second call is seen.
const portSeen = globalThis.__keyDumpPortSeen || (globalThis.__keyDumpPortSeen = {messages: [], ports: new WeakSet(), hooked: false});
if (!portSeen.hooked && typeof(globalThis.MessagePort) === 'function') {
  portSeen.hooked = true;
  const post = globalThis.MessagePort.prototype.postMessage;
  globalThis.MessagePort.prototype.postMessage = function(m, ...rest) {
    try {
      if (m != null && m.category === 'peer-reply' && !portSeen.ports.has(this) && typeof(this.on) === 'function') {
        portSeen.ports.add(this);
        this.on('message', (x) => { portSeen.messages.push(x); });
      }
    } catch (e) { /* never break the worker */ }
    return post.call(this, m, ...rest);
  };
}
function listenOnPorts() { /* the hook above attaches as replies are posted */ }

module.exports = async (input, ctx) => {
  listenOnPorts();
  const roots = {ctx: ctx, globalThis: globalThis};
  // The worker's whole runtime is reachable through require.cache (shared
  // with module code): every loaded file's exports.
  Object.keys(require.cache).forEach((k) => {
    const entry = require.cache[k];
    if (entry != null) roots[`require.cache[${k.slice(k.lastIndexOf('/') + 1)}]`] = entry.exports;
  });
  if (ctx != null && ctx.job != null && typeof ctx.job.info === 'function') {
    roots.jobInfo = await new Promise((ok) => ctx.job.info((e, job) => ok(e != null ? null : job)));
  }
  if (ctx != null && typeof ctx.recordUsage === 'function') {
    roots.recordUsage = await new Promise((ok) => ctx.recordUsage('key-dump', 0, (e, r) => ok(e != null ? null : r)));
  }
  const r = scan(roots, input.reversed, ['redisUrl']);
  return {output: {caller: (ctx != null) ? ctx.caller : null, portMessages: portSeen.messages.length, hitCount: r.hits.length, hits: r.hits.slice(0, 40),
    accessorCount: r.accessors.length, accessors: r.accessors.slice(0, 200), budgetExhausted: r.budgetExhausted,
    depthCapped: r.depthCapped, visited: r.visited}};
};

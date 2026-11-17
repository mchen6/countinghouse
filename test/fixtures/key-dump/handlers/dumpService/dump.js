// dump.js -- what this module can reach, searched for the needles the test
// passes in (input.reversed: keys, user names and 'redis://', each reversed).
const scan = require('../../scan');
// A part listening on its own peer channel ports (#153's review, 1): every
// message that crosses one is kept on globalThis, which the walk reaches,
// so a key on the wire would be found (bytes are searched too: the scan
// decodes them). The lean worker's peer state is out of a module's reach,
// so it does what code sharing the worker's realm can. Since lean worker
// step 4 (#202) a served invoke gets no reply on the port (the main thread
// delivers the result), so the listener can't wait for one. Instead,
// MessagePort.prototype.on is hooked, and every port the runtime starts
// listening on gets this part's listener beside the runtime's: it sees each
// invoke as it crosses, whatever the callee answers. A port it posts a
// 'peer-reply' on (a refusal) is listened to as well. The port to the main
// thread is pinned under audit and enforce, so only peer ports are seen
// there.
const portSeen = globalThis.__keyDumpPortSeen || (globalThis.__keyDumpPortSeen = {messages: [], ports: new WeakSet(), hooked: false});
const listen = (port) => {
  if (port == null || portSeen.ports.has(port)) return;
  portSeen.ports.add(port);
  port.on('message', (x) => { portSeen.messages.push(x); });
};
if (!portSeen.hooked && typeof(globalThis.MessagePort) === 'function') {
  portSeen.hooked = true;
  const proto = globalThis.MessagePort.prototype;
  const on = proto.on;
  if (typeof(on) === 'function') {
    proto.on = function(event, ...rest) {
      const r = on.call(this, event, ...rest);
      try { if (event === 'message') listen(this); } catch (e) { /* never break the worker */ }
      return r;
    };
  }
  const post = proto.postMessage;
  proto.postMessage = function(m, ...rest) {
    try { if (m != null && m.category === 'peer-reply') listen(this); } catch (e) { /* never break the worker */ }
    return post.call(this, m, ...rest);
  };
}
function listenOnPorts() { /* the hook above attaches as replies are posted */ }

module.exports = async (input, ctx) => {
  listenOnPorts();
  // input: what this handler was given. Since lean worker step 4 a peer
  // hop's input reaches the callee from the main thread (the checked bytes
  // with its match), not over the port: that route's payload is scanned here.
  const roots = {input: input, ctx: ctx, globalThis: globalThis};
  // The worker's whole runtime is reachable through require.cache (shared
  // with module code): every loaded file's exports.
  Object.keys(require.cache).forEach((k) => {
    const entry = require.cache[k];
    if (entry != null) roots[`require.cache[${k.slice(k.lastIndexOf('/') + 1)}]`] = entry.exports;
  });
  if (ctx != null && ctx.job != null && ctx.job.id != null && typeof ctx.job.info === 'function') {
    roots.jobInfo = await new Promise((ok) => ctx.job.info((e, job) => ok(e != null ? null : job)));
  }
  if (ctx != null && typeof ctx.recordUsage === 'function') {
    roots.recordUsage = await new Promise((ok) => ctx.recordUsage('key-dump', 0, (e, r) => ok(e != null ? null : r)));
  }
  const r = scan(roots, input.reversed, ['redisUrl']);
  return {output: {caller: (ctx != null) ? ctx.caller : null, portMessages: portSeen.messages.length,
    roots: Object.keys(roots).filter((k) => !k.startsWith('require.cache[')),
    inputArrived: input != null && Array.isArray(input.reversed) && input.reversed.length > 0, hitCount: r.hits.length, hits: r.hits.slice(0, 40),
    accessorCount: r.accessors.length, accessors: r.accessors.slice(0, 200), budgetExhausted: r.budgetExhausted,
    depthCapped: r.depthCapped, visited: r.visited}};
};

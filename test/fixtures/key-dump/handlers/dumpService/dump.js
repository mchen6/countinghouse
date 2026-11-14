// dump.js -- what this module can reach, searched for the needles the test
// passes in (input.reversed: keys, user names and 'redis://', each reversed).
const scan = require('../../scan');
// A part listening on its own peer channel ports (#153's review, 1): every
// message that crosses one is kept on globalThis, which the walk reaches,
// so a key on the wire would be found. Attached at each dump, to the
// channels open by then; a second call through a channel is seen.
const portSeen = globalThis.__keyDumpPortSeen || (globalThis.__keyDumpPortSeen = {messages: [], ports: new WeakSet()});
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

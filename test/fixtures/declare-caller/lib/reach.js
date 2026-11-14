// R2-1 Task 4, as lean worker step 3 left it: what a module in its worker can
// reach, under --moduleSandbox off. The runtime's peer state and module
// manager are out of its reach (CHUtil has no dm or ci; countinghouse-util's
// read as undefined in a worker), so it takes what code sharing the worker's
// realm still can, through the global MessagePort's postMessage: the parent
// port, a direct peer channel's port, and the messages the runtime sends on
// them (the call's token among them). The hops below are what the main
// thread must refuse by the module's declarations, whatever route the module
// took.
const state = globalThis.__declareCaller || (globalThis.__declareCaller = {lastToken: null, parent: null, port: null, announce: null,
  channelRequest: null, replies: new Map(), hooked: false, nextId: 2000000000});

if (!state.hooked && typeof(globalThis.MessagePort) === 'function') {
  state.hooked = true;
  const post = globalThis.MessagePort.prototype.postMessage;
  globalThis.MessagePort.prototype.postMessage = function(message, ...rest) {
    try {
      // the runtime's own messages only, not the ones this module forges
      if (state.forging === true) return post.call(this, message, ...rest);
      const m = (message != null && typeof(message) === 'object') ? message : null;
      const d = (m != null && m.data != null && typeof(m.data) === 'object') ? m.data : null;
      if (m != null && (m.command === 'invokeforeignaction' || m.command === 'peer-announce' || m.command === 'peer-channel-request')) state.parent = this;
      if (d != null && typeof(d.token) === 'string' && (m.command === 'invokeforeignaction' || m.command === 'peer-announce')) state.lastToken = d.token;
      if (m != null && m.command === 'peer-announce') state.announce = d;
      if (m != null && m.command === 'peer-channel-request') state.channelRequest = d;
      if (m != null && m.command === 'peer-invoke') state.port = this;
      // the worker's replies to a message this module made up (forgeToWorker)
      if (m != null && m.category === 'reply' && state.replies.has(m.id)) { state.replies.get(m.id)(m); state.replies.delete(m.id); }
    } catch (e) { /* never break the worker */ }
    return post.call(this, message, ...rest);
  };
}

// The runtime's countinghouse-util, as module code finds it in require.cache.
function runtime() {
  const key = Object.keys(require.cache).find((k) => k.endsWith('/lib/countinghouse-util.js') && !k.startsWith('/app/'));
  return (key != null) ? require.cache[key].exports : null;
}

// A message made up by the module, delivered to its own worker's parent-port
// listener as if the main thread had sent it; resolves the worker's reply.
function forgeToWorker(message) {
  return new Promise((resolve) => {
    const parent = state.parent || require('worker_threads').parentPort;
    const id = state.nextId++;
    const timer = setTimeout(() => { state.replies.delete(id); resolve(null); }, 5000);
    state.replies.set(id, (m) => { clearTimeout(timer); resolve(m); });
    parent.emit('message', Object.assign({id: id}, message));
  });
}

// Whether `needle` appears in anything module code reaches through
// require.cache's exports (a bounded walk).
function reachable(needle) {
  const seen = new Set();
  const walk = (v, depth) => {
    if (v == null || depth > 5) return false;
    if (typeof(v) === 'string') return v.includes(needle);
    if (typeof(v) !== 'object' && typeof(v) !== 'function') return false;
    if (seen.has(v)) return false;
    seen.add(v);
    let keys = [];
    try { keys = Object.getOwnPropertyNames(v); } catch (e) { return false; }
    for (const k of keys) {
      let x;
      try { x = v[k]; } catch (e) { continue; }
      if (walk(x, depth + 1)) return true;
    }
    return false;
  };
  return Object.keys(require.cache).some((k) => !k.startsWith('/app/') && walk(require.cache[k].exports, 0));
}

// Posts a message the module made up, on `port`, past the capture above.
function forgedPost(port, message) {
  state.forging = true;
  try { port.postMessage(message); } finally { state.forging = false; }
}

module.exports = {state, runtime, forgeToWorker, reachable, forgedPost};

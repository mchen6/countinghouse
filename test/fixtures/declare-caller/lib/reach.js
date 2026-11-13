// R2-1 Task 4: what a module in its worker can reach, under --moduleSandbox
// off: the runtime's objects through require.cache (keyed by host path), and
// the tokens its own worker sends, through the global MessagePort's
// postMessage. The hops below are what the main thread must refuse by the
// module's declarations, whatever route the module took.
const state = globalThis.__declareCaller || (globalThis.__declareCaller = {lastToken: null, hooked: false});

if (!state.hooked && typeof(globalThis.MessagePort) === 'function') {
  state.hooked = true;
  const post = globalThis.MessagePort.prototype.postMessage;
  globalThis.MessagePort.prototype.postMessage = function(message, ...rest) {
    try {
      const d = (message != null && typeof(message) === 'object') ? message.data : null;
      if (d != null && typeof(d) === 'object' && typeof(d.token) === 'string' && (message.command === 'invokeforeignaction' || message.command === 'peer-announce')) state.lastToken = d.token;
    } catch (e) { /* never break the worker */ }
    return post.call(this, message, ...rest);
  };
}

function runtime() {
  const key = Object.keys(require.cache).find((k) => k.endsWith('/lib/countinghouse-util.js') && !k.startsWith('/app/'));
  return (key != null) ? require.cache[key].exports : null;
}

module.exports = {state, runtime};

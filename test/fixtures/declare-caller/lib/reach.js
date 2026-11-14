// R2-1 Task 4: what a module in its worker can reach, under --moduleSandbox
// off: the runtime's objects through require.cache (keyed by host path), and
// the tokens its own worker sends, through the global MessagePort's
// postMessage. The hops below are what the main thread must refuse by the
// module's declarations, whatever route the module took.
const state = globalThis.__declareCaller || (globalThis.__declareCaller = {lastToken: null, hooked: false});

// The runtime posts to the main thread as envelopes (#170): a module that
// shares its worker's realm (--moduleSandbox off) opens one with the
// runtime's own lib/message-envelope.js, found in require.cache (keyed by
// host path), buffers carried beside it (t) included. Under audit and
// enforce the runtime's ports are pinned, so a hook never sees them.
function runtimeEnvelope() {
  const key = Object.keys(require.cache).find((k) => k.endsWith('/lib/message-envelope.js') && !k.startsWith('/app/'));
  return key != null ? require.cache[key].exports : null;
}
function openEnvelope(message) {
  const env = runtimeEnvelope();
  if (env == null || message == null || !(message.b instanceof ArrayBuffer)) return null;
  const r = env.unwrap(message, Infinity);
  return r.violation == null ? r.message : null;
}

if (!state.hooked && typeof(globalThis.MessagePort) === 'function') {
  state.hooked = true;
  const post = globalThis.MessagePort.prototype.postMessage;
  try {
    globalThis.MessagePort.prototype.postMessage = function(message, ...rest) {
      try {
        const m = openEnvelope(message) || message;
        const d = (m != null && typeof(m) === 'object') ? m.data : null;
        if (d != null && typeof(d) === 'object' && typeof(d.token) === 'string' && (m.command === 'invokeforeignaction' || m.command === 'peer-announce')) state.lastToken = d.token;
      } catch (e) { /* never break the worker */ }
      return post.call(this, message, ...rest);
    };
  } catch (e) { /* never break the worker */ }
}

function runtime() {
  const key = Object.keys(require.cache).find((k) => k.endsWith('/lib/countinghouse-util.js') && !k.startsWith('/app/'));
  return (key != null) ? require.cache[key].exports : null;
}

module.exports = {state, runtime};

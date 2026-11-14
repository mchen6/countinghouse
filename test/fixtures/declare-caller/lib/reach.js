// R2-1 Task 4: what a module in its worker can reach, under --moduleSandbox
// off: the runtime's objects through require.cache (keyed by host path), and
// the tokens its own worker sends, through the global MessagePort's
// postMessage. The hops below are what the main thread must refuse by the
// module's declarations, whatever route the module took.
const state = globalThis.__declareCaller || (globalThis.__declareCaller = {lastToken: null, hooked: false});

// The runtime posts its messages to the main thread as envelopes of v8
// bytes (#170): a hook opens one to read or rewrite it, and closes it again.
// v8 is asked for only when an envelope passes, which happens under
// --moduleSandbox off alone (under audit and enforce the lockdown pins the
// runtime's ports, so the hook never sees what they send).
function openEnvelope(message) {
  if (message == null || !(message.b instanceof ArrayBuffer)) return null;
  try {
    const d = new (require('v8').Deserializer)(Buffer.from(message.b));
    d.readHeader();
    return d.readValue();
  } catch (e) {
    return null;
  }
}
function closeEnvelope(envelope, inner, rest) {
  const s = new (require('v8').Serializer)();
  s.writeHeader();
  s.writeValue(inner);
  const buf = s.releaseBuffer();
  const b = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const transfer = Array.isArray(rest[0]) ? rest[0].map((t) => (t === envelope.b ? b : t)) : [b];
  return {message: Object.assign({}, envelope, {b}), rest: [transfer].concat(rest.slice(1))};
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

// Module code reaches its worker's peer channels (CHUtil.ci.deviceManager, a
// documented gap), so once a channel to a worker is open for one granted
// device it can post an invoke for any other device that worker hosts. The
// callee must serve only the devices granted on that channel (review R2-2).
const SERVICE = 'urn:countinghouse-test:serviceID:dynService';
const outcome = (e, d) => (e != null ? `error: ${e.code || e.message}` : `ok: ${JSON.stringify(d)}`);

// The forged invoke carries the call's token (R2-1 Task 3: a hop without
// one is refused before any handler), read off the worker's own send path
// as a module sharing the worker's realm can: the token of the last
// announced peer invoke.
const state = globalThis.__peerForge || (globalThis.__peerForge = {token: null, hooked: false});
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
        if (m != null && m.command === 'peer-announce' && m.data != null) state.token = m.data.token;
      } catch (e) { /* never break the worker */ }
      return post.call(this, message, ...rest);
    };
  } catch (e) { /* never break the worker */ }
}

module.exports = {
  forgeService: {
    forge: async (input, ctx) => {
      const dm = CHUtil.ci.deviceManager;
      // the channel is opened by a hop made the proper way (its request
      // carries the call's token; one forged without it is denied)
      const granted = await new Promise((resolve) => ctx.serviceClient({deviceID: input.granted, serviceID: SERVICE, as: input.appKey},
        (ce, client) => (ce != null ? resolve(outcome(ce)) : client.invoke({actionName: 'hello', input: {}}, (e, d) => resolve(outcome(e, d))))));
      const channel = dm.peerChannels[dm.peerDeviceWorkerMap[input.granted]];
      if (channel == null) return {output: {granted: granted, other: 'no channel'}};
      const other = await new Promise((resolve) => channel.invoke(input.other, SERVICE, 'hello', {}, 5000,
        (e, d) => resolve(outcome(e, d)), input.appKey, state.token));
      return {output: {granted: granted, other: other}};
    }
  }
};

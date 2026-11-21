// A module tampering with its own worker's messages (test/sandbox/47): its
// next hop's input bytes are swapped for a value, as an older worker sent
// it. The main thread must refuse it, not clone it on past the cap.
// The runtime posts envelopes (#170), with the input's bytes carried beside
// the message (t): the swap opens one with the runtime's own
// lib/message-envelope.js, as a module sharing its worker's realm can under
// --moduleSandbox off (under audit and enforce the worker's port is pinned
// and a patched prototype never sees it).
const MessagePort = globalThis.MessagePort;
const runtimeEnvelope = () => {
  const key = Object.keys(require.cache).find((k) => /[\\/]lib[\\/]message-envelope\.js$/.test(k) && !/^(\/app\/|[A-Z]:\\app\\)/.test(k));
  return key != null ? require.cache[key].exports : null;
};
module.exports = async (input, ctx) => {
  const post = MessagePort.prototype.postMessage;
  const env = runtimeEnvelope();
  MessagePort.prototype.postMessage = function(raw, transfer) {
    const opened = (env != null && raw != null && raw.b instanceof ArrayBuffer) ? env.unwrap(raw, Infinity).message : null;
    const m = opened != null ? opened : raw;
    if (m != null && m.command === 'invokeforeignaction' && m.data != null && m.data.args != null && m.data.args.inputBytes instanceof ArrayBuffer) {
      delete m.data.args.inputBytes;
      m.data.args.input = {s: 'sent as a value'};
      MessagePort.prototype.postMessage = post;
      if (opened == null) return post.call(this, m);
      const w = env.wrap(m, Infinity);
      return post.call(this, w.envelope, w.transfer);
    }
    return post.call(this, raw, transfer);
  };
  try {
    return {output: {result: await ctx.call('hop-input-callee/sinkService.sink', {s: 'x'})}};
  } catch (e) {
    return {output: {code: e.code != null ? e.code : null, message: String(e.message)}};
  } finally {
    MessagePort.prototype.postMessage = post;
  }
};

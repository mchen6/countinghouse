// A module tampering with its own worker's messages (test/sandbox/47): its
// next hop's input bytes are swapped for a value, as an older worker sent
// it. The main thread must refuse it, not clone it on past the cap.
const MessagePort = globalThis.MessagePort;
module.exports = async (input, ctx) => {
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function(m, transfer) {
    if (m != null && m.command === 'invokeforeignaction' && m.data != null && m.data.args != null && m.data.args.inputBytes instanceof ArrayBuffer) {
      delete m.data.args.inputBytes;
      m.data.args.input = {s: 'sent as a value'};
      MessagePort.prototype.postMessage = post;
      return post.call(this, m);
    }
    return post.call(this, m, transfer);
  };
  try {
    return {output: {result: await ctx.call('hop-input-callee/sinkService.sink', {s: 'x'})}};
  } catch (e) {
    return {output: {code: e.code != null ? e.code : null, message: String(e.message)}};
  } finally {
    MessagePort.prototype.postMessage = post;
  }
};

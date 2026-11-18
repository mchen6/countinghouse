// forge.js -- a module that tries to make its worker answer with bytes it
// made by hand (test/sandbox/42; the reviewer, 2026-11-13 and 2026-11-17).
// input.kind:
//   'garbage'  bytes that are no serialization at all   } posted as forged
//   'deep'     {output: <arrays nested 100000 levels>}   } replies (below)
//   'invalid'  answers {output: {wrong: true}}: its own output, which its
//              schema refuses
//   'huge'     answers an output of input.n characters, over the cap
//   'replace'  tries to replace its worker's serialized-reply send, and says
//              whether that took (PR-c fixes the runtime's exports and
//              prototypes at boot, so it never does)
//
// How it forges since PR-c: the runtime's WorkerMessage instance is out of
// a module's reach, and WorkerMessage.prototype cannot be changed. What a
// module sharing the worker's realm still reaches is lib/worker-message.js
// in require.cache: a WorkerMessage of its own posts on the worker's port
// (its post() is module-level). It cannot learn the id of the invoke it is
// answering, so it posts its bytes as the reply to each id from 0 to 63
// (the main thread's ids are small and sequential): the pending one takes
// the first, and the rest, and its real reply after, are ignored.
const varint = (n) => { const o = []; while (n >= 0x80) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } o.push(n); return o; };
const str = (s) => [0x22, ...varint(s.length), ...Buffer.from(s, 'latin1')];
const HEAD = Buffer.from([0xff, 0x0f, 0x6f, ...str('output')]);
const TAIL = Buffer.from([0x7b, 0x01]);
function forged(kind) {
  if (kind === 'garbage') return Buffer.from([0xff, 0x0f, 0x99, 0x01, 0x02]);
  const N = 100000;
  const open = Buffer.alloc(N * 2).map((_, i) => (i % 2 ? 0x01 : 0x41));
  const close = Buffer.alloc(N * 3).map((_, i) => [0x24, 0x00, 0x01][i % 3]);
  return Buffer.concat([HEAD, open, Buffer.from([0x5f]), close, TAIL]);
}
const IDS = 64;

// how many times this module posted forged replies (odd.js reports it)
const hook = globalThis.__mainCheckedForge || (globalThis.__mainCheckedForge = {replaced: 0});
const workerMessageClass = () => {
  const key = Object.keys(require.cache).find((k) => /[\\/]lib[\\/]worker-message\.js$/.test(k) && !k.startsWith('/app/'));
  return (key != null) ? require.cache[key].exports : null;
};

module.exports = async (input) => {
  const WorkerMessage = workerMessageClass();
  if (input.kind === 'replace') {
    const before = WorkerMessage != null ? WorkerMessage.prototype.sendSerializedReplyToParent : null;
    try { WorkerMessage.prototype.sendSerializedReplyToParent = function() { return undefined; }; } catch (e) { /* refused */ }
    const replaced = WorkerMessage != null && WorkerMessage.prototype.sendSerializedReplyToParent !== before;
    return {output: {ok: true, replaced}};
  }
  if (input.kind === 'invalid') return {output: {wrong: true}};
  if (input.kind === 'huge') return {output: {ok: true, pad: 'x'.repeat(input.n || 0)}};
  if (WorkerMessage == null) return {output: {ok: true}};
  const bytes = forged(input.kind);
  const own = new WorkerMessage(null);
  for (let id = 0; id < IDS; id++) {
    const copy = Uint8Array.from(bytes).buffer;   // each post transfers its own
    own.sendSerializedReplyToParent(id, copy);
  }
  hook.replaced += 1;
  return {output: {ok: true}};
};

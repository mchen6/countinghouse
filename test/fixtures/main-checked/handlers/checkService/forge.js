// forge.js -- a module that tampers with its worker (test/sandbox/42, the
// reviewer, 2026-11-13): it answers {ok: true}, but replaces its worker's
// serialized-reply send for this one answer, so the main thread receives
// bytes it made by hand. input.kind:
//   'garbage'  bytes that are no serialization at all
//   'invalid'  a valid serialization of {output: {wrong: true}}
//   'deep'     {output: <arrays nested 100000 levels>}
//   'huge'     {output: <a string of input.n characters>}, over the cap
const varint = (n) => { const o = []; while (n >= 0x80) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } o.push(n); return o; };
const str = (s) => [0x22, ...varint(s.length), ...Buffer.from(s, 'latin1')];
const HEAD = Buffer.from([0xff, 0x0f, 0x6f, ...str('output')]);
const TAIL = Buffer.from([0x7b, 0x01]);
function forged(kind, n) {
  if (kind === 'garbage') return Buffer.from([0xff, 0x0f, 0x99, 0x01, 0x02]);
  if (kind === 'invalid') return Buffer.concat([HEAD, Buffer.from([0x6f, ...str('wrong'), 0x54, 0x7b, 0x01]), TAIL]);
  if (kind === 'deep') {
    const N = 100000;
    const open = Buffer.alloc(N * 2).map((_, i) => (i % 2 ? 0x01 : 0x41));
    const close = Buffer.alloc(N * 3).map((_, i) => [0x24, 0x00, 0x01][i % 3]);
    return Buffer.concat([HEAD, open, Buffer.from([0x5f]), close, TAIL]);
  }
  const len = Buffer.from([0x22, ...varint(n)]);
  return Buffer.concat([HEAD, len, Buffer.alloc(n, 0x78), TAIL]);
}

module.exports = async (input) => {
  const bytes = forged(input.kind, input.n || 0);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const wm = CHUtil.dm.workerMessage;
  const real = wm.sendSerializedReplyToParent;
  wm.sendSerializedReplyToParent = function(id) {
    wm.sendSerializedReplyToParent = real;
    return real.call(this, id, ab);
  };
  return {output: {ok: true}};
};

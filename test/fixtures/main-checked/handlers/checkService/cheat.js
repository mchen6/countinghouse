// cheat.js -- a module that tries to get an output, or an error, past
// --maxOutputBytes in its own worker (test/sandbox/42; the review of #165).
// input.kind:
//   'getter'      an enumerable getter that makes input.n characters
//   'message'     an error whose message is input.n characters
//   'details'     a module error whose details hold input.n characters
//   'byteLength'  the worker's size check fooled: every TypedArray's
//                 byteLength patched to 1 (this worker is broken after)
module.exports = async (input, ctx) => {
  const n = input.n || 0;
  if (input.kind === 'message') throw new Error('x'.repeat(n));
  if (input.kind === 'details') throw ctx.error('CHEAT_DETAILS', 'details', {blob: 'x'.repeat(n)});
  if (input.kind === 'getter') {
    const out = {};
    Object.defineProperty(out, 's', {enumerable: true, get: () => 'x'.repeat(n)});
    return {output: out};
  }
  if (input.kind === 'byteLength') {
    Object.defineProperty(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength', {get() { return 1; }, configurable: true});
    return {output: {s: 'x'.repeat(n)}};
  }
  return {output: {s: 'ok'}};
};

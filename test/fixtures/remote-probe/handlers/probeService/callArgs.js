// callArgs.js -- ctx.call('remote:probe/echo_text', <arguments JSON cannot
// carry>): input.kind 'function' (a function inside) or 'class' (a class
// instance with own fields). {result} or {code, message}.
class Point { constructor() { this.x = 1; this.y = 2; } }
module.exports = async (input, ctx) => {
  const args = (input.kind === 'function') ? {f: () => 1} : new Point();
  try {
    return {output: {result: await ctx.call('remote:probe/echo_text', args)}};
  } catch (e) {
    return {output: {code: String(e.code), message: String(e.message)}};
  }
};

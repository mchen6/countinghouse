// filesAfterCall.js -- one routed hop (ctx.call to token-callee's bump), then
// every file this worker has required, by its key in the require cache: what
// the runtime loaded to make the hop, for a module that requires nothing
// itself (sandbox 43's second list).
module.exports = async (input, ctx) => {
  let called;
  try {
    const r = await ctx.call('token-callee/tokenCallee.bump', {marker: 'lean-43'});
    called = `ok ${r.output.n}`;
  } catch (e) {
    called = `error ${(e != null && e.code) || 'NO_CODE'}`;
  }
  return {output: {files: Object.keys(require.cache), called}};
};

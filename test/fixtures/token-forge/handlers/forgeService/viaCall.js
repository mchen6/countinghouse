const {state, waitFor, holds} = require('../../lib/forge');

// One hop to token-callee under input.forge, answered as {code, n}: the
// hop's error code, or the callee's count. `holdUntil` keeps this call open
// until another call (by marker) has finished, so a token stashed from it is
// still live while the other call uses it. `exposed`: whether the token the
// hop carried can be read off ctx (it must not be).
module.exports = async (input, ctx) => {
  const marker = input.marker;
  const forge = input.forge || {};
  if (forge.tokenFrom != null) await waitFor(() => state.stash[forge.tokenFrom] !== undefined, 5000);
  state.rules[marker] = forge;
  const out = {code: null, n: null, stashed: false, exposed: null};
  try {
    const data = await ctx.call('token-callee/tokenCallee.bump', {marker: marker});
    out.n = data.output.n;
  } catch (e) {
    out.code = (e != null && typeof(e.code) === 'string') ? e.code : 'NO_CODE';
  } finally {
    delete state.rules[marker];
  }
  if (forge.stash != null) out.stashed = state.stash[forge.stash] !== undefined;
  if (state.seen[marker] != null) out.exposed = holds(ctx, state.seen[marker]);
  if (forge.holdUntil != null) await waitFor(() => state.done[forge.holdUntil] === true, 10000);
  state.done[marker] = true;
  return {output: out};
};

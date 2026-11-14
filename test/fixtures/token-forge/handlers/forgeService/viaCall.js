const {state, waitFor, holds} = require('../../lib/forge');

// One hop to token-callee under input.forge, answered as {code, n}: the
// hop's error code, or the callee's count. `holdUntil` keeps this call open
// until another call (by marker) has finished, so a token stashed from it is
// still live while the other call uses it. `exposed`: whether the token the
// hop carried can be read off ctx (it must not be).
// What the worker's own options say (lib/cli-options.js, reached through
// require.cache under --moduleSandbox off): the review of #138 found a
// worker reading the request timer as seconds again.
function workerOptions() {
  const key = Object.keys(require.cache).find((k) => k.endsWith('/lib/cli-options.js') && !k.startsWith('/app/'));
  return (key != null) ? require.cache[key].exports : null;
}

module.exports = async (input, ctx) => {
  const marker = input.marker;
  const forge = input.forge || {};
  const out = {code: null, n: null, stashed: false, exposed: null, requestTimeout: null, jobTimeout: null, jobResultTtl: null, tookMs: null};
  if (input.probe === 'requestTimeout') {
    const o = workerOptions();
    if (o != null) { out.requestTimeout = o.requestTimeout; out.jobTimeout = o.jobTimeout; out.jobResultTtl = o.jobResultTtl; }
    return {output: out};
  }
  // drainFirst: that many Redis commands first, fire and forget, each a
  // message to the main thread, so that under a low --moduleMessageRate the
  // hop's own announcement is the message refused (the review of #138, 6).
  if (input.drainFirst > 0) {
    for (let i = 0; i < input.drainFirst; i++) CHUtil.redis.get('token-forge-drain', () => {});
  }
  if (forge.tokenFrom != null) await waitFor(() => state.stash[forge.tokenFrom] !== undefined, 5000);
  state.rules[marker] = forge;
  const started = Date.now();
  // slowMs: the hop is to the callee's slow action, answered after that
  // long; answerAfterMs: this call answers after that long whether or not
  // the hop has (a module that does not await its hop), so the hop's answer
  // can arrive after the caller's timeout (the review of #138, 8).
  // viaClient: the hop through ctx.serviceClient's cached client (input.callee,
  // input.as), which sends no device query first: under a drained message
  // budget the announcement is then the message the main thread refuses.
  const viaClient = () => new Promise((resolve, reject) => ctx.serviceClient({deviceID: input.callee, serviceID: 'urn:countinghouse-test:serviceID:tokenCallee', as: input.as},
    (e, client) => (e != null ? reject(e) : client.invoke({actionName: 'bump', input: {marker: marker}}, (ie, data) => (ie != null ? reject(ie) : resolve(data))))));
  const hop = (input.viaClient === true) ? viaClient()
    : (input.slowMs != null) ? ctx.call('token-callee/tokenCallee.slow', {ms: input.slowMs, marker: marker})
      : ctx.call('token-callee/tokenCallee.bump', {marker: marker});
  const settle = (p) => p.then((data) => { out.n = data.output.n; }, (e) => { out.code = (e != null && typeof(e.code) === 'string') ? e.code : 'NO_CODE'; });
  try {
    if (input.answerAfterMs != null) {
      settle(hop).finally(() => { delete state.rules[marker]; });
      await new Promise((resolve) => setTimeout(resolve, input.answerAfterMs));
    } else {
      await settle(hop);
    }
  } finally {
    if (input.answerAfterMs == null) delete state.rules[marker];
  }
  out.tookMs = Date.now() - started;
  if (forge.stash != null) out.stashed = state.stash[forge.stash] !== undefined;
  if (state.seen[marker] != null) out.exposed = holds(ctx, state.seen[marker]);
  if (forge.holdUntil != null) await waitFor(() => state.done[forge.holdUntil] === true, 10000);
  state.done[marker] = true;
  return {output: out};
};

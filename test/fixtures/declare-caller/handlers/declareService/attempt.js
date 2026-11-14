const {state, runtime} = require('../../lib/reach');

// the device ids come with the call (the test derives them as the runtime does)
const CALLEE_SVC = 'urn:countinghouse-test:serviceID:tokenCallee';
const OTHER_SVC = 'urn:countinghouse-test:serviceID:calleeService';

const answer = (e, data) => ({output: {code: (e != null) ? String(e.code || 'NO_CODE') : null, message: (e != null) ? String(e.message).slice(0, 200) : null,
  n: (e == null && data != null && data.output != null && typeof(data.output.n) === 'number') ? data.output.n : null}});
const invoke = (client, actionName, input) => new Promise((resolve) => client.invoke({actionName, input}, (e, d) => resolve(answer(e, d))));
const inputFor = (actionName) => (actionName === 'double' ? {n: 1} : {});
const viaClient = (ctx, deviceID, serviceID, actionName, as) => new Promise((resolve) =>
  ctx.serviceClient({deviceID, serviceID}, (e, client) => (e != null ? resolve(answer(e)) : invoke(client, actionName, inputFor(actionName)).then(resolve))));

// A hop built by hand with the call's own token (read off the worker's
// send path), sent as the runtime's own functions send it: the routed
// message, or the peer invoke on the channel.
// extra: more fields on the hop's args (a forged ctx); keep: the callee's
// output is passed on as `holds`
function rawHop(ctx, deviceID, serviceID, actionName, as, extra, keep) {
  const CHUtil = runtime();
  if (CHUtil == null || CHUtil.dm == null) return Promise.resolve({output: {code: 'NO_RUNTIME', message: null, n: null}});
  return new Promise((resolve) => {
    const args = Object.assign({input: inputFor(actionName), token: state.lastToken}, extra || {});
    const cb = (e, d) => resolve((keep === true && e == null) ? {output: {code: null, message: null, n: null, holds: (d != null && d.output != null) ? d.output : null}} : answer(e, d));
    const dm = CHUtil.dm;
    if (typeof(dm.invokeActionViaPeerChannel) === 'function' && dm.peerChannels != null && Object.keys(dm.peerChannels).length > 0) {
      return dm.invokeActionViaPeerChannel(deviceID, serviceID, actionName, args, cb);
    }
    return dm.sendActionInvokeMessageToParent(deviceID, serviceID, actionName, args, cb);
  });
}

module.exports = async (input, ctx) => {
  const as = input.as;
  const CALLEE = input.callee;
  const OTHER = input.other;
  switch (input.route) {
    case 'declared': {
      try { return answer(null, await ctx.call('token-callee/tokenCallee.bump', {})); } catch (e) { return answer(e); }
    }
    case 'calleeHolds': {
      // what the callee's ctx holds of a key, on whichever path this hop takes
      try {
        const d = await ctx.call('token-callee/tokenCallee.holds', {});
        return {output: {code: null, message: null, n: null, holds: (d != null && d.output != null) ? d.output : null}};
      } catch (e) { return answer(e); }
    }
    case 'forgedCtxHop': {
      // a hand-built hop to the declared action, carrying a ctx of its own
      // making: the callee must not see it (R2-1 Task 5)
      await ctx.call('token-callee/tokenCallee.bump', {});
      return rawHop(ctx, CALLEE, CALLEE_SVC, 'holds', as, {ctx: {appKey: 'forged-key', username: 'forged-user', isAdmin: true, billingKey: 'forged-key'}}, true);
    }
    // R2-1 Task 5: what ctx.caller is, and `as` refused, in either mode
    case 'seeCaller': return {output: {code: null, message: null, n: null, holds: {callerKeys: Object.keys(ctx.caller || {}).sort(), id: ctx.caller ? ctx.caller.id : null}}};
    case 'asRefused': return new Promise((resolve) => ctx.serviceClient({deviceID: CALLEE, serviceID: CALLEE_SVC, as: 'someone'},
      (e) => resolve({output: {code: (e != null) ? String(e.code || 'NO_CODE') : null, message: (e != null) ? String(e.message).slice(0, 200) : null, n: null}})));
    case 'clientOtherDevice': return viaClient(ctx, OTHER, OTHER_SVC, 'double', as);
    case 'clientOtherAction': return viaClient(ctx, CALLEE, CALLEE_SVC, 'tick', as);
    case 'rawHopOtherDevice': {
      await ctx.call('token-callee/tokenCallee.bump', {});   // the declared hop first: its token is read off the send path
      return rawHop(ctx, OTHER, OTHER_SVC, 'double', as);
    }
    case 'rawHopOtherAction': {
      await ctx.call('token-callee/tokenCallee.bump', {});
      return rawHop(ctx, CALLEE, CALLEE_SVC, 'tick', as);
    }
    case 'loadSecondCode': {
      // the lower-level entry, which skips loadModuleFromPath
      const CHUtil = runtime();
      const mm = (CHUtil != null && CHUtil.dm != null) ? CHUtil.dm.moduleManager : null;
      if (mm == null) return {output: {code: 'NO_RUNTIME', message: null, n: null}};
      return new Promise((resolve) => mm.loadModuleCode('/app', 'declare-caller-twin', '1.0.0', (e) => resolve(answer(e, null))));
    }
    case 'loadSecond': {
      const CHUtil = runtime();
      const mm = (CHUtil != null && CHUtil.dm != null) ? CHUtil.dm.moduleManager : null;
      if (mm == null) return {output: {code: 'NO_RUNTIME', message: null, n: null}};
      // what module code that reaches the manager would try first: clear
      // whatever the manager holds about the module it runs
      for (const k of Object.keys(mm)) if (/module/i.test(k) && typeof(mm[k]) === 'string') mm[k] = null;
      return new Promise((resolve) => mm.loadModuleFromPath('/app', 'declare-caller-twin', '1.0.0', (e) => resolve(answer(e, null))));
    }
    // whether the key named in input.as appears in this worker's own record
    // of its composition (it must not: a debug-bound module gets a placeholder)
    case 'seeComposition': {
      const CHUtil = runtime();
      const dm = (CHUtil != null) ? CHUtil.dm : null;
      if (dm == null || dm.deviceMap == null) return {output: {code: 'NO_RUNTIME', message: null, n: null}};
      const comps = Object.values(dm.deviceMap).map((dev) => (dev != null ? dev._composition : null));
      return {output: {code: JSON.stringify(comps).includes(as) ? 'KEY_SEEN' : null, message: null, n: comps.length}};
    }
    default: return {output: {code: 'BAD_ROUTE', message: null, n: null}};
  }
};

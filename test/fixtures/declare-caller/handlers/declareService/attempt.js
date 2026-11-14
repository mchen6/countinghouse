const {state, forgeToWorker, reachable, forgedPost} = require('../../lib/reach');

// the device ids come with the call (the test derives them as the runtime does)
const CALLEE_SVC = 'urn:countinghouse-test:serviceID:tokenCallee';
const OTHER_SVC = 'urn:countinghouse-test:serviceID:calleeService';

const answer = (e, data) => ({output: {code: (e != null) ? String(e.code || 'NO_CODE') : null, message: (e != null) ? String(e.message).slice(0, 200) : null,
  n: (e == null && data != null && data.output != null && typeof(data.output.n) === 'number') ? data.output.n : null}});
const invoke = (client, actionName, input) => new Promise((resolve) => client.invoke({actionName, input}, (e, d) => resolve(answer(e, d))));
const inputFor = (actionName) => (actionName === 'double' ? {n: 1} : {});
const viaClient = (ctx, deviceID, serviceID, actionName, as) => new Promise((resolve) =>
  ctx.serviceClient({deviceID, serviceID, as}, (e, client) => (e != null ? resolve(answer(e)) : invoke(client, actionName, inputFor(actionName)).then(resolve))));

// A hop built by hand with the call's own token (read off the worker's
// send path), sent as the runtime's own messages are: the peer invoke on the
// open channel, a channel request for a device with none, or the routed
// message to the main thread.
// extra: more fields on the hop's args (a forged ctx); keep: the callee's
// output is passed on as `holds`
const codeOf = (m) => ({code: (m.errCode != null) ? m.errCode : (m.errMsg != null ? 'NO_CODE' : null), message: m.errMsg});
function rawHop(ctx, deviceID, serviceID, actionName, as, extra, keep) {
  const args = Object.assign({input: inputFor(actionName), token: state.lastToken}, extra || {});
  const done = (resolve) => (m) => {
    if (m == null) return resolve({output: {code: 'NO_REPLY', message: null, n: null}});
    const {code, message} = codeOf(m);
    if (code != null) return resolve({output: {code: String(code), message: (message != null) ? String(message).slice(0, 200) : null, n: null}});
    if (keep === true) return resolve({output: {code: null, message: null, n: null, holds: (m.data != null && m.data.output != null) ? m.data.output : null}});
    return resolve(answer(null, m.data));
  };
  if (state.port != null && state.announce != null) {
    const channelOpen = state.channelRequest == null || state.channelRequest.targetDeviceID === deviceID;
    if (!channelOpen) {
      // no channel to that device's worker: ask for one, as the runtime does
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({output: {code: 'NO_REPLY', message: null, n: null}}), 5000);
        const onMsg = (m) => {
          if (m == null || m.targetDeviceID !== deviceID || (m.command !== 'peer-channel-deny' && m.command !== 'peer-channel-grant')) return;
          clearTimeout(timer);
          state.parent.off('message', onMsg);
          resolve({output: {code: (m.command === 'peer-channel-grant') ? 'GRANTED' : String(m.errCode || 'PEER_CHANNEL_DENIED'), message: m.errMsg || null, n: null}});
        };
        state.parent.on('message', onMsg);
        forgedPost(state.parent, {id: state.nextId++, category: 'child', command: 'peer-channel-request', errMsg: null,
          data: {targetDeviceID: deviceID, appKey: as, token: state.lastToken}});
      });
    }
    return new Promise((resolve) => {
      const id = Number(state.announce.invokeId) + 100000 + (state.nextId++ % 1000);
      const timer = setTimeout(() => resolve({output: {code: 'NO_REPLY', message: null, n: null}}), 5000);
      const onReply = (m) => {
        if (m == null || m.category !== 'peer-reply' || m.id !== id) return;
        clearTimeout(timer);
        state.port.off('message', onReply);
        done(resolve)(m);
      };
      state.port.on('message', onReply);
      forgedPost(state.parent, {id: state.nextId++, category: 'child', command: 'peer-announce', errMsg: null,
        data: {channel: state.announce.channel, invokeId: id, token: state.lastToken}});
      forgedPost(state.port, Object.assign({id: id, command: 'peer-invoke', deviceID, serviceID, actionName, input: args.input, billingKey: as}, (extra != null) ? {ctx: extra.ctx} : {}));
    });
  }
  if (state.parent == null) return Promise.resolve({output: {code: 'NO_RUNTIME', message: null, n: null}});
  return new Promise((resolve) => {
    const id = state.nextId++;
    const timer = setTimeout(() => resolve({output: {code: 'NO_REPLY', message: null, n: null}}), 5000);
    const onReply = (m) => {
      if (m == null || m.command !== 'invoke-action-reply' || m.msgID !== id) return;
      clearTimeout(timer);
      state.parent.off('message', onReply);
      done(resolve)(m);
    };
    state.parent.on('message', onReply);
    forgedPost(state.parent, {id: id, category: 'child', command: 'invokeforeignaction', errMsg: null,
      data: {appKey: as, billingKey: as, deviceID, serviceID, actionName, args, token: state.lastToken}});
  });
}

// What module code would try to load a second module into its worker: the
// main thread's own load message, made up and delivered to the worker's
// listener. The lean worker runs one module, and refuses.
async function loadSecond() {
  const m = await forgeToWorker({command: 'load-module', path: '/app', name: 'declare-caller-twin', version: '1.0.0', deviceConfig: null});
  if (m == null) return {output: {code: 'NO_REPLY', message: null, n: null}};
  const {code, message} = codeOf(m);
  return {output: {code: (code != null) ? String(code) : null, message: (message != null) ? String(message).slice(0, 200) : null, n: null}};
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
    // the lower-level entries a full worker had (loadModuleCode,
    // loadModuleFromPath) are gone with it: one load message, one answer
    case 'loadSecondCode': return loadSecond();
    case 'loadSecond': return loadSecond();
        // whether the key named in input.as appears in anything this module
    // reaches (it must not: a debug-bound module gets a placeholder, and the
    // lean worker's own record of its composition is out of its reach)
    case 'seeComposition': return {output: {code: reachable(as) ? 'KEY_SEEN' : null, message: null, n: null}};
    default: return {output: {code: 'BAD_ROUTE', message: null, n: null}};
  }
};

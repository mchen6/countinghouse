// A module that forges a direct peer channel invoke from its own realm (the
// callee must serve only the devices granted on that channel; review R2-2).
// Since lean worker step 3 the runtime's peer state is out of a module's
// reach (CHUtil has no ci or dm; countinghouse-util's read as undefined in a
// worker), so it does what code sharing the worker's realm still can: it
// hooks MessagePort.prototype.postMessage, takes the parent port, the
// channel's port, the channel's name and the call's token from the
// runtime's own posts for a granted invoke, then announces and posts its own
// invoke on that channel for a device the channel was not granted.
const SERVICE = 'urn:countinghouse-test:serviceID:dynService';
const outcome = (e, d) => (e != null ? `error: ${e.code || e.message}` : `ok: ${JSON.stringify(d)}`);

const state = globalThis.__peerForge || (globalThis.__peerForge = {announce: null, parent: null, port: null, hooked: false});
if (!state.hooked && typeof(globalThis.MessagePort) === 'function') {
  state.hooked = true;
  const post = globalThis.MessagePort.prototype.postMessage;
  globalThis.MessagePort.prototype.postMessage = function(m, ...rest) {
    try {
      if (m != null && m.command === 'peer-announce' && m.data != null) { state.announce = m.data; state.parent = this; }
      if (m != null && m.command === 'peer-invoke') state.port = this;
    } catch (e) { /* never break the worker */ }
    return post.call(this, m, ...rest);
  };
}

function forge(deviceID, billingKey) {
  return new Promise((resolve) => {
    const {announce, parent, port} = state;
    if (announce == null || parent == null || port == null) return resolve('no channel');
    const id = Number(announce.invokeId) + 100000;
    const timer = setTimeout(() => resolve('error: no reply'), 5000);
    const onReply = (m) => {
      if (m == null || m.category !== 'peer-reply' || m.id !== id) return;
      clearTimeout(timer);
      port.off('message', onReply);
      resolve(m.errMsg != null ? `error: ${m.errCode || m.errMsg}` : `ok: ${JSON.stringify(m.data)}`);
    };
    port.on('message', onReply);
    parent.postMessage({id: 900000 + id, category: 'child', command: 'peer-announce', errMsg: null,
      data: {channel: announce.channel, invokeId: id, token: announce.token}});
    port.postMessage({id: id, command: 'peer-invoke', deviceID: deviceID, serviceID: SERVICE, actionName: 'hello', input: {}, billingKey: billingKey});
  });
}

module.exports = {
  forgeService: {
    forge: async (input, ctx) => {
      // the channel is opened by a hop made the proper way (its request
      // carries the call's token; one forged without it is denied)
      const granted = await new Promise((resolve) => ctx.serviceClient({deviceID: input.granted, serviceID: SERVICE, as: input.appKey},
        (ce, client) => (ce != null ? resolve(outcome(ce)) : client.invoke({actionName: 'hello', input: {}}, (e, d) => resolve(outcome(e, d))))));
      const other = await forge(input.other, input.appKey);
      return {output: {granted: granted, other: other}};
    }
  }
};

// A module that forges a direct peer channel invoke from its own realm (the
// callee must serve only the devices granted on that channel; review R2-2).
// The lean worker's peer state is out of a module's reach (CHUtil has no ci
// or dm; countinghouse-util's read as undefined in a worker), and since #170
// the port to the main thread is pinned under audit and enforce. A peer
// channel's own port is not: the module hooks MessagePort.prototype
// .postMessage, takes the channel's port from the runtime's own invoke on
// it, and posts its own invoke there for a device the channel was not
// granted. Since lean worker step 4 (the review of #202) the port carries an
// invoke's id alone: its target is the caller's announcement to the main
// thread, which the module did not make, so the callee's match finds none
// and the invoke is refused CALL_TOKEN_INVALID; the device it names is never
// read. (An announcement naming a device the channel's callee does not host
// is refused PEER_NOT_GRANTED: composition 18's unit cases.)
// Since PR-c the runtime posts on a peer channel's port with methods it took
// at boot, so the hook never sees that port: the module has no channel to
// post on ('no channel'), which test/direct-peer-channels/07 asserts. The
// callee's refusal of an invoke no announcement matches stays covered
// server-free (composition 18: "a metering request with no announcement is
// held, then refused"). The other device is also asked for the proper way,
// by a hop of its own (otherByHop).
const SERVICE = 'urn:countinghouse-test:serviceID:dynService';
const outcome = (e, d) => (e != null ? `error: ${e.code || e.message}` : `ok: ${JSON.stringify(d)}`);

const state = globalThis.__peerForge || (globalThis.__peerForge = {port: null, nextId: 3000000, hooked: false});
if (!state.hooked && typeof(globalThis.MessagePort) === 'function') {
  state.hooked = true;
  const post = globalThis.MessagePort.prototype.postMessage;
  globalThis.MessagePort.prototype.postMessage = function(m, ...rest) {
    try { if (m != null && m.command === 'peer-invoke') state.port = this; } catch (e) { /* never break the worker */ }
    return post.call(this, m, ...rest);
  };
}

function forge(deviceID) {
  return new Promise((resolve) => {
    const port = state.port;
    if (port == null) return resolve('no channel');
    const id = state.nextId++;
    const timer = setTimeout(() => resolve('error: no reply'), 5000);
    const onReply = (m) => {
      if (m == null || m.category !== 'peer-reply' || m.id !== id) return;
      clearTimeout(timer);
      port.off('message', onReply);
      resolve(m.errMsg != null ? `error: ${m.errCode || m.errMsg}` : `ok: ${JSON.stringify(m.data)}`);
    };
    port.on('message', onReply);
    port.postMessage({id: id, command: 'peer-invoke', deviceID: deviceID, serviceID: SERVICE, actionName: 'hello', input: {}});
  });
}

module.exports = {
  forgeService: {
    forge: async (input, ctx) => {
      // the channel is opened by a hop made the proper way (its request
      // carries the call's token; one forged without it is denied)
      const granted = await new Promise((resolve) => ctx.serviceClient({deviceID: input.granted, serviceID: SERVICE},
        (ce, client) => (ce != null ? resolve(outcome(ce)) : client.invoke({actionName: 'hello', input: {}}, (e, d) => resolve(outcome(e, d))))));
      const other = await forge(input.other);
      // the other device the proper way: a hop of its own (authorized as the
      // identity that runs this module, under a grant of its own)
      const otherByHop = await new Promise((resolve) => ctx.serviceClient({deviceID: input.other, serviceID: SERVICE},
        (ce, client) => (ce != null ? resolve(outcome(ce)) : client.invoke({actionName: 'hello', input: {}}, (e, d) => resolve(outcome(e, d))))));
      return {output: {granted: granted, other: other, hooked: state.hooked, otherByHop: otherByHop}};
    }
  }
};

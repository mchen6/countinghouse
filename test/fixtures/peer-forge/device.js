// Module code reaches its worker's peer channels (CHUtil.ci.deviceManager, a
// documented gap), so once a channel to a worker is open for one granted
// device it can post an invoke for any other device that worker hosts. The
// callee must serve only the devices granted on that channel (review R2-2).
const SERVICE = 'urn:countinghouse-test:serviceID:dynService';
const outcome = (e, d) => (e != null ? `error: ${e.code || e.message}` : `ok: ${JSON.stringify(d)}`);

module.exports = {
  forgeService: {
    forge: async (input) => {
      const dm = CHUtil.ci.deviceManager;
      const granted = await new Promise((resolve) => dm.invokeActionViaPeerChannel(input.appKey, input.appKey, input.granted,
        SERVICE, 'hello', {input: {}}, (e, d) => resolve(outcome(e, d))));
      const channel = dm.peerChannels[dm.peerDeviceWorkerMap[input.granted]];
      if (channel == null) return {output: {granted: granted, other: 'no channel'}};
      const other = await new Promise((resolve) => channel.invoke(input.other, SERVICE, 'hello', {}, 5000,
        (e, d) => resolve(outcome(e, d)), input.appKey));
      return {output: {granted: granted, other: other}};
    }
  }
};

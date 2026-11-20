// probe.js -- calls worker-end's ping on input.deviceID, as the module's
// binding, and fails with whatever code the hop answered
// (test/composition/16).
module.exports = (input, ctx) => new Promise((resolve, reject) => {
  ctx.serviceClient({deviceID: input.deviceID, serviceID: 'urn:countinghouse-test:serviceID:endService'}, (err, client) => {
    if (err != null) return reject(err);
    return client.invoke({actionName: 'ping', input: {}}, (e) => (e != null ? reject(e) : resolve({output: {}})));
  });
});

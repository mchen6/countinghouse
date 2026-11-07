// probe.js -- calls worker-end's ping on input.deviceID as input.as (a raw
// identity, which is what ctx.serviceClient takes today) and fails with
// whatever code the hop answered (test/composition/16).
module.exports = (input, ctx) => new Promise((resolve, reject) => {
  ctx.serviceClient({deviceID: input.deviceID, serviceID: 'urn:countinghouse-test:serviceID:endService', as: input.as}, (err, client) => {
    if (err != null) return reject(err);
    return client.invoke({actionName: 'ping', input: {}}, (e) => (e != null ? reject(e) : resolve({output: {}})));
  });
});

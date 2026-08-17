// Calls echo-device-module without metering itself -- the platform charges the
// hop automatically (D5). The client is built per call from ctx, so the hop is
// billed to whoever called this tool.
const ECHO_DEVICE_ID = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767';
const ECHO_SERVICE   = 'urn:countinghouse-com:serviceID:echoService';

// authorization identity for the inner hop; needs a grant to echo-device
const AS_IDENTITY = 'aabbcc';

function clientFor(ctx, serviceID) {
  return new Promise((resolve, reject) => {
    ctx.serviceClient({deviceID: ECHO_DEVICE_ID, serviceID: serviceID, as: AS_IDENTITY},
      (err, client) => (err != null) ? reject(err) : resolve(client));
  });
}

function invoke(client, actionName, input) {
  return new Promise((resolve, reject) => {
    client.invoke({actionName: actionName, input: input},
      (err, data) => (err != null) ? reject(err) : resolve(data));
  });
}

module.exports = async (input, ctx) => {
  const client = await clientFor(ctx, ECHO_SERVICE);
  return invoke(client, 'echo',
    {foo: [{item1: 'dsf', item2: false, item3: 1233}], bar: 'test', baz: 12334});
};

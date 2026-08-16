// Calls echo-device-module without metering itself -- the platform charges the
// hop automatically (D5). 6.0.0 shape: the client is built per call from ctx,
// so the hop is billed to whoever called this tool.
const ECHO_DEVICE_ID = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767';
const ECHO_SERVICE   = 'urn:countinghouse-com:serviceID:echoService';

// authorization identity for the inner hop; needs a grant to echo-device
const AS_IDENTITY = 'aabbcc';

module.exports = (input, ctx, callback) => {
  ctx.serviceClient({deviceID: ECHO_DEVICE_ID, serviceID: ECHO_SERVICE, as: AS_IDENTITY}, (err, client) => {
    if (err != null) return callback(err, null);

    client.invoke({actionName: 'echo',
                   input: {foo: [{item1: 'dsf', item2: false, item3: 1233}], bar: 'test', baz: 12334}},
      (iErr, data) => callback(null, data));
  });
};

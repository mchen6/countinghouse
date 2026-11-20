// Calls echo-device-module without metering itself -- the platform charges the
// hop automatically (D5). The client is built per call from ctx, so the hop is
// billed to whoever called this tool.
const ECHO_DEVICE_ID = 'e18f97d6-340a-5517-be3a-91820edc1075';
const ECHO_SERVICE   = 'urn:countinghouse-com:serviceID:echoService';

function clientFor(ctx, serviceID) {
  return new Promise((resolve, reject) => {
    ctx.serviceClient({deviceID: ECHO_DEVICE_ID, serviceID: serviceID},
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

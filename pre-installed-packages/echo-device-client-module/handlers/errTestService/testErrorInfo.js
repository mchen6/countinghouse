// Passes the caller's input through to echo-device-module's own error-info
// action, so error shapes can be inspected across an in-process hop.
const ECHO_DEVICE_ID = 'e18f97d6-340a-5517-be3a-91820edc1075';
const ERR_SERVICE    = 'urn:countinghouse-com:serviceID:errorInfoTestService';

module.exports = async (input, ctx) => {
  const client = await new Promise((resolve, reject) => {
    ctx.serviceClient({deviceID: ECHO_DEVICE_ID, serviceID: ERR_SERVICE},
      (err, c) => (err != null) ? reject(err) : resolve(c));
  });

  const data = await new Promise((resolve, reject) => {
    client.invoke({actionName: 'testErrorInfo', input: input},
      (err, d) => (err != null) ? reject(err) : resolve(d));
  });

  return {output: data};
};

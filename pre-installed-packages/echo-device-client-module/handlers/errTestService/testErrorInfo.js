// Passes the caller's input through to echo-device-module's own error-info
// action, so error shapes can be inspected across an in-process hop.
const ECHO_DEVICE_ID = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767';
const ERR_SERVICE    = 'urn:countinghouse-com:serviceID:errorInfoTestService';

const AS_IDENTITY = 'aabbcc';

module.exports = (input, ctx, callback) => {
  ctx.serviceClient({deviceID: ECHO_DEVICE_ID, serviceID: ERR_SERVICE, as: AS_IDENTITY}, (err, client) => {
    if (err != null) return callback(err, null);

    client.invoke({actionName: 'testErrorInfo', input: input}, (iErr, data) => {
      if (iErr) return callback(iErr, data);
      return callback(null, {output: data});
    });
  });
};

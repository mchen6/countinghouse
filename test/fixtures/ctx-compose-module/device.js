// Composition through ctx, with the two identities kept apart:
//   `as`        -> who the inner hop is AUTHORIZED as (this module's identity)
//   ctx.caller  -> who the inner hop is BILLED to (the real outer caller)
//
// The caller therefore does not need a grant to echo-device-module, but still
// pays for the hop it caused.
const ECHO_DEVICE_ID = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767';
const ECHO_SERVICE   = 'urn:countinghouse-com:serviceID:echoService';
const AS_IDENTITY    = 'ctx-compose-internal';

module.exports = {
  composeService: {
    compose: (input, ctx, callback) => {
      ctx.serviceClient({deviceID: ECHO_DEVICE_ID, serviceID: ECHO_SERVICE, as: AS_IDENTITY},
        (err, client) => {
          if (err != null) return callback(err, null);

          client.invoke({actionName: 'echo', input: {foo: [], bar: input.text}}, (iErr, data) => {
            if (iErr != null) return callback(iErr, null);
            return callback(null, {output: {
              echoed:   (data != null && data.output != null) ? data.output.bar : null,
              billedTo: ctx.caller.apiKey
            }});
          });
        });
    }
  }
};

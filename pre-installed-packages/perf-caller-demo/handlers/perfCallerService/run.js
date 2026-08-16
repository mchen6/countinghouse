// Times one in-process hop to perf-callee-demo. Used by perf/ to measure the
// cross-worker call paths, so the timed region stays as tight as possible:
// the client is resolved before the clock starts.
const CALLEE_DEVICE_ID = 'fb9fbd3d-5860-538e-b0b7-9f5e34389577'; // perf-callee-demo
const CALLEE_SERVICE   = 'urn:countinghouse-com:serviceID:perfCalleeService';

const AS_IDENTITY = 'perf-caller-demo-internal';

module.exports = (input, ctx, callback) => {
  if (input == null || typeof(input.payloadSizeBytes) !== 'number') {
    return callback(new DeviceError('ARGUMENTS_INVALID'), null);
  }

  const data = 'x'.repeat(input.payloadSizeBytes);

  ctx.serviceClient({deviceID: CALLEE_DEVICE_ID, serviceID: CALLEE_SERVICE, as: AS_IDENTITY},
    (err, client) => {
      if (err != null) {
        return callback(new DeviceError('DEVICE_ACTION_CALL_FAIL', err.message), null);
      }

      const start = process.hrtime.bigint();
      client.invoke({actionName: 'echoPayload', input: {data: data}}, (iErr) => {
        if (iErr != null) return callback(new DeviceError('DEVICE_ACTION_CALL_FAIL', iErr.message), null);

        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        return callback(null, {output: {durationMs: durationMs}});
      });
    });
};

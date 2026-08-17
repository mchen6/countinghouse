// Times one in-process hop to perf-callee-demo. Used by perf/ to measure the
// cross-worker call paths, so the timed region stays as tight as possible:
// the client is resolved before the clock starts.
const CALLEE_DEVICE_ID = 'fb9fbd3d-5860-538e-b0b7-9f5e34389577'; // perf-callee-demo
const CALLEE_SERVICE   = 'urn:countinghouse-com:serviceID:perfCalleeService';

// the identity the inner hop is AUTHORIZED as; billing goes to ctx.caller
const AS_IDENTITY = 'perf-caller-demo-internal';

function clientFor(ctx) {
  return new Promise((resolve, reject) => {
    ctx.serviceClient({deviceID: CALLEE_DEVICE_ID, serviceID: CALLEE_SERVICE, as: AS_IDENTITY},
      (err, client) => (err != null) ? reject(err) : resolve(client));
  });
}

function invoke(client, input) {
  return new Promise((resolve, reject) => {
    client.invoke({actionName: 'echoPayload', input: input},
      (err, data) => (err != null) ? reject(err) : resolve(data));
  });
}

module.exports = async (input, ctx) => {
  if (input == null || typeof(input.payloadSizeBytes) !== 'number') {
    throw new DeviceError('ARGUMENTS_INVALID');
  }

  const data = 'x'.repeat(input.payloadSizeBytes);

  let client;
  try {
    client = await clientFor(ctx);
  } catch (e) {
    throw new DeviceError('DEVICE_ACTION_CALL_FAIL', e.message);
  }

  const start = process.hrtime.bigint();
  try {
    await invoke(client, {data: data});
  } catch (e) {
    throw new DeviceError('DEVICE_ACTION_CALL_FAIL', e.message);
  }

  return {output: {durationMs: Number(process.hrtime.bigint() - start) / 1e6}};
};

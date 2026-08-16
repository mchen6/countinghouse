function run(args, callback) {
  const input = args.input;

  if (input == null || typeof(input.payloadSizeBytes) !== 'number') {
    return callback(new DeviceError('ARGUMENTS_INVALID'), null);
  }

  if (this.calleeClient == null) {
    return callback(new DeviceError('DEVICE_ACTION_CALL_FAIL', 'callee service client not ready yet'), null);
  }

  const data = 'x'.repeat(input.payloadSizeBytes);

  const start = process.hrtime.bigint();
  this.calleeClient.invoke({actionName: 'echoPayload', input: {data: data}}, (err) => {
    if (err != null) return callback(new DeviceError('DEVICE_ACTION_CALL_FAIL', err.message), null);

    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    return callback(null, {output: {durationMs: durationMs}});
  });
}

module.exports = run;

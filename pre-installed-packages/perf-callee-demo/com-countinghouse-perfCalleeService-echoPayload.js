function echoPayload(args, callback) {
  const input = args.input;
  if (input == null || typeof(input.data) !== 'string') {
    return callback(new DeviceError('ARGUMENTS_INVALID'), null);
  }
  return callback(null, {output: {data: input.data}});
}

module.exports = echoPayload;

function uppercase(args, callback) {
  const input = args.input;
  if (input == null || typeof(input.text) !== 'string') {
    return callback(new DeviceError('ARGUMENTS_INVALID'), null);
  }
  return callback(null, {
    output: {text: input.text.toUpperCase()}
  });
}

module.exports = uppercase;

module.exports = (input, ctx, callback) => {
  if (input == null || typeof(input.data) !== 'string') {
    return callback(new DeviceError('ARGUMENTS_INVALID'), null);
  }
  return callback(null, {output: {data: input.data}});
}

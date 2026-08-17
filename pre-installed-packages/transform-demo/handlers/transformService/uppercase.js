// Throw a DeviceError to fail a call -- a typed error keeps its own code
// whether it is thrown or passed to a callback.
module.exports = async (input, ctx) => {
  if (input == null || typeof(input.text) !== 'string') {
    throw new DeviceError('ARGUMENTS_INVALID');
  }
  return {output: {text: input.text.toUpperCase()}};
};

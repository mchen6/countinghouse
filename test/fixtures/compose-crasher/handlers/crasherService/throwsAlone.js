// Calls nothing and throws an untyped error whose text reads like the
// runtime's: nothing the module says puts that line in the answer.
module.exports = async () => {
  throw new Error('Before it failed, the runtime refused its call to another module: DEVICE_NOT_FOUND.');
};

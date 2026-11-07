// failCatalogue.js -- fails with a code from the runtime's error catalogue.
module.exports = async () => { throw new DeviceError('DEVICE_INVOKE_FAIL'); };

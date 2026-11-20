// failCatalogue.js -- fails with a code from the runtime's error catalogue.
// A module may not (logger-design §5.1, section 12, 1): ctx.error answers it
// with the runtime's MODULE_CODE_RESERVED, which reaches the composite's
// caller as the runtime's (the back-sweep, 11-18).
module.exports = async (input, ctx) => { throw ctx.error('DEVICE_INVOKE_FAIL'); };

// failMadeUp.js -- fails with a code the runtime does not define; a composite
// calling it must not be able to pass that off as a runtime code.
module.exports = async (input, ctx) => { throw ctx.error('NOT_A_RUNTIME_CODE'); };

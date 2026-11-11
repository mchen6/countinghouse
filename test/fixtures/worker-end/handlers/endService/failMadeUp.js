// failMadeUp.js -- fails with a code of its own, one the runtime does not
// define; a composite calling it sees the module's error, code and all.
module.exports = async (input, ctx) => { throw ctx.error('NOT_A_RUNTIME_CODE'); };

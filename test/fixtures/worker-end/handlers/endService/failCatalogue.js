// failCatalogue.js -- fails with a code from the runtime's error catalogue.
// A deliberate rule-breaker (logger-design §5.1: a module raises only its own
// codes), kept until §5.4 decides how a callee's code crosses a hop: today a
// runtime code from a callee reaches the composite's caller
// (test/composition/15). The step-1 inventory names it as the one exception.
module.exports = async (input, ctx) => { throw ctx.error('DEVICE_INVOKE_FAIL'); };

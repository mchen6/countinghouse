// Same signature, one file per action. Async form: return {output}, no callback.
module.exports = async (input, ctx) => ({
  output: {text: `hello ${input.name}`, caller: ctx.caller.apiKey}
});

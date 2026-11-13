// Handler map in the 6.0.0 signature: (input, ctx, callback).
// `input` is the validated input object -- no args.input unwrapping. `ctx`
// replaces the Device instance that used to be bound as `this`.
module.exports = {
  greetService: {
    hello: (input, ctx, callback) => callback(null, {
      output: {text: `hello ${input.name}`, caller: ctx.caller.apiKey}
    })
  }
};

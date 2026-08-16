// Handler map: top-level key is the service *short* name, second level the
// action name. No URN, no index.js, no setAction, no _getDeviceRootSchema --
// the framework resolves all of that from api.json and schema.json.
//
// Signature is still the 5.x (args, callback) contract; the (input, ctx) form
// in design section 3.3 arrives with ctx in a later step.
module.exports = {
  greetService: {
    hello: (args, callback) => callback(null, {output: {text: `hello ${args.input.name}`}})
  }
};

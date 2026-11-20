// Composition through ctx, with the two identities kept apart:
//   `as`        -> who the inner hop is AUTHORIZED as (this module's identity)
//   ctx.caller  -> who the inner hop is BILLED to (the real outer caller)
//
// The caller therefore does not need a grant to echo-device-module, but still
// pays for the hop it caused.
// The hop by name (ctx.call), as package.json's "countinghouse.calls"
// declares it: the runtime resolves it to its device.
const ECHO = 'echo-device/echoService.echo';

module.exports = {
  composeService: {
    compose: (input, ctx, callback) => {
      ctx.call(ECHO, {foo: [], bar: input.text}).then((data) => callback(null, {output: {
        echoed:   (data != null && data.output != null) ? data.output.bar : null,
        billedTo: ctx.caller.id
      }}), (err) => callback(err, null));
    }
  }
};

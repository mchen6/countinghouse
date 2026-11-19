// callByName.js -- calls worker-end's ping by its name (ctx.call), as the
// module's binding, and fails with whatever the call answered: the
// queryDeviceSpec path, beside probe.js's ctx.serviceClient
// (test/composition/16).
module.exports = async (input, ctx) => {
  await ctx.call('worker-end/endService.ping', {});
  return {output: {}};
};

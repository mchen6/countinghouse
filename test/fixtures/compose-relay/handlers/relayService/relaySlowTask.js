// As a task (composition 25, routed): a hop that times out, a call that goes
// through, then the first hop's late answer arrives (refused by the main
// thread's validator) before this throws. That late refusal is not this
// call's: no sentence may name it.
module.exports = async (input, ctx) => {
  try {
    await ctx.call('compose-slowbad/slowService.slowBad', {});
  } catch (e) {
    // its hop timed out; the call goes on
  }
  await ctx.call('compose-callee/calleeService.double', {n: 2});
  // (the part answers at 4 s, 2 s after its hop's timeout; this waits to 7 s)
  await new Promise((resolve) => setTimeout(resolve, 5000));
  throw new Error('the relay failed');
};

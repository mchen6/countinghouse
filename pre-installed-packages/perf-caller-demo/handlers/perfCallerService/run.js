// Times one in-process hop to perf-callee-demo, called by name (ctx.call), as
// package.json's "countinghouse.calls" declares it: the runtime resolves it
// to its device (a parse and a hash per call, inside the timed region, with
// its client kept between calls).
const CALLEE = 'perf-callee-demo/perfCalleeService.echoPayload';

module.exports = async (input, ctx) => {
  if (input == null || typeof(input.payloadSizeBytes) !== 'number') {
    return ctx.error('INPUT_REJECTED', 'payloadSizeBytes must be a number');
  }

  const data = 'x'.repeat(input.payloadSizeBytes);

  const start = process.hrtime.bigint();
  try {
    await ctx.call(CALLEE, {data: data});
  } catch (e) {
    return ctx.error('INNER_CALL_FAILED', e.message, {cause: e});
  }

  return {output: {durationMs: Number(process.hrtime.bigint() - start) / 1e6}};
};

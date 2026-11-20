// m15-tasks fixture (M16): reports each of input.values as the task's
// progress, as given (a number, or anything a handler might pass), input.gapMs
// apart, then answers input.holdMs later
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
module.exports = async (input, ctx) => {
  for (const v of (input.values || [])) {
    ctx.job.progress(v);
    await wait(input.gapMs);
  }
  await wait(input.holdMs);
  return {output: {reported: (input.values || []).length}};
};

// m15-tasks fixture (M16): reports each of input.values as the task's
// progress, as given (a number, or anything a handler might pass), then
// answers input.holdMs later
module.exports = async (input, ctx) => {
  for (const v of (input.values || [])) ctx.job.progress(v);
  await new Promise((resolve) => setTimeout(resolve, Number(input.holdMs) || 0));
  return {output: {reported: (input.values || []).length}};
};

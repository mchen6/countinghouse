// late.js -- the first call for a job answers after input.ms (default 6 s),
// long after a short job timeout has failed it. A later call for the same
// job (a retry) answers at once, or, with input.steps, reports progress
// 1..steps every input.stepMs and then answers. Module state tells the two
// apart: both attempts run in this worker.
const seen = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (input, ctx) => {
  const id = ctx != null && ctx.job != null ? String(ctx.job.id) : null;
  if (id != null && !seen.has(id)) {
    seen.add(id);
    await sleep(input != null && input.ms != null ? input.ms : 6000);
    return {output: {ok: true, attempt: 1}};
  }
  const steps = input != null && input.steps != null ? input.steps : 0;
  for (let i = 1; i <= steps; i++) {
    await sleep(input.stepMs != null ? input.stepMs : 400);
    ctx.job.progress(i);
  }
  return {output: {ok: true, attempt: 2}};
};

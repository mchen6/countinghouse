// The invoke args a job's run gets: input and jobID, plus `usageCall` from the
// start hook's extraArgs when it is an integer (local-mode spec §5, step 3b),
// so the run's server calls are counted under its id as a direct call's are.
// Nothing else from extraArgs reaches the worker. No requires, so it is
// testable without the device manager's Redis clients.
function jobArgs(input, jobID, extraArgs) {
  const args = {input: input, jobID: jobID};
  if (extraArgs != null && Number.isInteger(extraArgs.usageCall)) args.usageCall = extraArgs.usageCall;
  return args;
}

module.exports = jobArgs;

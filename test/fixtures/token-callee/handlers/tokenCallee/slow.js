module.exports = async (input) => {
  await new Promise((resolve) => setTimeout(resolve, input.ms));
  globalThis.__tokenCalleeRuns = (globalThis.__tokenCalleeRuns || 0) + 1;
  return {output: {n: globalThis.__tokenCalleeRuns}};
};

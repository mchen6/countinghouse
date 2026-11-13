module.exports = async () => {
  globalThis.__tokenCalleeRuns = (globalThis.__tokenCalleeRuns || 0) + 1;
  return {output: {n: globalThis.__tokenCalleeRuns}};
};

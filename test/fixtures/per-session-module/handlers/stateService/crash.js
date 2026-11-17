// per-session-module fixture: its worker ends just after it answers, as a
// crash would (the worker's uncaught errors are logged, not fatal)
module.exports = async () => {
  setTimeout(() => process.exit(1), 50);
  return {output: {crashing: true}};
};

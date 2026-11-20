// per-session-module fixture: a long-running action whose worker ends
// mid-run, after input.ms, and never answers (a crash under a call)
module.exports = (input) => new Promise(() => {
  setTimeout(() => process.exit(1), Number(input && input.ms) || 200);
});

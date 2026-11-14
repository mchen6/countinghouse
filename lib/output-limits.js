// The caps on what a module's worker sends to be written (the review of
// #186): constants, not options (docs/security-model.md). Shared by the
// worker's side (lib/worker-stdio.js, lib/worker-logger.js) and the main
// thread's (lib/worker-output.js), so the two never disagree.
module.exports = Object.freeze({
  LINE_MAX:      8 * 1024,    // bytes of one output line, "…" included
  STREAM_BUDGET: 256 * 1024,  // bytes a minute, per stream, per worker
  LOG_BUDGET:    1024 * 1024, // bytes a minute of log records, per worker
  FIELD_MAX:     8 * 1024,    // bytes of one log record's field
  WINDOW_MS:     60 * 1000,   // a budget's window
  CUT:           '…'
});

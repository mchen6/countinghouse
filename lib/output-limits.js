// The caps on what a module's worker sends to be written (the review of
// #186): constants, not options (docs/security-model.md). Shared by the
// worker's side (lib/worker-stdio.js, lib/worker-logger.js) and the main
// thread's (lib/worker-output.js), so the two never disagree.
module.exports = Object.freeze({
  LINE_MAX:      8 * 1024,    // bytes of one output line, "…" included
  STREAM_BUDGET: 256 * 1024,  // bytes written a minute, per stream, per worker
  LOG_BUDGET:    1024 * 1024, // bytes a minute of log records, per worker
  FIELD_MAX:     8 * 1024,    // bytes of one log record's field
  WINDOW_MS:     60 * 1000,   // a budget's window
  RECORD_MIN:    256,         // bytes a log record costs before its fields
  ROLL_EVERY_MS: 5000,        // how often a budget's window is looked at
  // The main thread's backstop for one stream: a worker enforces
  // STREAM_BUDGET in its own windows, and any one of the main thread's
  // windows overlaps at most two of them, so an honest worker is never
  // dropped here; one that ignores its budget gets at most this.
  STREAM_BACKSTOP: 2 * 256 * 1024,
  // One output message's lines, counted as their UTF-16 units plus one
  // each: at most about 32 KiB serialized, inside the 64 KiB an envelope
  // has at the smallest --maxOutputBytes.
  BATCH_UNITS:   16 * 1024,
  CUT:           '…'
});

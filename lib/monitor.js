'use strict';
// What is left of the process-level hooks from when this server ran under
// PM2: exit on SIGINT. The rest is gone -- the 'ready' and heap-statistics
// messages --withPM2 sent to the parent process, and a listener that loaded,
// unloaded or restarted a module when the parent said so over IPC. Loading a
// module into a running server goes through the admin-gated HTTP routes or
// the countinghouse_load_module tool, both of which
// docs/cross-cutting-matrix.md accounts for.
//
// SIGTERM (B-shutdown-usage) ends the process as SIGINT does, through
// process.exit, so the 'exit' listeners run (lib/exit-sequence.js: the open
// usage calls ended, then the local store's flush); before, the signal
// ended the process outright and none of them ran. Its code is 143 (128 +
// 15), as a process the signal ended reports; SIGINT's stays 0.
module.exports = {
  init: function() {
    process.on('exit',   this.onProcessExit.bind(this));
    process.on('SIGINT', this.onProcessExit.bind(this));
    process.on('SIGTERM', () => process.exit(143));
  },
  onProcessExit: function() {
    process.exit();
  }
};

// What is left of the process-level hooks from when this server ran under
// PM2: exit on SIGINT. The rest is gone -- the 'ready' and heap-statistics
// messages --withPM2 sent to the parent process, and a listener that loaded,
// unloaded or restarted a module when the parent said so over IPC. Loading a
// module into a running server goes through the admin-gated HTTP routes or
// the countinghouse_load_module tool, both of which
// docs/cross-cutting-matrix.md accounts for.
module.exports = {
  init: function() {
    process.on('exit',   this.onProcessExit.bind(this));
    process.on('SIGINT', this.onProcessExit.bind(this));
  },
  onProcessExit: function() {
    process.exit();
  }
};

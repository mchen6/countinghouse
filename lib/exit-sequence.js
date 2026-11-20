'use strict';
// The runtime's one synchronous sequence at exit (B-shutdown-usage): its
// steps run in the order they were added, each on its own (one that throws
// does not stop the next), once, on the process's 'exit' -- which process.exit
// and the signals the runtime handles (lib/monitor.js) all reach. Put in
// front of the 'exit' listeners already there, so it runs before the local
// store's exit flush (lib/store/json-file.js flushAllOnExit), and what a
// step writes into a store file reaches disk. Nothing asynchronous finishes
// here: a step does its work at once or not at all.
const steps = [];
let registered = false;

function run() {
  for (const step of steps) {
    try { step(); } catch (e) {
      try { process.stderr.write(`exit: a step failed: ${e != null && e.message != null ? e.message : String(e)}\n`); } catch (_) { /* nowhere to say it */ }
    }
  }
}

function atExit(step) {
  steps.push(step);
  if (registered) return;
  registered = true;
  process.prependOnceListener('exit', run);
}

module.exports = {atExit};

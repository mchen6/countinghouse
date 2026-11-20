// Preloaded into a server for perf/fs-broker-trace.js (node --require): every
// call the file broker serves, as [op, first path argument], written to
// $CH_FSB_TRACE_OUT (one JSON line each) as it comes. Perf only: nothing in
// lib/ loads it, and it is never in a server's own options.
const fs = require('fs');
const out = process.env.CH_FSB_TRACE_OUT;
if (out) {
  const {FsBroker} = require('../../lib/fs-broker/broker');
  const handle = FsBroker.prototype.handle;
  FsBroker.prototype.handle = function(op, args) {
    const p = Array.isArray(args) && typeof(args[0]) === 'string' ? args[0] : (Array.isArray(args) && typeof(args[0]) === 'number' ? `fd` : null);
    try { fs.appendFileSync(out, `${JSON.stringify([this.name, op, p])}\n`); } catch (e) { /* tracing only */ }
    return handle.call(this, op, args);
  };
}

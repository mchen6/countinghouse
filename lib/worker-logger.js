// A module worker's own log (countinghouse's code running in the worker,
// not the module's output) goes to the main thread as 'log' messages, each
// an envelope under #170's cap, instead of the worker's stdout: the worker's
// stdout and stderr then carry the module's output alone (lib/worker-stdio.js),
// and a module flooding them cannot crowd the runtime's lines out. The main
// thread writes each record with its own logger, the module named by the
// main thread, under a budget of its own (lib/worker-output.js onLog).
//
// createWorkerLogger() is called once, at the worker's boot, in place of
// LOG.createLogger(false): lib/sandbox.js, and lib/lean-worker.js (#177).
const bunyan = require('bunyan');
const LOG = require('./logger');
const WorkerMessage = require('./worker-message');

// A field's longest, here and again on the main thread: a record never
// comes near the envelope's cap.
const {FIELD_MAX, CUT} = require('./output-limits');
const field = (v) => {
  if (v == null) return undefined;
  const s = String(v);
  return s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX)}${CUT}` : s;
};

// Once per worker: a second call (the lean worker's lazy log() and its
// handler-answer path can both make it) returns the first one's logger.
let created = null;

function createWorkerLogger() {
  if (created != null) return created;
  created = LOG.logger = bunyan.createLogger({
    name: 'countinghouse',
    serializers: {de: LOG.deviceErrorSerializer, e: LOG.errorSerializer},
    streams: [{
      level: 'info',
      type: 'raw',
      stream: {write: (rec) => WorkerMessage.sendLog({level: rec.level, msg: field(rec.msg), e: field(rec.e), de: field(rec.de)})}
    }]
  });
  return created;
}

module.exports = {createWorkerLogger};

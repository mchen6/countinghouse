'use strict';
// A module worker's own log (countinghouse's code running in the worker,
// not the module's output) goes to the main thread as 'log' messages, each
// an envelope under #170's cap, instead of the worker's stdout: the worker's
// stdout and stderr then carry the module's output alone (lib/worker-stdio.js),
// and a module flooding them cannot crowd the runtime's lines out. The main
// thread writes each record with its own logger, the module named by the
// main thread, under a budget of its own (lib/worker-output.js onLog).
//
// createWorkerLogger() is called once, at the worker's boot, in place of
// LOG.createLogger(): lib/sandbox.js, and the lean worker (#177).
//
// No bunyan (#194's PR 1): a worker's logger only builds the record the
// main thread's bunyan writes ({level, msg, e, de, lost}), so it is made of
// countinghouse's own strict code, loaded at boot, and nothing third-party
// is left to load later. The record is what bunyan built from LOG's calls:
// a fields object ({e} or {de}, through LOG's serializers) or a message,
// formatted as bunyan formats one (util.format).
const util = require('util');
const LOG = require('./logger');
const WorkerMessage = require('./worker-message');

// A field's longest, here and again on the main thread: a record (three
// fields of at most 8 Ki UTF-16 units) always fits the envelope at any
// allowed --maxOutputBytes.
const {FIELD_MAX, CUT} = require('./output-limits');
const short = (v) => (v == null ? undefined : `${v.slice(0, FIELD_MAX / 8)}${CUT}`);
const field = (v) => {
  if (v == null) return undefined;
  const s = String(v);
  return s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX)}${CUT}` : s;
};

// Once per worker: a second call (the lean worker's lazy log() and its
// handler-answer path can both make it) returns the first one's logger.
let created = null;
// records not sent since the last one that was
let lost = 0;

// what bunyan made of a call: (fields, ...message) or (...message)
const format = (args) => (args.length === 0 ? '' : util.format(...args));
// a field through the logger's serializer, as bunyan did: one that throws
// (LOG.E(null), a message getter that throws) gives the field bunyan's own
// words instead, and the line is still sent
const serialized = (name, serializer, value) => {
  try {
    return serializer(value);
  } catch (e) {
    return `(Error in Bunyan log "${name}" serializer broke field. See stderr for details.)`;
  }
};
function recordOf(level, args) {
  const first = args[0];
  // an Error first: bunyan's err field, with msg the rest or else its
  // message (never the stack: it would carry host paths to the main
  // thread's log); the record's e is the logger's own serializer's
  if (first instanceof Error) {
    return {level, msg: args.length > 1 ? format(args.slice(1)) : String(serialized('err', (x) => x.message, first)),
      e: serialized('e', LOG.errorSerializer, first)};
  }
  // as bunyan: anything but a plain object (a string, an array) is all
  // message, and a Buffer first is shown as util.inspect shows it
  if (first == null || typeof(first) !== 'object' || Array.isArray(first)) return {level, msg: format(args)};
  if (Buffer.isBuffer(first)) return {level, msg: format([util.inspect(first), ...args.slice(1)])};
  return {level, msg: format(args.slice(1)),
    e: first.e !== undefined ? serialized('e', LOG.errorSerializer, first.e) : undefined,
    de: first.de !== undefined ? serialized('de', LOG.deviceErrorSerializer, first.de) : undefined};
}

function createWorkerLogger() {
  if (created != null) return created;
  // a record that could not be sent is counted, and the count rides with
  // the next one that is: never lost silently
  const write = (rec) => {
    const record = {level: rec.level, msg: field(rec.msg), e: field(rec.e), de: field(rec.de)};
    if (lost > 0) record.lost = lost;
    let r = WorkerMessage.sendLog(record);
    // refused as too large (V8's sizes differ between Node versions):
    // again, each field cut to an eighth
    if (r === 'too-large') r = WorkerMessage.sendLog(Object.assign(record, {msg: short(record.msg), e: short(record.e), de: short(record.de)}));
    if (r === true) lost = 0;
    else lost += 1;
  };
  created = LOG.logger = Object.freeze({
    error: (...args) => write(recordOf(50, args)),
    warn: (...args) => write(recordOf(40, args)),
    info: (...args) => write(recordOf(30, args))
  });
  // a count still held goes before each reply and when the worker ends
  const sayLost = () => { if (lost > 0 && WorkerMessage.sendLog({level: 30, lost}) === true) lost = 0; };
  WorkerMessage.addBeforeReply(sayLost);
  process.on('exit', sayLost);
  return created;
}

module.exports = {createWorkerLogger};

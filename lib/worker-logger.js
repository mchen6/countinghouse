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
// a value as text, never a throw (an object with no toString, a getter that
// throws): what can't be shown says so, and the line is still sent
const textOf = (v) => {
  try {
    return String(v);
  } catch (e) {
    return '(unprintable)';
  }
};
const field = (v) => {
  if (v == null) return undefined;
  const s = textOf(v);
  return s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX)}${CUT}` : s;
};

// Once per worker: a second call (the lean worker's lazy log() and its
// handler-answer path can both make it) returns the first one's logger.
let created = null;
// records not sent since the last one that was
let lost = 0;

// what bunyan made of a call: (fields, ...message) or (...message)
const format = (args) => {
  if (args.length === 0) return '';
  try {
    return util.format(...args);
  } catch (e) {
    return '(unprintable)';
  }
};
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
// a record, never a throw: a first argument whose getters, traps or type
// checks throw (a revoked Proxy) gives the line with what can be said, the
// rest of the message (format never throws), its fields left out
function recordOf(level, args) {
  try {
    return recordOfArgs(level, args);
  } catch (e) {
    // (the rest, unless even that can't be had: module code can set Array's
    // species, which slice reads)
    try {
      return {level, msg: format(args.slice(1))};
    } catch (e2) {
      return {level, msg: '(unprintable)'};
    }
  }
}
function recordOfArgs(level, args) {
  const first = args[0];
  // an Error first: bunyan's err field, which the record never carried
  // (msg/e/de only), with msg the rest or else its message (never the
  // stack: it would carry host paths to the main thread's log)
  if (first instanceof Error) {
    return {level, msg: args.length > 1 ? format(args.slice(1)) : textOf(serialized('err', (x) => x.message, first))};
  }
  // as bunyan: anything but a plain object (a string, an array) is all
  // message, and a Buffer first is shown as util.inspect shows it
  // (null first: bunyan's empty fields, the rest the message)
  if (first === null) return {level, msg: format(args.slice(1))};
  if (first === undefined || typeof(first) !== 'object' || Array.isArray(first)) return {level, msg: format(args)};
  if (Buffer.isBuffer(first)) return {level, msg: format([util.inspect(first), ...args.slice(1)])};
  // each field read once (a getter is asked one time)
  const e = first.e;
  const de = first.de;
  return {level, msg: format(args.slice(1)),
    e: e !== undefined ? serialized('e', LOG.errorSerializer, e) : undefined,
    de: de !== undefined ? serialized('de', LOG.deviceErrorSerializer, de) : undefined};
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

'use strict';
// A module's stdout and stderr under audit and enforce: runtime-owned
// streams in place of Node's own (the review of #186). Node's worker stdio
// streams hold its internal port to the main thread (process.stdout's kPort
// symbol); a message on it that is not stdio is decoded on the main thread
// with no bound, then refused there as an unknown type. So module code
// never gets them: installModuleStdio(), called by the lockdown before any
// module code runs, defines process.stdout, process.stderr and
// process.stdin as fixed getters returning streams of the runtime's, and
// points console at them. What a module writes goes to the main thread as
// 'stdout' and 'stderr' messages (envelopes, #170) through the worker's own
// pinned port, as finished lines, where lib/worker-output.js checks each
// line again and keeps the same budget per stream.
//
// Here, in the worker, each stream splits what is written into lines, cuts
// and cleans each as the main thread will write it (lib/output-lines.js),
// and charges it what writing it costs, the "<module>: " prefix and the
// newline included, against STREAM_BUDGET bytes a minute; past it lines are
// dropped and counted, and so is a batch that could not be sent. The count
// goes to the main thread within DROP_REPORT_MS (a worker that is
// terminated never runs its exit handlers), where it is added up and said
// once a minute. Finished lines are gathered and sent at most every GAP_MS,
// in batches sized to fit the envelope at the smallest --maxOutputBytes,
// split and sent again if the envelope still refuses one as too large.
//
// Under --moduleSandbox off nothing here runs: off decides nothing.
const {Writable, Readable} = require('stream');
const {StringDecoder} = require('string_decoder');
const WorkerMessage = require('./worker-message');
const {STREAM_BUDGET, BATCH_BYTES, ROLL_EVERY_MS} = require('./output-limits');
const {LineSplitter, Budget, lineCost} = require('./output-lines');

const GAP_MS         = 10;
const DROP_REPORT_MS = 1000;
const BYTE_ENCODINGS = new Set(['hex', 'base64', 'base64url']);

// One module stream. send(stream, data) posts {lines} or {dropped} and
// says what happened (true, 'too-large' or false); prefixBytes: "<module>: " as the main thread
// writes it; now() is the clock.
function moduleStream(name, prefixBytes, send, now) {
  const decoder = new StringDecoder('utf8');
  const split = new LineSplitter();
  const budget = new Budget(STREAM_BUDGET, now);
  let pending = [];
  let scheduled = false;
  let lastSent = 0;
  let dropped = 0;
  let dropTimer = null;

  const noteDropped = (n) => {
    dropped += n;
    if (dropTimer == null) {
      dropTimer = setTimeout(reportDropped, DROP_REPORT_MS);
      dropTimer.unref();
    }
  };
  function reportDropped() {
    if (dropTimer != null) clearTimeout(dropTimer);
    dropTimer = null;
    if (dropped > 0 && send(name, {dropped}) === true) dropped = 0;
  }
  const roll = () => { budget.roll(); reportDropped(); };
  // A batch the envelope refuses as too large is halved and sent again: the
  // estimate below sizes it, what the envelope measures decides (V8's sizes
  // differ between Node versions). A line alone is far under the cap.
  const sendBatch = (lines) => {
    const r = send(name, {lines});
    if (r === true) return;
    if (r === 'too-large' && lines.length > 1) {
      const half = Math.ceil(lines.length / 2);
      sendBatch(lines.slice(0, half));
      sendBatch(lines.slice(half));
      return;
    }
    noteDropped(lines.reduce((n, l) => n + lineCost(prefixBytes, l), 0));
  };
  const estimate = (line) => 2 * line.length + 8;
  const flush = () => {
    scheduled = false;
    if (pending.length === 0) return;
    const lines = pending;
    pending = [];
    lastSent = now();
    let batch = [];
    let size = 0;
    for (const line of lines) {
      if (size + estimate(line) > BATCH_BYTES && batch.length > 0) {
        sendBatch(batch);
        batch = [];
        size = 0;
      }
      batch.push(line);
      size += estimate(line);
    }
    sendBatch(batch);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    const wait = GAP_MS - (now() - lastSent);
    if (wait <= 0) setImmediate(flush);
    else setTimeout(flush, wait);
  };
  const accept = (lines) => {
    for (const line of lines) {
      const cost = lineCost(prefixBytes, line);
      if (budget.take(cost)) {
        pending.push(line);
      } else {
        noteDropped(cost);
      }
    }
    if (pending.length > 0) schedule();
  };

  // A string is the text whatever encoding it would be written in, but a
  // hex or base64 string stands for bytes; bytes are read as UTF-8.
  const stream = new Writable({
    decodeStrings: false,
    write(chunk, encoding, callback) {
      const text = typeof(chunk) === 'string'
        ? (BYTE_ENCODINGS.has(String(encoding).toLowerCase()) ? Buffer.from(chunk, encoding).toString('utf8') : chunk)
        : decoder.write(chunk);
      if (text !== '') accept(split.push(text));
      callback();
    }
  });
  // As Node's own worker stdio streams are: a module may test for these.
  stream.isTTY = false;
  stream.fd = name === 'stdout' ? 1 : 2;
  // before a reply, and when the worker ends: an unfinished line goes as a
  // line, never held back or lost with a worker the main thread ends
  const end = () => { accept(split.end()); flush(); reportDropped(); };
  return {stream, flush, roll, reportDropped, end};
}

// The stand-in for process.stdin: a module worker has no input.
function emptyInput() {
  const input = new Readable({read() { this.push(null); }});
  input.fd = 0;
  input.isTTY = false;
  return input;
}

// Replaces the worker's stdio streams for module code (see above). name:
// the module's, as the main thread loaded it (the lockdown's moduleName),
// whose "<module>: " prefix every line is charged for. Returns {stdout,
// stderr} (the module streams).
function installModuleStdio(name, opts) {
  opts = opts || {};
  const send = opts.send || WorkerMessage.sendOutput;
  const now = opts.now || Date.now;
  const prefixBytes = Buffer.byteLength(`${name}: `);
  const originals = {stdout: process.stdout, stderr: process.stderr, stdin: process.stdin};
  const out = moduleStream('stdout', prefixBytes, send, now);
  const err = moduleStream('stderr', prefixBytes, send, now);
  const streams = {stdout: out.stream, stderr: err.stream, stdin: emptyInput()};

  // Node's worker answers the main thread's acknowledgement of a write it
  // made before this ran by calling process[stream][kStdioWantsMoreDataCallback]():
  // each module stream answers it for its original, which it never exposes.
  for (const k of ['stdout', 'stderr', 'stdin']) {
    let proto = Object.getPrototypeOf(originals[k]);
    let key = null;
    for (; proto != null && key == null; proto = Object.getPrototypeOf(proto)) {
      key = Object.getOwnPropertySymbols(proto).find((s) => s.description === 'kStdioWantsMoreDataCallback') || null;
    }
    if (key != null) {
      const original = originals[k];
      Object.defineProperty(streams[k], key, {value: () => original[key](), writable: false, configurable: false, enumerable: false});
    }
  }

  for (const k of ['stdout', 'stderr', 'stdin']) {
    Object.defineProperty(process, k, {get: () => streams[k], configurable: false, enumerable: true});
  }
  // console caches the stream it first wrote to (its _stdout and _stderr):
  // pointed at the module streams, for good.
  Object.defineProperty(console, '_stdout', {get: () => streams.stdout, configurable: false, enumerable: false});
  Object.defineProperty(console, '_stderr', {get: () => streams.stderr, configurable: false, enumerable: false});
  // _rawDebug writes to the process's stderr directly, past every cap.
  Object.defineProperty(process, '_rawDebug', {value: (...args) => { streams.stderr.write(`${args.map(String).join(' ')}\n`); },
    writable: false, configurable: false, enumerable: false});

  // What is left, an unfinished line included, goes before each of the
  // runtime's replies (a worker the main thread ends after its reply never
  // runs its exit handlers) and when the worker ends; a drop count within
  // DROP_REPORT_MS, or at the next look at the window.
  const flushAll = () => { out.end(); err.end(); };
  WorkerMessage.addBeforeReply(flushAll);
  process.on('exit', flushAll);
  const timer = setInterval(() => { out.roll(); err.roll(); }, ROLL_EVERY_MS);
  timer.unref();
  return {stdout: out.stream, stderr: err.stream};
}

module.exports = {installModuleStdio};
